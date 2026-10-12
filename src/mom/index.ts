/** Mom runs in oven (her slice follows this session); the lead shows her state, sends the user's requests and adds her hints. */
import { copyToClipboard, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, matchesKey, isKittyProtocolActive, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { MomClient, type Command, type Snapshot, type SourcePage } from "./client.ts";
import { momSettings } from "./settings.ts";
import { ANCHOR, clockTime } from "./anchor.ts";
import type { FindingRequest } from "./operation.ts";
import { CORRECTION } from "./feed.ts";
import { COMPACT_KEY, FOCUS_KEY, MomPanel, MomView, momToolPreview, type PanelDiagnostics, type PanelView } from "../ui/panel.ts";
import { activityFor } from "../ui/activity.ts";
import { updateErrorSummary } from "./status.ts";
import { presentGraph, readText, summaryText } from "../ui/presentation.ts";
import { DEFAULT_MODE, modeNames } from "./modes.ts";
import { momDeciderSelector, momModelSelector, pickMomModel } from "./model-picker.ts";

const FLAGS = {
	"mom-model": ["Exact provider/model for Mom; never inherits the lead model", "openai-codex/gpt-5.6-sol"],
	"mom-mode": [`Map-maintenance mode (${modeNames().join(", ")}); see docs/map-modes.md`, DEFAULT_MODE],
	"mom-interval-ms": ["Minimum spacing between background Mom updates in milliseconds", "0"],
	"mom-max-wait-ms": ["Longest Mom waits for a turn to end before updating anyway, in milliseconds", "1800000"],
	"mom-retry-ms": ["Automatic retry delays after a failed update, comma-separated milliseconds", "5000,60000,300000"],
	"mom-advisor-url": ["Optional System One endpoint. Empty disables it", ""],
	"mom-decider": ["Pi classifier model (local System One) for Mom's decisions: the v2 change check before her model reads a batch. Empty or unavailable: Mom runs without it", "local-llm/beverly-4B"],
	"mom-decider-url": ["Local decider (System One, decider/serve.py) for continuity checks and state-change shadowing. Empty disables it", ""],
	"mom-decider-clear": ["The decider skips a continuity model check when it is at least this sure the turn continues", "0.9"],
	"mom-advisor-model": ["Native System One model ID", "beverly-4B"],
	"mom-advisor-threshold": ["Below this probability routine mid-run work may wait up to one minute", "0.25"],
	"mom-advisor-timeout-ms": ["Screening timeout in milliseconds", "1500"],
	"mom-bootstrap": ["Compress the whole cold backlog before reconciling", "1"],
	"mom-bootstrap-chapters": ["Target chapters per cold-catch-up digest batch", "24"],
	"mom-bootstrap-chars": ["Maximum characters of cold-catch-up compression sent in one proposal", "48000"],
};

const installedIn = new WeakSet<object>();

export function installMom(pi: ExtensionAPI) {
	if (installedIn.has(pi)) return;
	installedIn.add(pi);
	if (process.env.PI_STRINGS_WORKER === "1" || process.env.PI_STRINGS_OPENED === "1") return;
	for (const [name, [description, value]] of Object.entries(FLAGS)) pi.registerFlag(name, { description, type: "string", default: value });
	let ctx: ExtensionContext | undefined, client: MomClient | undefined;
	let ready: Promise<void> = Promise.resolve(), epoch = 0, readError: string | undefined;
	let widgetSignature: string | undefined;
	let heldWidget: PanelView | undefined;
	let viewOpen = false, closeView: (() => void) | undefined, momView: MomView | undefined;
	const sentAnchors = new Set<string>();
	const COMPACT = Symbol.for("@ssweens/pi-tether/compact");
	const compact = () => Reflect.get(globalThis, COMPACT) === true;
	const toggleCompact = () => { Reflect.set(globalThis, COMPACT, !compact()); sync(); };
	function view(explicit = false, elapsed = true): PanelView {
		const error = client?.error ?? readError;
		const saved: PanelView = client?.state ? client.view(explicit, elapsed) : {
			status: client?.error ? "reconnecting" : error && !client ? "needs you" : "connecting", summary: "Waiting for Mom's saved view. Existing notes have not been loaded.",
		};
		const shown = client?.error ?? (explicit || !client ? readError : undefined);
		return { ...saved, compact: compact(), ...(shown ? { error: updateErrorSummary(shown) } : {}), status: client?.error ? "reconnecting" : saved.status };
	}
	const activity = activityFor(pi);
	function sync() {
		momView?.statusChanged();
		const signature = JSON.stringify(view(false, false));
		if (signature === widgetSignature) return;
		widgetSignature = signature;
		activity.setMom(() => heldWidget ?? view(false, false));
	}
	function cached(): string {
		const v = view(true), u = client?.snapshot?.usage;
		return `${v.summary || "Mom has not saved a view of this work yet."}\n\n${v.status}${v.error ? `\n${v.error}` : ""}${v.note ? `\n\nNotice: ${v.note}` : ""}${u ? `\n\nMom (session): ${u.calls} model calls · ${u.input + u.cacheRead + u.cacheWrite} input tokens · ${u.output} output tokens · $${u.nominalCost.toFixed(5)} nominal · ${(u.elapsedMs / 1000).toFixed(1)}s cumulative model/update time` : ""}`;
	}
	function failure(error: unknown) { readError = String(error); sync(); }
	function reset(context: ExtensionContext) {
		const token = ++epoch; client?.close(); client = undefined; ctx = context; readError = undefined;
		widgetSignature = undefined; sentAnchors.clear();
		const flags = Object.fromEntries(Object.entries(FLAGS).map(([name, [, value]]) => [name, pi.getFlag(name) ?? value]));
		let connection: MomClient;
		try {
			connection = new MomClient(context, { flags, changed: () => { if (epoch === token) sync(); },
				publish: message => { if (epoch === token) pi.sendMessage({ ...message, display: true }, { triggerTurn: false }); },
				notify: (text, level) => { if (epoch === token) ctx?.ui.notify(text, level); } });
		} catch (error) { failure(error); return; }
		client = connection;
		ready = connection.connect().catch(error => { if (epoch === token) failure(error); });
		sync();
	}
	function updateContext(context: ExtensionContext) { ctx = context; client?.updateContext(context); }
	async function request(command: Command, signal?: AbortSignal): Promise<unknown> {
		const token = epoch; await ready;
		if (token !== epoch || !client) throw new Error(readError ?? "Mom session changed or is unavailable.");
		return client.request(command, signal);
	}
	async function refresh(): Promise<void> { await request({ kind: "refresh" }); }
	async function findingAction(action: FindingRequest, finding: string) { await request({ kind: "finding", action, finding }); }
	pi.on("session_start", (_event, context) => reset(context));
	// A new branch: her work on the old one is stopped in oven, and she follows the selected branch.
	pi.on("session_tree", (_event, context) => { void client?.halt(); reset(context); });
	pi.on("session_shutdown", () => { epoch++; client?.close(); client = undefined; activity.clearMom(); ctx = undefined; });
	// Her hints: the continuity anchor she prepared after a compaction goes into the lead's context once.
	pi.on("before_agent_start", (started, context) => {
		updateContext(context);
		const anchor = client?.pendingAnchor();
		if (anchor && !sentAnchors.has(anchor.key)) {
			sentAnchors.add(anchor.key);
			pi.sendMessage({ customType: ANCHOR, content: anchor.content, display: true, details: { key: anchor.key } }, { triggerTurn: false });
		}
		delete started.systemPromptOptions.sections.mom_lead_behavior;
	});
	pi.on("agent_settled", (_event, context) => { updateContext(context); void client?.reload(); });
	function diagnostics(): PanelDiagnostics {
		const saved = client?.snapshot?.diagnostics ?? { sections: [], raw: "{}" }, error = client?.error ?? readError;
		return error ? { ...saved, sections: [...saved.sections, { title: "Last problem", text: updateErrorSummary(error) }] } : saved;
	}
	async function show(context: ExtensionContext) {
		if (context.mode !== "tui") { context.ui.notify(cached(), "info"); return; }
		await context.ui.custom<void>((tui, theme, _keys, done) => new MomPanel(() => view(true), theme, () => Math.max(5, tui.terminal.rows - 6), () => done()));
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
				view: () => view(true, false), findingAction, copy: copyToClipboard, retry: refresh, diagnostics,
				status: () => ({ connection: client?.error ? "disconnected" : client?.snapshot ? "connected" : "connecting", project: context.cwd,
					host: client?.snapshot?.host, telemetry: client?.snapshot?.telemetry, usage: client?.snapshot?.usage, enabled: client?.snapshot?.controls.enabled }),
				refreshStatus: async () => { await request({ kind: "status" }); },
				readSource: async (ref, offset) => await request({ kind: "source", ref, offset }) as SourcePage,
				setEnabled: async enabled => { await request({ kind: "controls", change: { enabled } }); },
				draftForLead: text => { const draft = context.ui.getEditorText(); context.ui.setEditorText(`${draft}${draft ? "\n\n" : ""}${text}`); },
				prepareLeadDraft: async finding => { await findingAction("discuss", finding); const draft = context.ui.getEditorText();
					context.ui.setEditorText(`${draft}${draft ? "\n\n" : ""}Mom suggested: ${finding}\nLet's discuss this before acting.`); },
			}, theme, tui, () => done()); },
			{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 } });
		} catch (error) { context.ui.notify(`Cannot open Mom: ${String(error)}`, "error"); }
		finally { if (heldWidget === held) { momView = undefined; viewOpen = false; closeView = undefined; heldWidget = undefined; sync(); } }
	}
	/** Mom's settings panel over her saved controls; undefined until she is connected. /delegate settings opens it as a submenu. */
	function settingsPanel(context: ExtensionContext, tui: TUI, close: () => void) {
		const controls = client?.snapshot?.controls;
		if (!controls) return undefined;
		const fallback = String(pi.getFlag("mom-model") ?? FLAGS["mom-model"][1]);
		return momSettings(controls,
			async change => { await request({ kind: "controls", change }); }, () => tui.requestRender(), close, Math.max(3, Math.min(12, tui.terminal.rows - 9)),
			// Model is one of the settings: its row opens the picker as a submenu. The pick is Mom's
			// alone and never becomes Pi's default.
			// `done(selected)` is the settings row's own save trigger: hand the pick straight back and
			// let momSettings persist it. Saving here as well would fire twice, and a throw would leave
			// the submenu open for good.
			(current, finished) => momModelSelector(context, tui, current, fallback, finished) as never,
			(current, finished) => momDeciderSelector(context, tui, current, finished) as never);
	}
	activity.setMomSettings(settingsPanel);
	async function showSettings(context: ExtensionContext) {
		if (context.mode !== "tui") throw new Error("Mom settings requires interactive mode.");
		await ready;
		if (!client?.snapshot?.controls) throw new Error(readError ?? "Mom is not connected.");
		await context.ui.custom<void>((tui, _theme, _keys, done) => settingsPanel(context, tui, () => done())!);
	}
	async function checkKeys(context: ExtensionContext) {
		if (context.mode !== "tui") throw new Error("The key check requires an interactive terminal.");
		let unsubscribe: (() => void) | undefined;
		try { await context.ui.custom<void>((tui, theme, _keys, done) => {
			const events: string[] = [];
			unsubscribe = context.ui.onTerminalInput(data => {
				const key = matchesKey(data, FOCUS_KEY) ? "Ctrl+Shift+J" : matchesKey(data, COMPACT_KEY) ? "Ctrl+Shift+K" : "neither Mom shortcut";
				const legacy = tui.terminal.kittyProtocolActive && /^\x1b[jk]$/.test(data);
				events.push(`${JSON.stringify(data).slice(0, 80)} → ${legacy ? "legacy Alt; enhanced host mode rejects this encoding" : key}`);
				if (events.length > 6) events.shift(); tui.requestRender(); return undefined;
			});
			return { render: width => new Text([theme.bold("Mom · key check"), "", "Press Ctrl+Shift+J once, then Ctrl+Shift+K once. Press Enter to close.",
				"Escape is recorded here so split Alt sequences remain visible.", "Nothing is saved or sent to a model. Only press test keys here.", "",
				`Enhanced keyboard: host=${tui.terminal.kittyProtocolActive ? "on" : "off"}, Mom parser=${isKittyProtocolActive() ? "on" : "off"}`,
				...(events.length ? events : ["Waiting for a key event…"])].join("\n"), 1, 1).render(width),
				handleInput: data => { if (matchesKey(data, "enter")) done(); }, invalidate() {} };
		}, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 } }); } finally { unsubscribe?.(); }
	}
	pi.registerShortcut(FOCUS_KEY, { description: "Open Mom's view (Esc or Ctrl+Shift+J returns)", handler: open });
	pi.registerShortcut(COMPACT_KEY, { description: "Toggle Mom's widget between full and one line", handler: async context => { ctx = context; toggleCompact(); } });
	pi.registerTool({ name: "mom", label: "Mom", description: "Read Mom's saved story map, selected records, or original evidence without a model call. The widget already shows your current place; use this for more detail. Read-only: working agents never maintain Mom's notes. Choose at most one of graph, source.",
		parameters: Type.Object({ graph: Type.Optional(Type.Object({
				nodes: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 20, description: "IDs of endeavors or attached notes from a previous read. Omit to see the whole map." })),
				depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 3, description: "How much surrounding work to include (0–3, default 1). Even 0 explains the goal, your place in it, and what is outside the view." })),
				checkpoint: Type.Optional(Type.String({ description: "A saved-view ID from history or previousCheckpoint. Omit for the current view. Old records remain readable without reopening their work." })),
			}, { additionalProperties: false })),
			source: Type.Optional(Type.Object({ ref: Type.String({ minLength: 1 }), offset: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false })) }, { additionalProperties: false }),
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("Mom")) + theme.fg("muted", ` · ${args.source ? "reading original evidence" : "finding our place"}`), 0, 0); },
		renderResult(result, _options, theme) {
			const text = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
			const details = result.details;
			const overview = details && typeof details === "object" && "overview" in details && typeof details.overview === "string" ? details.overview : text;
			const preview = details && typeof details === "object" && "preview" in details && typeof details.preview === "string" ? details.preview : overview;
			const expandable = details && typeof details === "object" && "expandable" in details && details.expandable === true;
			return new Text(`${preview}${expandable ? `\n${theme.fg("dim", "Selected records and sources are available to the model, not displayed here.")}` : ""}`, 0, 0);
		},
		async execute(_id, args, signal) {
			if (args.graph && args.source) throw new Error("Choose one of graph or source.");
			try {
				await ready;
				let text: string, overview: string, preview: string, data: unknown, expandable = false;
				if (args.source) { data = await request({ kind: "source", ...args.source }, signal); overview = "Original recorded evidence, not new work or permission to act."; preview = overview; text = `${overview}\n\n${JSON.stringify(data, null, 2)}`; expandable = true; }
				else if (args.graph) { data = await request({ kind: "graph", options: args.graph }, signal); const work = presentGraph(data); overview = summaryText(work); const current = view(false, false); preview = momToolPreview({ ...current, work, summary: overview }); expandable = Boolean(args.graph.nodes?.length || args.graph.checkpoint); text = readText(work, expandable); }
				else { await request({ kind: "graph", options: {} }, signal); text = cached(); overview = text; preview = momToolPreview(view(true, false)); }
				return { content: [{ type: "text" as const, text }], details: { overview, preview, expandable, data, at: client?.snapshot?.explicit.work?.at } };
			} catch (error) {
				failure(error);
				throw new Error("Mom couldn't read that saved view or source. Her last saved notes are unchanged. Use an ID from a previous Mom read; /mom detail shows the reason.");
			}
		},
	});
	pi.registerCommand("mom", { description: "Open Mom · compact · overview · status · map|graph [endeavor] [depth] · detail · keys · correct <text> · source <id> [offset] · log · refresh · relabel · pause · resume · settings · model",
		handler: async (args, context) => {
			ctx = context;
			const commandEpoch = epoch;
			const [command, ...parts] = args.trim().split(/\s+/), text = parts.join(" ");
			try {
				if (!command || command === "detail") return await open(context);
				if (command === "overview") return await show(context);
				if (command === "compact") { toggleCompact(); return; }
				if (command === "status") { context.ui.notify(cached(), "info"); return; }
				if (command === "keys") return await checkKeys(context);
				if (command === "settings") { if (parts.length) throw new Error("Use /mom settings to open the interactive controls."); return await showSettings(context); }
				if (command === "model") {
					if (context.mode !== "tui") throw new Error("Mom's model switcher requires interactive mode.");
					await ready;
					const controls = client?.snapshot?.controls;
					if (!controls) throw new Error(readError ?? "Mom is not connected.");
					// The pick is scoped to Mom: it never becomes Pi's default model.
					const picked = await pickMomModel(context, controls.model, String(pi.getFlag("mom-model") ?? FLAGS["mom-model"][1]));
					if (!picked) return;
					await request({ kind: "controls", change: { model: picked } });
					context.ui.notify(`Mom will use ${picked}. Saved; her slice reconfigures when idle.`, "info");
					return;
				}
				if (command === "pause" || command === "resume") {
					await request({ kind: "controls", change: { enabled: command === "resume" } });
					context.ui.notify(`Mom ${command === "pause" ? "paused" : "resumed"}.`, "info"); return;
				}
				if (command === "correct") {
					if (!text) throw new Error("Use /mom correct <your correction>.");
					// The correction is in the lead's session: oven delivers it to her like any new entry.
					pi.sendMessage({ customType: CORRECTION, content: args.slice(args.indexOf(command) + command.length).trim(), display: true, details: { origin: "user-command" } }, { triggerTurn: false });
					return;
				}
				if (command === "graph" || command === "map") {
					const data = await request({ kind: "graph", options: { nodes: parts[0] ? [parts[0]] : undefined, depth: parts[1] ? Number(parts[1]) : undefined } });
					context.ui.notify(readText(presentGraph(data), Boolean(parts[0])), "info"); return;
				}
				if (command === "source") {
					if (!parts[0]) throw new Error("Use /mom source <source-id> [offset].");
					context.ui.notify(`Original recorded evidence, not new work:\n${JSON.stringify(await request({ kind: "source", ref: parts[0], offset: Number(parts[1] ?? 0) }), null, 2)}`, "info"); return;
				}
				if (command === "log") {
					const records = await request({ kind: "log" }) as { at: number; type: string; data: Record<string, any> }[];
					const lines = records.map(record => {
						const time = clockTime(record.at), d = record.data;
						if (record.type === "notice") return `${time} finding (${d.key}) — ${d.action}: ${d.note?.text ?? ""}`;
						if (d.kind === "window") {
							if (d.action === "opened") return `${time} window after compact ${d.compaction} — opened (watching the first settled turns)`;
							if (d.action === "checked") return `${time} window after compact ${d.compaction} — watched turn ${d.turns}/3`
								+ `${d.flagged ? `, flagged: ${d.flagged.map((flag: { class: string; label: string; matched: string[] }) => `${flag.class} “${flag.label}” (${flag.matched.join(", ")})`).join("; ")}` : ""}`
								+ `${d.checks ? `, model check ${d.checks}/3` : ""}${d.error ? `, check failed: ${d.error}` : ""}`;
							if (d.action === "corrected") return `${time} window after compact ${d.compaction} — corrected:\n${d.content}`;
							const reason = d.reason === "user-message" ? "the user's next message" : d.reason === "turns" ? "three settled turns" : d.reason === "correction" ? "the correction" : "a new compaction";
							return `${time} window after compact ${d.compaction} — closed (${reason})${d.held ? ", continuity held" : ""}`;
						}
						if (d.action === "delivered") return `${time} anchor after compact ${d.compaction} — delivered:\n${d.content}`;
						if (d.action === "pending") return `${time} anchor after compact ${d.compaction} — queued (not yet delivered)`;
						if (d.action === "reserved") return `${time} anchor after compact ${d.compaction} — prepared (delivery not confirmed)`;
						return `${time} anchor after compact ${d.compaction} — skipped: ${d.reason}`;
					});
					context.ui.notify(lines.length ? `Mom findings and continuity events (oldest first):\n${lines.join("\n")}` : "Mom has not recorded findings or continuity events yet.", "info"); return;
				}
				if (command === "refresh") { await refresh(); return; }
				if (command === "relabel") { await request({ kind: "relabel" }); return; }
				throw new Error("Use /mom, overview, status, map, graph, detail, correct, source, log, refresh, relabel, pause, or resume.");
			} catch (error) {
				if (commandEpoch === epoch) {
					failure(error);
					context.ui.notify(`Mom request failed: ${updateErrorSummary(String(error))}. The saved map is unchanged; /mom detail has full diagnostics.`, "error");
				}
			}
		},
	});
}

export default installMom;
