import { Cron } from "croner";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const Timestamp = Type.Number({ minimum: 0, maximum: 8.64e15 });
const TimingSchema = Type.Union([
  Type.Object({ kind: Type.Literal("interval"), milliseconds: Type.Number({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }),
  Type.Object({ kind: Type.Literal("once"), at: Timestamp }),
  Type.Object({ kind: Type.Literal("cron"), expression: Type.String(), timezone: Type.Optional(Type.String()) }),
]);
const PhaseSchema = Type.Union([
  Type.Object({ kind: Type.Literal("idle") }),
  Type.Object({ kind: Type.Literal("pending"), since: Timestamp }),
  Type.Object({ kind: Type.Literal("active"), startedAt: Timestamp }),
  Type.Object({ kind: Type.Literal("uncertain"), startedAt: Timestamp, reason: Type.String() }),
]);
export const JobSchema = Type.Object({
  id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$" }),
  name: Type.Optional(Type.String({ minLength: 1 })),
  prompt: Type.String({ minLength: 1 }),
  timing: TimingSchema,
  nextAt: Type.Union([Timestamp, Type.Null()]),
  enabled: Type.Boolean(),
  phase: PhaseSchema,
  lastRun: Type.Optional(Type.Object({ startedAt: Timestamp, endedAt: Timestamp, aborted: Type.Boolean() })),
});
export const SnapshotSchema = Type.Object({ version: Type.Literal(1), paused: Type.Boolean(), jobs: Type.Array(JobSchema) });
export type Job = Static<typeof JobSchema>;
export type Timing = Job["timing"];
export type Snapshot = Static<typeof SnapshotSchema>;
export type Action = "set" | "list" | "remove" | "pause" | "resume" | "run";
export interface Request { action: Action; id?: string; name?: string; schedule?: string; prompt?: string; timezone?: string }

function cron(timing: Extract<Timing, { kind: "cron" }>): Cron {
  return new Cron(timing.expression, { timezone: timing.timezone, paused: true });
}

export class ScheduleError extends Error {
  readonly field: "schedule" | "timezone";
  constructor(field: "schedule" | "timezone", message: string) {
    super(message);
    this.name = "ScheduleError";
    this.field = field;
  }
}

export function parseSchedule(schedule: string, now: number, timezone?: string, expected?: Timing["kind"]): Timing {
  if (timezone) {
    try { new Intl.DateTimeFormat("en", { timeZone: timezone }); }
    catch { throw new ScheduleError("timezone", "Timezone: enter a valid IANA name, such as America/New_York, or leave it blank for local time."); }
  }
  try {
    const timing = parseTiming(schedule, now, timezone);
    if (expected && timing.kind !== expected) throw new Error("Schedule does not match the selected kind");
    return timing;
  } catch (error) {
    const message = expected === "cron" ? "Cron: enter a valid five- or six-field cron expression." : expected === "interval" ? "Repeat amount: enter a positive number without a + sign or units." : expected === "once" ? "Once: enter a valid positive amount or date and time." : String(error instanceof Error ? error.message : error);
    throw new ScheduleError("schedule", message);
  }
}

function parseTiming(schedule: string, now: number, timezone?: string): Timing {
  const text = schedule.trim();
  const duration = /^(\+)?(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(text);
  if (duration) {
    if (timezone) throw new Error("Timezone is only valid for cron");
    const units: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
    const milliseconds = Number(duration[2]) * units[duration[3]];
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || now + milliseconds > 8.64e15) throw new Error("Invalid duration");
    return duration[1] ? { kind: "once", at: now + milliseconds } : { kind: "interval", milliseconds };
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    if (timezone) throw new Error("Timezone is only valid for cron");
    const at = Date.parse(text);
    // Date.parse normalizes impossible dates such as February 30.
    const day = Number(text.slice(8, 10));
    const month = Number(text.slice(5, 7));
    const days = new Date(Date.UTC(Number(text.slice(0, 4)), month, 0)).getUTCDate();
    if (!Number.isFinite(at) || at < 0 || day < 1 || day > days) throw new Error("Invalid timestamp");
    return { kind: "once", at };
  }
  if (![5, 6].includes(text.split(/\s+/).length)) throw new Error("Use a duration, +duration, ISO timestamp with offset, or five-/six-field cron");
  const timing: Timing = { kind: "cron", expression: text, ...(timezone ? { timezone } : {}) };
  cron(timing);
  return timing;
}

function next(timing: Timing, now: number): number | null {
  if (timing.kind === "once") return timing.at;
  if (timing.kind === "interval") return now + timing.milliseconds;
  return cron(timing).nextRun(new Date(now))?.getTime() ?? null;
}

export class Scheduler {
  state: Snapshot = { version: 1, paused: false, jobs: [] };

  restore(value: unknown): void {
    if (!Check(SnapshotSchema, value)) throw new Error("Invalid spur snapshot");
    if (new Set(value.jobs.map((job) => job.id)).size !== value.jobs.length) throw new Error("Duplicate spur IDs in snapshot");
    if (value.jobs.filter((job) => job.phase.kind === "active").length > 1) throw new Error("Multiple active jobs in snapshot");
    for (const job of value.jobs) if (job.timing.kind === "cron") parseSchedule(job.timing.expression, 0, job.timing.timezone);
    this.state = structuredClone(value);
    for (const job of this.state.jobs) {
      if (job.phase.kind === "active") job.phase = { kind: "uncertain", startedAt: job.phase.startedAt, reason: "Recovered active run; effects may already have occurred. Use run to acknowledge rerun risk." };
    }
  }

  apply(request: Request, now: number): void {
    const { action, id } = request;
    if (action === "list") return;
    if ((action === "pause" || action === "resume") && id === undefined) {
      this.state.paused = action === "pause";
      return;
    }
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id)) throw new Error("A stable ID of 1-64 letters, digits, dots, underscores, or hyphens is required");
    const job = this.state.jobs.find((item) => item.id === id);
    if (action === "set") {
      if (!request.prompt?.trim()) throw new Error("set requires prompt");
      if (!job && request.schedule === undefined) throw new Error("Creating a job requires schedule");
      if (request.schedule === undefined && request.timezone !== undefined) throw new Error("Changing timezone requires schedule");
      const timing = request.schedule === undefined ? undefined : parseSchedule(request.schedule, now, request.timezone);
      const nextAt = timing ? next(timing, now) : undefined;
      if (timing?.kind === "cron" && nextAt === null) throw new ScheduleError("schedule", "Cron: this expression has no future occurrence.");
      const schedule = timing ? { timing, nextAt } : {};
      if (request.name !== undefined && !request.name.trim()) throw new Error("Name must not be blank");
      const name = request.name === undefined ? {} : { name: request.name.trim() };
      if (job) Object.assign(job, { ...name, prompt: request.prompt, ...schedule });
      else this.state.jobs.push({ id, ...name, prompt: request.prompt, timing: timing!, nextAt: schedule.nextAt!, enabled: true, phase: { kind: "idle" } });
      return;
    }
    if (!job) throw new Error(`Unknown spur job: ${id}`);
    switch (action) {
      case "remove": this.state.jobs.splice(this.state.jobs.indexOf(job), 1); break;
      case "pause": job.enabled = false; break;
      case "resume": job.enabled = true; break;
      case "run":
        if (job.phase.kind === "idle" || job.phase.kind === "uncertain") job.phase = { kind: "pending", since: now };
        break;
    }
  }

  private advance(job: Job, now: number): boolean {
    if (job.nextAt === null || job.nextAt > now) return false;
    if (job.timing.kind === "once") job.nextAt = null;
    else if (job.timing.kind === "cron") job.nextAt = next(job.timing, now);
    else job.nextAt += (Math.floor((now - job.nextAt) / job.timing.milliseconds) + 1) * job.timing.milliseconds;
    return true;
  }

  tick(now: number): boolean {
    let changed = false;
    for (const job of this.state.jobs) {
      if (!job.enabled) continue;
      const dueAt = job.nextAt;
      if (this.advance(job, now)) {
        changed = true;
        if (job.phase.kind === "idle") job.phase = { kind: "pending", since: dueAt! };
      }
    }
    return changed;
  }

  admit(now: number): Job | undefined {
    if (this.state.paused || this.state.jobs.some((job) => job.phase.kind === "active")) return;
    let first: Job | undefined;
    for (const job of this.state.jobs) {
      if (job.phase.kind !== "pending" || !job.enabled) continue;
      if (!first || (first.phase.kind === "pending" && job.phase.since < first.phase.since)) first = job;
    }
    if (first) first.phase = { kind: "active", startedAt: now };
    return first;
  }

  settle(now: number, aborted: boolean): void {
    let hadActive = false;
    for (const job of this.state.jobs) {
      if (job.phase.kind !== "active") continue;
      hadActive = true;
      this.advance(job, now);
      job.lastRun = { startedAt: job.phase.startedAt, endedAt: now, aborted };
      job.phase = { kind: "idle" };
    }
    if (aborted && hadActive) this.state.paused = true;
  }

  orphan(): boolean {
    let changed = false;
    for (const job of this.state.jobs) if (job.phase.kind === "active") {
      job.phase = { kind: "uncertain", startedAt: job.phase.startedAt, reason: "Pi became idle without settlement; admission may have failed. Use run to acknowledge rerun risk." };
      changed = true;
    }
    return changed;
  }
}

const units = [
  { label: "Minutes", suffix: "m", milliseconds: 60000 },
  { label: "Hours", suffix: "h", milliseconds: 3600000 },
  { label: "Seconds", suffix: "s", milliseconds: 1000 },
  { label: "Days", suffix: "d", milliseconds: 86400000 },
  { label: "Weeks", suffix: "w", milliseconds: 604800000 },
  { label: "Milliseconds", suffix: "ms", milliseconds: 1 },
];
function durationUnit(milliseconds: number) {
  let best = units[units.length - 1];
  for (const unit of units) if (milliseconds % unit.milliseconds === 0 && unit.milliseconds > best.milliseconds) best = unit;
  return best;
}
function timingLabel(timing: Timing): string {
  if (timing.kind === "once") return `Once at ${new Date(timing.at).toLocaleString()}`;
  if (timing.kind === "cron") return `Cron ${timing.expression}${timing.timezone ? ` · ${timing.timezone}` : ""}`;
  const unit = durationUnit(timing.milliseconds);
  return `Every ${timing.milliseconds / unit.milliseconds} ${unit.label.toLowerCase()}`;
}
export function scheduleLabel(job: Job): string { return timingLabel(job.timing); }
