/** Path runs in oven (its slice follows this session); the lead shows its state, sends the user's requests and adds its hints. */
import { copyToClipboard, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { MomClient, TRAIL_STANDING, type Command, type SourcePage, type TrailOptions } from "./client.ts";
import { pathRows } from "./settings.ts";
import { SettingsPanel } from "../ui/settings-panel.ts";
import { FULLSCREEN } from "../ui/overlay.ts";
import { chordLabel } from "../ui/hints.ts";
import { ANCHOR } from "./anchor.ts";
import type { FindingRequest } from "./operation.ts";
import { COMPACT_KEY, FOCUS_KEY, MomView, momToolPreview, type PanelDiagnostics, type PanelView } from "../ui/panel.ts";
import { activityFor } from "../ui/activity.ts";
import { formatUsage, updateErrorSummary, WAITING_FOR_VIEW } from "./status.ts";
import { presentGraph, readText, summaryText } from "../ui/presentation.ts";
import { DEFAULT_MODE, modeNames } from "./modes.ts";
import { momDeciderSelector, momModelSelector } from "./model-picker.ts";
import { MomRebuildPanel } from "../ui/mom-rebuild.ts";
import type { RebuiltMap } from "./rebuild.ts";
import { formatDuration } from "../util/format.ts";
import { errorMessage, textOf } from "../util/text.ts";
import { isPiStringsWorkerProcess } from "../util/process.ts";

const FLAGS = {
	"mom-model": ["Exact provider/model for Path; never inherits the lead model", "openai-codex/gpt-5.6-sol"],
	"mom-mode": [`Map-maintenance mode (${modeNames().join(", ")}); see docs/map-modes.md`, DEFAULT_MODE],
	"mom-interval-ms": ["Minimum spacing between background Path updates in milliseconds", "0"],
	"mom-max-wait-ms": ["Longest Path waits for a turn to end before updating anyway, in milliseconds", "1800000"],
	"mom-user-window-ms": ["Path updates when an assistant turn ends, and when a user message arrives sent within this many milliseconds (a live message, not history)", "120000"],
	"mom-retry-ms": ["Automatic retry delays after a failed update, comma-separated milliseconds", "5000,60000,300000"],
	"mom-advisor-url": ["Optional System One endpoint. Empty disables it", ""],
	"mom-decider": ["Pi classifier model (local System One) for Path's decisions: the v2 change check before its model reads a batch. Required: with none, every update fails until one is set.", ""],
	"mom-decider-url": ["Local decider (System One, decider/serve.py) for continuity checks and state-change shadowing. Empty disables it", ""],
	"mom-decider-clear": ["The decider skips a continuity model check when it is at least this sure the turn continues", "0.9"],
	"mom-advisor-model": ["Native System One model ID", "beverly-4B"],
	"mom-advisor-threshold": ["Below this probability routine mid-run work may wait up to one minute", "0.25"],
	"mom-advisor-timeout-ms": ["Screening timeout in milliseconds", "1500"],
	"mom-bootstrap": ["Compress the whole cold backlog before reconciling", "1"],
	"mom-bootstrap-chapters": ["Target chapters per cold-catch-up digest batch", "24"],
	"mom-bootstrap-chars": ["Maximum characters of cold-catch-up compression sent in one proposal", "48000"],
};

/** Resolve one flag from its `path-*` and deprecated `mom-*` registrations: a `path-*` value that differs from the default wins. */
export function resolveFlag(name: keyof typeof FLAGS, get: (key: string) => unknown): unknown {
	const fallback = FLAGS[name][1], path = get(name.replace(/^mom-/, "path-"));
	return path !== undefined && path !== fallback ? path : get(name) ?? fallback;
}

const installedIn = new WeakMap<object, () => string | undefined>();

export function installMom(pi: ExtensionAPI) {
	const installed = installedIn.get(pi);
	if (installed) return installed;
	if (isPiStringsWorkerProcess()) return;
	// `--path-*` are the documented flags; `--mom-*` keep working as deprecated aliases (internal keys stay `mom-*`).
	for (const [name, [description, value]] of Object.entries(FLAGS)) {
		pi.registerFlag(name.replace(/^mom-/, "path-"), { description, type: "string", default: value });
		pi.registerFlag(name, { description: `Deprecated alias of --${name.replace(/^mom-/, "path-")}. ${description}`, type: "string", default: value });
	}
	/** A flag's value: the `path-*` one when it differs from its default, else the deprecated `mom-*` one. */
	const flag = (name: keyof typeof FLAGS) => resolveFlag(name, key => pi.getFlag(key));
	let ctx: ExtensionContext | undefined, client: MomClient | undefined;
	const recapAnchor = () => client?.recapAnchor();
	installedIn.set(pi, recapAnchor);
	let ready: Promise<void> = Promise.resolve(), epoch = 0, readError: string | undefined;
	let widgetSignature: string | undefined;
	let heldWidget: PanelView | undefined;
	let viewOpen = false, closeView: (() => void) | undefined, momView: MomView | undefined;
	let rebuilding: { owner: MomClient; abort: AbortController; message: string; sliceUrl?: string; candidate?: RebuiltMap; error?: string } | undefined;
	const sentAnchors = new Set<string>(), sentStandings = new Set<string>();
	const activity = activityFor(pi);
	const toggleCompact = () => { activity.toggleCompact(); sync(); };
	function view(explicit = false, elapsed = true): PanelView {
		const error = client?.error ?? readError;
		const saved: PanelView = client?.state ? client.view(explicit, elapsed) : {
			status: client?.error ? "reconnecting" : error && !client ? "needs you" : "connecting", summary: WAITING_FOR_VIEW,
		};
		const shown = client?.error ?? (explicit || !client ? readError : undefined);
		const rebuild = rebuilding?.owner === client ? rebuilding : undefined;
		const rebuildStatus = rebuild?.candidate ? "Rebuild ready · B on F3 Status to review" : rebuild?.error
			? `Rebuild failed · ${updateErrorSummary(rebuild.error)} · B on F3 Status to retry` : rebuild?.message;
		return { ...saved, compact: activity.isCompact(), ...(shown ? { error: updateErrorSummary(shown) } : {}),
			...(rebuildStatus ? { rebuild: rebuildStatus, rebuildUrl: !rebuild?.candidate && !rebuild?.error ? rebuild?.sliceUrl : undefined } : {}),
			status: client?.error ? "reconnecting" : saved.status };
	}
	function sync() {
		momView?.statusChanged();
		const signature = JSON.stringify(view(false, false));
		if (signature === widgetSignature) return;
		widgetSignature = signature;
		activity.setMom(() => {
			const live = view(false, false);
			return heldWidget ? { ...heldWidget, status: live.status, error: live.error, compact: live.compact,
				rebuild: live.rebuild, rebuildUrl: live.rebuildUrl, sliceUrl: live.sliceUrl } : live;
		});
	}
	function cached(): string {
		const v = view(true), u = client?.snapshot?.usage;
		return `${v.summary || "Path has not saved a view of this work yet."}\n\n${v.status}${v.sliceUrl ? `\nSlice: ${v.sliceUrl}` : ""}${v.rebuild ? `\n${v.rebuild}` : ""}${v.rebuildUrl ? `\nRebuild slice: ${v.rebuildUrl}` : ""}${v.error ? `\n${v.error}` : ""}${v.note ? `\n\nNotice: ${v.note}` : ""}${u ? `\n\n${formatUsage(u)}` : ""}`;
	}
	function failure(error: unknown) { readError = String(error); sync(); }
	function reset(context: ExtensionContext) {
		rebuilding?.abort.abort(new Error("Path session changed.")); rebuilding = undefined;
		const token = ++epoch; client?.close(); client = undefined; ctx = context; readError = undefined;
		widgetSignature = undefined; sentAnchors.clear(); sentStandings.clear();
		const flags = Object.fromEntries(Object.keys(FLAGS).map(name => [name, flag(name as keyof typeof FLAGS)])) as Record<string, string | boolean | undefined>;
		let connection: MomClient;
		try {
			connection = new MomClient(context, { flags, changed: () => { if (epoch === token) sync(); },
				publish: message => { if (epoch === token) pi.sendMessage({ display: false, ...message }, { triggerTurn: false }); },
				notify: (text, level) => { if (epoch === token) ctx?.ui.notify(text, level); } });
		} catch (error) { failure(error); return; }
		client = connection;
		ready = connection.connect().catch(error => { if (epoch === token) failure(error); });
		sync();
	}
	function updateContext(context: ExtensionContext) { ctx = context; client?.updateContext(context); }
	async function request(command: Command, signal?: AbortSignal): Promise<unknown> {
		const token = epoch; await ready;
		if (token !== epoch || !client) throw new Error(readError ?? "Path session changed or is unavailable.");
		return client.request(command, signal);
	}
	/**
	 * A command that starts a run says so at once (or what it waits behind), and says how the run ended:
	 * the widget's spinner is the only other sign, and a run can take minutes.
	 */
	async function act(context: ExtensionContext, label: string, command: Command, ended: (added: number) => string): Promise<void> {
		await ready;
		const snapshot = client?.snapshot, before = snapshot?.passive.trail?.count ?? 0;
		const current = snapshot?.startedAt === undefined ? undefined : `${snapshot.passive.trail?.task ?? "updating"}, ${formatDuration(Date.now() - snapshot.startedAt)} in`;
		context.ui.notify(current ? `Path: ${label} — queued behind the run in progress (${current}).` : `Path: ${label}…`, "info");
		await request(command);
		const done = outcome(before, ended);
		if (done.error) context.ui.notify(`Path: ${label} failed: ${done.error} Open /path for the full error.`, "error");
		else context.ui.notify(`Path: ${done.text}`, "info");
	}
	/** How a run ended: its error, or what it added to the trail since `before`. */
	function outcome(before: number, ended: (added: number) => string): { error?: string; text: string } {
		const failed = client?.runError;
		return failed ? { error: updateErrorSummary(failed), text: "" } : { text: ended((client?.snapshot?.passive.trail?.count ?? before) - before) };
	}
	const added = (count: number) => count > 0 ? `${count} new entr${count === 1 ? "y" : "ies"} on the trail` : "nothing new for the trail";
	const refreshed = (count: number) => client?.snapshot?.passive.trail ? `refreshed — ${added(count)}.` : "caught up.";
	async function findingAction(action: FindingRequest, finding: string) { await request({ kind: "finding", action, finding }); }
	pi.on("session_start", (_event, context) => reset(context));
	// A new branch: its work on the old one is stopped in oven, and it follows the selected branch.
	pi.on("session_tree", (_event, context) => { void client?.halt(); reset(context); });
	// A reload keeps the session, so its slice stays; any other end retires this session's own Path slice.
	pi.on("session_shutdown", async (event) => { rebuilding?.abort.abort(new Error("Path session ended.")); rebuilding = undefined;
		const ended = client; epoch++; client = undefined; activity.clearMom(); ctx = undefined;
		if (event.reason === "reload") ended?.close(); else await ended?.end(); });
	// Its hints: the continuity anchor it prepared after a compaction goes into the lead's context once, and in
	// trail mode its standing (where we are) follows whenever it changed since the last one sent.
	pi.on("before_agent_start", (started, context) => {
		updateContext(context);
		const anchor = client?.pendingAnchor();
		if (anchor && !sentAnchors.has(anchor.key)) {
			sentAnchors.add(anchor.key);
			pi.sendMessage({ customType: ANCHOR, content: anchor.content, display: false, details: { key: anchor.key } }, { triggerTurn: false });
		}
		const standing = client?.standingForLead();
		if (standing && !sentStandings.has(standing.key)) {
			sentStandings.add(standing.key);
			pi.sendMessage({ customType: TRAIL_STANDING, content: standing.content, display: false, details: { key: standing.key } }, { triggerTurn: false });
		}
		delete started.systemPromptOptions.sections.mom_lead_behavior;
	});
	pi.on("agent_settled", (_event, context) => { updateContext(context); void client?.reload(); });
	function diagnostics(): PanelDiagnostics {
		const saved = client?.snapshot?.diagnostics ?? { sections: [], raw: "{}" }, error = client?.error ?? readError;
		return error ? { ...saved, sections: [...saved.sections, { title: "Last problem", text: updateErrorSummary(error) }] } : saved;
	}
	async function open(context: ExtensionContext) {
		if (context.mode !== "tui") {
			const error = view(true).error;
			context.ui.notify(`${error ? `What happened: ${error}\n\n` : ""}${cached()}`, "info"); return;
		}
		if (viewOpen) closeView?.();
		viewOpen = true; const held = heldWidget = structuredClone(view(false, false));
		try {
			await context.ui.custom<void>((tui, theme, _keys, done) => { closeView = () => done(); return momView = new MomView({
				view: () => view(true, false), trail: () => client?.trail, findingAction, copy: copyToClipboard, diagnostics,
				refresh: async () => { const before = client?.snapshot?.passive.trail?.count ?? 0; await request({ kind: "refresh" });
					const done = outcome(before, refreshed); if (done.error) throw new Error(done.error); return `${done.text[0]!.toUpperCase()}${done.text.slice(1)}`; },
				settings: finished => settingsPanel(context, tui, finished),
				rebuild: () => { closeView?.(); void rebuild(context).catch(error => context.ui.notify(`Path rebuild failed: ${errorMessage(error)}`, "error")); },
				status: () => ({ connection: client?.error ? "disconnected" : client?.snapshot ? "connected" : "connecting", project: context.cwd,
					sliceUrl: client?.sliceUrl, host: client?.snapshot?.host, telemetry: client?.snapshot?.telemetry,
					usage: client?.snapshot?.usage, enabled: client?.snapshot?.controls.enabled }),
				refreshStatus: async () => { await request({ kind: "status" }); },
				readSource: async (ref, offset) => await request({ kind: "source", ref, offset }) as SourcePage,
				setEnabled: async enabled => { await request({ kind: "controls", change: { enabled } }); },
				draftForLead: text => { const draft = context.ui.getEditorText(); context.ui.setEditorText(`${draft}${draft ? "\n\n" : ""}${text}`); },
				prepareLeadDraft: async finding => { await findingAction("discuss", finding); const draft = context.ui.getEditorText();
					context.ui.setEditorText(`${draft}${draft ? "\n\n" : ""}Path suggested: ${finding}\nLet's discuss this before acting.`); },
			}, theme, tui, () => done()); },
			FULLSCREEN);
		} catch (error) { context.ui.notify(`Cannot open Path: ${String(error)}`, "error"); }
		finally { if (heldWidget === held) { momView = undefined; viewOpen = false; closeView = undefined; heldWidget = undefined; sync(); } }
	}
	/** Path's rows of the settings panel over its saved controls, read live; undefined until it is connected. /path
	 *  settings shows them alone; /delegate settings lists them with the package's other rows. */
	function settingsRows(context: ExtensionContext, tui: TUI) {
		if (!client?.snapshot?.controls) return undefined;
		const fallback = String(flag("mom-model"));
		return pathRows(() => client!.snapshot!.controls, async change => { await request({ kind: "controls", change }); },
			// The pickers are Path's alone: a pick never becomes Pi's default. Their `done(selected)` hands the pick
			// back to the row, which saves it once.
			(current, finished) => momModelSelector(context, tui, current, fallback, finished) as never,
			(current, finished) => momDeciderSelector(context, tui, current, finished) as never, fallback);
	}
	activity.setMomRows(settingsRows);
	async function rebuild(context: ExtensionContext) {
		if (context.mode !== "tui") throw new Error("Rebuild requires an interactive terminal.");
		await ready;
		const owner = client, sessionEpoch = epoch;
		if (!owner || !owner.snapshot) throw new Error(readError ?? "Path is not connected.");
		if (!rebuilding || rebuilding.owner !== owner || rebuilding.error) {
			const job = { owner, abort: new AbortController(), message: "Preparing a private copy of this session…" } as NonNullable<typeof rebuilding>;
			rebuilding = job;
			sync();
			void owner.rebuild((message, sliceUrl) => { if (rebuilding === job) { job.message = message; job.sliceUrl = sliceUrl; sync(); } }, job.abort.signal)
				.then(candidate => { if (rebuilding !== job || job.abort.signal.aborted) return;
					job.candidate = candidate; sync(); context.ui.notify("Path's rebuilt map is ready. B on F3 Status opens the review.", "info"); })
				.catch(error => { if (rebuilding !== job || job.abort.signal.aborted) return;
					job.error = errorMessage(error); sync();
					context.ui.notify(`Path's rebuild failed: ${job.error}`, "error"); });
			return;
		}
		if (!rebuilding.candidate) { context.ui.notify(`${rebuilding.message} · progress is in Path's widget.`, "info"); return; }
		const candidate = rebuilding.candidate;
		const result = await context.ui.custom<"saved" | "cancelled">((tui, theme, _keys, done) =>
			new MomRebuildPanel(tui, theme, () => Math.max(8, tui.terminal.rows - 6), candidate,
				async selected => {
					if (epoch !== sessionEpoch || client !== owner) throw new Error("The Path session changed; rebuild again on the selected branch.");
					await owner.acceptRebuild(selected);
				}, done, owner.state?.checkpoint?.graph.nodes.length ?? 0, owner.snapshot?.explicit.work),
			FULLSCREEN);
		if (rebuilding?.candidate === candidate) { rebuilding = undefined; sync(); }
		if (result === "saved") context.ui.notify("Path's rebuilt map is saved. Earlier checkpoints remain available.", "info");
	}
	/** Path's settings panel: /path settings shows it alone, and the view's F4 tab holds the same one. */
	function settingsPanel(context: ExtensionContext, tui: TUI, done: () => void): SettingsPanel | undefined {
		const rows = settingsRows(context, tui);
		return rows && new SettingsPanel("Path settings", rows, () => tui.requestRender(), done, Math.max(3, Math.min(12, tui.terminal.rows - 9)));
	}
	async function showSettings(context: ExtensionContext) {
		if (context.mode !== "tui") throw new Error("Path settings requires interactive mode.");
		await ready;
		if (!client?.snapshot?.controls) throw new Error(readError ?? "Path is not connected.");
		await context.ui.custom<void>((tui, _theme, _keys, done) => settingsPanel(context, tui, () => done())!);
	}
	pi.registerShortcut(FOCUS_KEY, { description: `Open Path's view (Esc or ${chordLabel(FOCUS_KEY)} returns)`, handler: open });
	pi.registerShortcut(COMPACT_KEY, { description: "Toggle the Activity widget between full and compact", handler: async context => { ctx = context; toggleCompact(); } });
	const TRAIL_DESCRIPTION = "Read Path's trail: where we are and the waypoints into the transcript. query finds where a line landed; before shows what we were doing before the last detour; open lists unfinished steps and questions; evolution shows how the goal changed.";
	pi.registerTool({ name: "path", label: "Path", description: "Read Path's saved story map, its trail, selected records, or original evidence without a model call. The widget already shows your current place; use this for more detail. Read-only: working agents never maintain Path's notes. Choose at most one of graph, source, trail.",
		parameters: Type.Object({ graph: Type.Optional(Type.Object({
				nodes: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 20, description: "IDs of endeavors or attached notes from a previous read. Omit to see the whole map." })),
				depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 3, description: "How much surrounding work to include (0–3, default 1). Even 0 explains the goal, your place in it, and what is outside the view." })),
				checkpoint: Type.Optional(Type.String({ description: "A saved-view ID from history or previousCheckpoint. Omit for the current view. Old records remain readable without reopening their work." })),
			}, { additionalProperties: false })),
			source: Type.Optional(Type.Object({ ref: Type.String({ minLength: 1 }), offset: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false })),
			trail: Type.Optional(Type.Object({
				line: Type.Optional(Type.String({ minLength: 1, description: "Only this line of the journey (case-insensitive substring of its name)." })),
				query: Type.Optional(Type.String({ minLength: 1, description: "Where did this land? Matches line names, then captions." })),
				before: Type.Optional(Type.Boolean({ description: "What we were doing before the last detour." })),
				open: Type.Optional(Type.Boolean({ description: "Unfinished steps and questions, grouped by line." })),
				evolution: Type.Optional(Type.Boolean({ description: "How the goal changed: set_out, then each reframed." })),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "How many of the latest waypoints to list (default 40)." })),
			}, { additionalProperties: false, description: TRAIL_DESCRIPTION })) }, { additionalProperties: false }),
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("Path")) + theme.fg("muted", ` · ${args.source ? "reading original evidence" : args.trail ? "reading the trail" : "finding our place"}`), 0, 0); },
		renderResult(result, _options, theme) {
			const text = textOf(result.content);
			const details = result.details;
			const overview = details && typeof details === "object" && "overview" in details && typeof details.overview === "string" ? details.overview : text;
			const preview = details && typeof details === "object" && "preview" in details && typeof details.preview === "string" ? details.preview : overview;
			const expandable = details && typeof details === "object" && "expandable" in details && details.expandable === true;
			return new Text(`${preview}${expandable ? `\n${theme.fg("dim", "Selected records and sources are available to the model, not displayed here.")}` : ""}`, 0, 0);
		},
		async execute(_id, args, signal) {
			if ([args.graph, args.source, args.trail].filter(Boolean).length > 1) throw new Error("Choose one of graph, source or trail.");
			try {
				await ready;
				let text: string, overview: string, preview: string, data: unknown, expandable = false;
				if (args.source) { data = await request({ kind: "source", ...args.source }, signal); overview = "Original recorded evidence, not new work or permission to act."; preview = overview; text = `${overview}\n\n${JSON.stringify(data, null, 2)}`; expandable = true; }
				else if (args.trail) { const read = await request({ kind: "trail", options: args.trail as TrailOptions }, signal) as { text: string; count: number }; data = read; text = read.text; overview = text; preview = momToolPreview(view(false, false), text); }
				else if (args.graph) { data = await request({ kind: "graph", options: args.graph }, signal); const work = presentGraph(data); overview = summaryText(work); const current = view(false, false); preview = momToolPreview({ ...current, work, summary: overview }); expandable = Boolean(args.graph.nodes?.length || args.graph.checkpoint); text = readText(work, expandable); }
				else { await request({ kind: "graph", options: {} }, signal); text = cached(); overview = text; preview = momToolPreview(view(true, false)); }
				return { content: [{ type: "text" as const, text }], details: { overview, preview, expandable, data, at: client?.snapshot?.explicit.work?.at } };
			} catch (error) {
				failure(error);
				throw new Error("Path couldn't read that saved view or source. Its last saved notes are unchanged. Use an ID from a previous Path read; open /path for the reason.");
			}
		},
	});
	const USAGE = "Use /path, /path on, /path off, /path refresh, or /path settings.";
	pi.registerCommand("path", { description: "Open Path · on · off · refresh · settings",
		handler: async (args, context) => {
			ctx = context;
			const commandEpoch = epoch;
			const [command, ...parts] = args.trim().split(/\s+/);
			try {
				if (!command) return await open(context);
				if (parts.length) throw new Error(USAGE);
				if (command === "settings") return await showSettings(context);
				if (command === "on" || command === "off") {
					await request({ kind: "controls", change: { enabled: command === "on" } });
					context.ui.notify(`Path ${command}.`, "info"); return;
				}
				if (command === "refresh") { await act(context, client?.snapshot?.passive.trail ? "refreshing the trail (new activity, then titles, links and kinds)" : "catching up on new activity", { kind: "refresh" }, refreshed); return; }
				throw new Error(USAGE);
			} catch (error) {
				if (commandEpoch === epoch) {
					failure(error);
					context.ui.notify(`Path request failed: ${updateErrorSummary(String(error)).replace(/\.$/, "")}. The saved map is unchanged; open /path for full diagnostics.`, "error");
				}
			}
		},
	});
	return recapAnchor;
}

export default installMom;
