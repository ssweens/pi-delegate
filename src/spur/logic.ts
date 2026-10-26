import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { Scheduler, type Request, scheduleLabel } from "./scheduler.ts";
import { ConversationStorage } from "./storage.ts";
import type { ActivityCoordinator } from "../ui/activity.ts";

export const SNAPSHOT_TYPE = "pi-spur:snapshot";
export const PROMPT_TYPE = "pi-spur:prompt";
const actions = ["set", "list", "remove", "pause", "resume", "run"] as const;
const Parameters = Type.Object({
  action: Type.Union(actions.map((action) => Type.Literal(action)), { description: "set upserts; list inspects; remove deletes a record; pause/resume control admission; run requests one coalesced occurrence, not a pause override." }),
  id: Type.Optional(Type.String({ description: "Stable ID: 1-64 characters, alphanumeric first, then alphanumeric, dot, underscore, or hyphen. Required for set/remove/run. For pause/resume, include id for one job; omit it for global admission. Inspect and reuse existing IDs." })),
  name: Type.Optional(Type.String({ description: "Optional nonblank display name; not the stable identity. Omit on updates to retain the name." })),
  schedule: Type.Optional(Type.String({ description: "Required for new set; omit on existing set to preserve exact timing/next deadline. Repeating durations are intervals from creation: every 20 minutes means 20m. Use cron only for calendar or wall-clock anchors. +5m runs once. Units: ms/s/m/h/d/w. Absolute ISO requires Z or offset. Cron accepts five or six fields and must have a future occurrence. Rescheduling an active job preserves its outstanding run; due fires during it can be absorbed." })),
  prompt: Type.Optional(Type.String({ description: "Nonblank prompt required for EVERY set, including updates. Describe work for a normal model turn, optionally requesting codemode/delegate or other available tools; this is not a deterministic tool-call payload." })),
  timezone: Type.Optional(Type.String({ description: "IANA timezone, e.g. America/New_York, for cron only; otherwise local time. To change it, also supply the cron schedule. Omit both schedule and timezone to preserve an existing deadline." })),
});

export function installSpur(pi: ExtensionAPI, activity: any): void {
  let scheduler = new Scheduler();
  let context: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let generation = 0;
  let storage: ConversationStorage | undefined;
  let storageError: string | undefined;
  let agentRunning = false;
  let reservation: { generation: number; phase: "admitting" | "started" } | undefined;

  const describe = (): string => {
    const lines = [`Spur admission: ${scheduler.state.paused ? "paused" : "enabled"}`];
    for (const job of scheduler.state.jobs) {
      lines.push(`${job.id}: ${job.enabled ? "enabled" : "paused"}, ${job.phase.kind}, next ${job.nextAt === null ? "none" : new Date(job.nextAt).toISOString()}`);
      lines.push(`  ${job.name ?? job.id} · ${scheduleLabel(job)}`, `  prompt: ${job.prompt}`);
      if (job.lastRun) lines.push(`  last run: ${new Date(job.lastRun.startedAt).toISOString()} to ${new Date(job.lastRun.endedAt).toISOString()}${job.lastRun.aborted ? " (aborted)" : ""}`);
      if (job.phase.kind === "uncertain") lines.push(`  ${job.phase.reason}`);
    }
    if (!scheduler.state.jobs.length) lines.push("No jobs. Use the spur tool or check the Activity widget.");
    return lines.join("\n");
  };
  const save = (): void => {
    if (storageError) throw new Error(storageError);
    const nativeFile = context?.sessionManager.getSessionFile();
    const native = !!nativeFile && existsSync(nativeFile);
    if (!native) storage?.save(scheduler.state, false);
    pi.appendEntry(SNAPSHOT_TYPE, structuredClone(scheduler.state));
    if (native) storage?.save(scheduler.state, true);
    // activity updated in dispatch/settle
    updateActivity();
  };
  function updateActivity() {
    if (!activity) return;
    activity.setSpurJobs(scheduler.state.jobs);
  }
  const notify = (text: string, type: "info" | "warning" | "error" = "info"): void => context?.ui.notify(text, type);
  const stop = (): void => {
    generation++;
    if (timer) clearInterval(timer);
    timer = undefined;
    context = undefined;
    reservation = undefined;
    agentRunning = false;
    storage?.close();
    storage = undefined;
  };
  const dispatch = (epoch: number): void => {
    if (epoch !== generation || !context) return;
    try {
      const now = Date.now();
      let changed = scheduler.tick(now);
      if (reservation?.phase === "admitting" && context.isIdle()) {
        changed = scheduler.orphan() || changed;
        reservation = undefined;
        notify("Spur admission did not settle. Inspect Activity widget or use spur tool for uncertain jobs.", "warning");
      }
      if (changed) save();
      if (agentRunning || !context.isIdle() || context.hasPendingMessages() || reservation !== undefined) return;
      const job = scheduler.admit(now);
      if (!job) return;
      reservation = { generation: epoch, phase: "admitting" };
      save();
      pi.sendMessage({
        customType: PROMPT_TYPE,
        content: `[spur job ${job.id}]\n${job.prompt}`,
        display: true,
        details: { id: job.id, startedAt: now },
      }, { triggerTurn: true });
    } catch (error) {
      scheduler.state.paused = true;
      notify(`Spur paused: ${String(error)}`, "error");
      if (timer) clearInterval(timer);
      timer = undefined;
    }
  };
  const restore = (ctx: ExtensionContext, tree = false): void => {
    stop();
    context = ctx;
    scheduler = new Scheduler();
    storageError = undefined;
    const branch = ctx.sessionManager.getBranch();
    try {
      storage = new ConversationStorage({ sessionId: ctx.sessionManager.getSessionId(), nativeFile: ctx.sessionManager.getSessionFile(), cwd: ctx.sessionManager.getCwd(), sessionDir: ctx.sessionManager.getSessionDir() });
      let snapshotFound = false;
      for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        if (entry.type !== "custom" || entry.customType !== SNAPSHOT_TYPE) continue;
        scheduler.restore(entry.data);
        snapshotFound = true;
        break;
      }
      if (!snapshotFound && !tree) {
        const snapshot = storage.loadPrechat();
        if (snapshot) {
          scheduler.restore(snapshot);
          pi.appendEntry(SNAPSHOT_TYPE, structuredClone(scheduler.state));
        }
      }
      const nativeFile = ctx.sessionManager.getSessionFile();
      if (nativeFile && existsSync(nativeFile)) storage.markNative();
    } catch (error) {
      storageError = String(error);
      scheduler.state.paused = true;
      notify(`Spur cannot restore its newest snapshot: ${String(error)}`, "error");
      return;
    }
    if (scheduler.state.jobs.some((job) => job.phase.kind === "uncertain")) notify("Spur recovered uncertain work. Use spur tool; Run now asks you to acknowledge rerun risk.", "warning");
    const epoch = generation;
    timer = setInterval(() => dispatch(epoch), 250);
    timer.unref();
  };
  const manage = (request: Request): string => {
    if (!context) throw new Error("Spur session is not ready");
    const previous = structuredClone(scheduler.state);
    try {
      scheduler.apply(request, Date.now());
      if (request.action !== "list") save();
    } catch (error) { scheduler.state = previous; throw error; }
    return describe();
  };

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx, true));
  pi.on("message_end", () => {
    const nativeFile = context?.sessionManager.getSessionFile();
    if (nativeFile && existsSync(nativeFile)) {
      try { storage?.markNative(); } catch (error) { storageError = String(error); notify(storageError, "error"); }
    }
  });
  pi.on("session_shutdown", () => {
    try { if (context && !storageError) save(); }
    finally { stop(); }
  });
  pi.on("agent_start", () => {
    agentRunning = true;
    if (reservation?.generation === generation) reservation.phase = "started";
  });
  pi.on("agent_settled", (event) => {
    if (!context) { agentRunning = false; return; }
    try {
      const isOurTurn = reservation?.generation === generation;
      const ev = event as any;
      const abortingOurActive = ev.aborted && scheduler.state.jobs.some((j) => j.phase.kind === "active");
      if (isOurTurn || abortingOurActive) {
        scheduler.settle(Date.now(), ev.aborted);
        reservation = undefined;
        try { save(); }
        catch (error) { storageError = String(error); scheduler.state.paused = true; notify(storageError, "error"); }
        if (ev.aborted) notify("Spur admission paused after abort. Use spur tool in Activity or check widget to resume.", "warning");
      }
    } finally { agentRunning = false; }
  });
  pi.registerTool({
    name: "spur",
    label: "Spur",
    description: `Conversation-only prompt automation, schedules, wake-up checks, heartbeat checks, and reminders while Pi stays open. Exactly six actions: set (create/update by stable id; prompt always required, schedule required for creation), list (inspect jobs and pause/phase state), remove (delete record only), pause (disable global admission without id, or one job with id), resume (enable the same scope), run (one coalesced occurrence; does not enable a paused job or resume global admission). Pause/remove do not cancel active work.
Examples:
- Inspect: {"action":"list"}
- Interval heartbeat (every 20 minutes): {"action":"set","id":"heartbeat","schedule":"20m","prompt":"Check status; report changes."}
- One wake-up: {"action":"set","id":"wake-up","schedule":"+5m","prompt":"Check whether the build finished."}
- Edit without rescheduling: {"action":"set","id":"heartbeat","prompt":"Check status using codemode; report changes."}
Other schedules: "2027-06-01T09:00:00-04:00" (once), "0 9 * * 1-5" (five-field cron), "*/10 * * * * *" (six-field cron); cron may include "timezone":"America/New_York". These are uses of one prompt scheduler, not separate engines, a daemon, or deterministic tool execution.`,
    promptSnippet: "Conversation-only automation, schedules, wake-up prompts, heartbeat checks, and reminders while Pi stays open.",
    promptGuidelines: [
      "For spur changes, list/inspect existing jobs first and reuse the stable ID (set is an upsert), rather than creating duplicates. Every set requires prompt; a new job also requires schedule. Omit schedule and timezone on updates that must preserve the exact deadline. For an unanchored repeat or heartbeat, prefer a duration interval: every 20 minutes means 20m, not cron. Use cron when the user specifies calendar or wall-clock times.",
      "Use the same spur ID for adaptive wake-ups by supplying a new schedule and prompt. There is no separate dynamic wake-up API. Updating an active job preserves its outstanding run; a replacement deadline reached while it remains active may be absorbed.",
      "Spur pause/resume without id controls global admission; with id it controls one job. Neither pause nor remove cancels active work. run coalesces and does not enable a paused job or resume global admission. Running once while preserving a paused state is unsupported: explain that, do not enqueue run to pretend the request was honored, and never silently unpause unrelated jobs or resume after Escape.",
      "Spur absorbs repeated fires while pending/active, including delayed timers; missed idle occurrences after delays or reopening recover once, without a backlog. A successful set/run response is not proof that the scheduled prompt has executed.",
      "For an uncertain spur run, use run only after the user explicitly accepts possible duplicate effects. Never automatically retry uncertain work, and never create a clone ID to evade uncertainty. Inspect first; remove deletes only the record.",
      "Spur belongs to this conversation/branch and requires Pi to remain open; it is not an external daemon. Scheduled prompts use normal model/tool execution and permissions, including available codemode/delegate tools. Coalescing ends when the scheduled parent prompt settles, not when detached children finish: check for an existing child before launching another.",
    ],
    parameters: Parameters,
    async execute(_id, params) {
      const text = manage(params);
      return { content: [{ type: "text", text }], details: structuredClone(scheduler.state) };
    },
  });
  pi.registerCommand("spur", {
    description: "Spur jobs are now in the Activity widget (no separate menu)",
    async handler(_args, ctx) {
      if (ctx.mode !== "tui") { ctx.ui.notify("Use the spur tool to manage scheduled prompts.", "error"); return; }
      ctx.ui.notify("Spur scheduled jobs appear in the Activity widget above the editor. Use the 'spur' tool (set/list/pause/resume/run) to manage.", "info");
    },
  });
}
