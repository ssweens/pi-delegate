import type { Cut, Observation, SessionReader } from "./feed.ts";
import type { Notice } from "./contract.ts";
import { PROCESS_RISK_CLASSES, processNoticeKey, FINDING_ACTIONS, emptyEngagement, recordEngagement, type Engagement, type FindingFeedback, type ProcessRiskClass } from "./process-health.ts";
import { CONTROL_KEYS } from "./sidecar.ts";
import { mergeGlobals, readMomGlobals } from "./globals.ts";
import { DEFAULT_MODE, modeFor } from "./modes.ts";
import { isAdvisorScreenRecord, type AdvisorScreenRecord } from "./advisor.ts";
import type { MomStore, SidecarRecord } from "./sidecar.ts";
import { Check } from "typebox/value";
import { checkGraph, normalizeMotherRoot, Unfinished, type WorkGraph, type UnfinishedItems } from "./graph.ts";
import { WINDOW_FLAG_CLASSES } from "./window.ts";

export const NOTICE = "pi-tether.mom-notice";
export interface Usage {
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	nominalCost: number;
	elapsedMs: number;
}
export const emptyUsage = (): Usage => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, nominalCost: 0, elapsedMs: 0 });
export interface GraphChange {
	before: number | null; after: number;
	created: { id: string; label: string; sources: string[] }[];
	retired: { id: string; label: string; sources: string[] }[];
}
/** Recorded map changes, not a judgment of whether the interpretation was correct. */
export function graphChange(before: { nodes: readonly { id: string; label: string; sources: string[] }[] } | null, after: { nodes: readonly { id: string; label: string; sources: string[] }[] }): GraphChange {
	const oldIds = new Set(before?.nodes.map(n => n.id)), newIds = new Set(after.nodes.map(n => n.id));
	const record = ({ id, label, sources }: { id: string; label: string; sources: string[] }) => ({ id, label, sources: [...sources] });
	return { before: before?.nodes.length ?? null, after: after.nodes.length,
		created: after.nodes.filter(n => !oldIds.has(n.id)).map(record),
		retired: (before?.nodes ?? []).filter(n => !newIds.has(n.id)).map(record) };
}
/** One materialized map. Usage is a separate sidecar concern. */
export interface Checkpoint { sessionId: string; graph: WorkGraph; note: Notice | null; unfinished?: UnfinishedItems; cut: Cut; at: number; model: string; change?: GraphChange }

const record = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const integer = (x: unknown) => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const hash = (x: unknown) => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const usageLike = (x: unknown): x is Usage => record(x) && Object.keys(emptyUsage()).every(k => typeof x[k] === "number" && Number.isFinite(x[k]) && x[k] >= 0);
const cutLike = (x: unknown): x is Cut => {
	if (!record(x) || (x.parent !== null && typeof x.parent !== "string") || !Array.isArray(x.workers)) return false;
	for (const w of x.workers) {
		if (!record(w) || !["key", "file", "sessionId", "actor", "runId", "cwd"].every((k) => typeof w[k] === "string") ||
			w.key !== w.sessionId || !integer(w.offset) || !integer(w.messages) || !integer(w.forkedMessages) ||
			(w.lastId !== null && typeof w.lastId !== "string") || !hash(w.hash) ||
			(w.device !== null && !integer(w.device)) || (w.inode !== null && !integer(w.inode))) return false;
	}
	return true;
};

function checkpointValue(x: unknown, allowCutover: boolean): { checkpoint: Checkpoint; cutover: boolean } | undefined {
	if (!record(x) || "version" in x || "usage" in x || typeof x.sessionId !== "string" || !Number.isFinite(x.at) || typeof x.model !== "string" || !record(x.cut)) return undefined;
	let normalized;
	try { normalized = normalizeMotherRoot(x.graph); } catch { return undefined; }
	if (normalized.changed && !allowCutover) return undefined;
	const value = normalized.changed ? { ...x, graph: normalized.graph } : x;
	try { checkGraph(value.graph); } catch { return undefined; }
	if (value.unfinished !== undefined && !Check(Unfinished, value.unfinished)) return undefined;
	if (value.change !== undefined) {
		const c = value.change;
		if (!record(c) || (c.before !== null && !integer(c.before)) || c.after !== value.graph.nodes.length ||
			![c.created, c.retired].every(items => Array.isArray(items) && items.every(n => record(n) && typeof n.id === "string" && typeof n.label === "string" && Array.isArray(n.sources) && n.sources.length && n.sources.every((s: unknown) => typeof s === "string")))) return undefined;
		if (c.before !== null && c.after !== c.before + c.created.length - c.retired.length) return undefined;
	}
	if (!cutLike(value.cut)) return undefined;
	if (!(value.note === null || (record(value.note) && typeof value.note.text === "string" && PROCESS_RISK_CLASSES.includes(value.note.riskClass) &&
		typeof value.note.target === "string" && [value.note.riskRefs, value.note.actionRefs].every(refs => Array.isArray(refs) && refs.length && refs.every((ref: unknown) => typeof ref === "string")) &&
		(value.note.nextRequest === undefined || typeof value.note.nextRequest === "boolean")))) return undefined;
	return { checkpoint: value as Checkpoint, cutover: normalized.changed };
}

export function isCheckpoint(x: unknown): x is Checkpoint { return Boolean(checkpointValue(x, false)); }

export interface CursorFailure { key: string; from: Cut; through: Cut; firstRef: string; lastRef: string; count: number; error: string; failures: number }
export interface SkippedGap extends CursorFailure { id: string }
/** One post-compaction anchor queued for (or delivered/skipped on) the next lead request. */
export interface AnchorState { key: string; compaction: string; at: number }
/** How a post-compaction verification window closed. */
export type WindowCloseReason = "user-message" | "turns" | "correction" | "superseded";
/** A post-compaction verification window open at reload; it watches the first settled lead turns. */
export interface WindowLive { key: string; compaction: string; at: number; turns: number; checks: number }
/** The outcome of a closed post-compaction verification window. */
export interface WindowOutcome { key: string; compaction: string; at: number; held: boolean; reason: WindowCloseReason }
/** Durable delivery controls. `enabled` gates Mom entirely; the rest gate one injection surface
 * each, so the user can silence advice without losing her saved map or background maintenance. */
export interface MomControls { enabled: boolean; inject: boolean; nudgedClasses: ProcessRiskClass[]; mode: string; model: string; decider: string }
export interface MomState { observations: Observation[]; checkpoint?: Checkpoint; checkpointId?: string; coverageCut?: Cut; enabled: boolean; inject: boolean; nudgedClasses: ProcessRiskClass[]; mode: string; model: string; decider?: string; unresolvedNotices: string[]; feedback: Record<string, FindingFeedback>; engagement: Engagement; usage?: Usage; error?: string; failure?: CursorFailure; gaps: SkippedGap[]; screen?: AdvisorScreenRecord; cutover?: boolean; pendingAnchor?: AnchorState; lastAnchor?: AnchorState; reservedAnchor?: AnchorState & { content: string }; window?: WindowLive; lastWindow?: WindowOutcome }

const failureLike = (x: unknown): x is CursorFailure => record(x) && typeof x.key === "string" && cutLike(x.from) && cutLike(x.through) &&
	typeof x.firstRef === "string" && typeof x.lastRef === "string" && integer(x.count) && x.count > 0 &&
	typeof x.error === "string" && integer(x.failures);
const mapKeys = new Set(["snapshot", "base", "cut", "failure", "gap", "resolvedGaps", "resolvedNotices", "screen", "observation", ...CONTROL_KEYS]);

/** Full map snapshots valid for the selected branch; map patches never become history handles. */
export function branchCheckpoints(records: readonly SidecarRecord[], branch: ReadonlySet<string>): { id: string; data: Checkpoint }[] {
	const checkpoints: { id: string; data: Checkpoint }[] = [];
	for (const item of records) {
		if (item.type !== "map" || item.data.snapshot === undefined) continue;
		const parsed = checkpointValue(item.data.snapshot, true);
		if (!parsed) throw new Error("Invalid Mom map snapshot in her sidecar; refusing to silently replace it.");
		if (parsed.checkpoint.cut.parent !== null && !branch.has(parsed.checkpoint.cut.parent)) continue;
		checkpoints.push({ id: item.id, data: parsed.checkpoint });
	}
	return checkpoints;
}

/** Mom state comes only from map/notice/usage records in her sidecar. */
export async function loadState(store: MomStore, manager: SessionReader): Promise<MomState> {
	const state: MomState = { observations: [], enabled: true, inject: false, nudgedClasses: [...PROCESS_RISK_CLASSES], mode: "", model: "", gaps: [], unresolvedNotices: [], feedback: {}, engagement: emptyEngagement() };
	const records = await store.load(), branch = new Set(manager.getBranch().map(e => e.id));
	const gaps = new Map<string, SkippedGap>(), unresolvedNotices = new Set<string>();
	let coverageAt = 0;
	for (const item of records) {
		if (item.type === "notice") {
			if (typeof item.data.key !== "string" || !FINDING_ACTIONS.includes(item.data.action) ||
				(item.data.presented !== undefined && typeof item.data.presented !== "boolean") ||
				(item.data.parent !== null && typeof item.data.parent !== "string")) throw new Error("Invalid Mom notice state in her sidecar.");
			if (item.data.parent !== null && !branch.has(item.data.parent)) continue;
			// Older delivery receipts omitted the note; the preceding accepted map owns its evidence.
			const savedNote = state.checkpoint?.note;
			const note = item.data.note ?? (item.data.action === "delivered" && savedNote && noticeKey(savedNote) === item.data.key ? savedNote : undefined);
			if (note !== undefined && (!record(note) || !Array.isArray(note.riskRefs) || !note.riskRefs.length ||
				!note.riskRefs.every((ref: unknown) => typeof ref === "string"))) throw new Error("Invalid Mom finding evidence.");
			if (item.data.action === "delivered") unresolvedNotices.add(item.data.key);
			else if (["understood", "dismiss", "incorrect", "ignored", "backoff"].includes(item.data.action)) {
				const refs = item.data.note?.riskRefs;
				if (!Array.isArray(refs) || !refs.length || !refs.every(ref => typeof ref === "string")) throw new Error("Invalid Mom finding feedback evidence.");
				state.feedback[item.data.key] = { action: item.data.action, riskRefs: refs };
			}
			recordEngagement(state.engagement, item.data.action, item.data.key, note, item.data.parent, item.data.presented === true);
			continue;
		}
		if (item.type === "usage") {
			if (!usageLike(item.data.usage) || (item.data.error !== undefined && item.data.error !== null && typeof item.data.error !== "string")) {
				throw new Error("Invalid Mom usage state in her sidecar.");
			}
			state.usage = item.data.usage;
			state.error = typeof item.data.error === "string" ? item.data.error : undefined;
			continue;
		}
		if (item.type === "injection") {
			const d = item.data;
			if (!["anchor", "window"].includes(d.kind) ||
				typeof d.key !== "string" || !d.key || typeof d.compaction !== "string" || !d.compaction ||
				(d.parent !== null && typeof d.parent !== "string") ||
				(d.kind === "anchor" && !["pending", "reserved", "delivered", "skipped"].includes(d.action)) ||
				(d.kind === "anchor" && ["reserved", "delivered"].includes(d.action) && typeof d.content !== "string") ||
				(d.kind === "anchor" && d.action === "skipped" && typeof d.reason !== "string")) throw new Error("Invalid Mom injection state in her sidecar.");
			if (d.parent !== null && !branch.has(d.parent)) continue;
			if (d.kind === "window") {
				const windowAction = d.action;
				if (!["opened", "checked", "corrected", "closed"].includes(windowAction)) throw new Error("Invalid Mom injection state in her sidecar.");
				if (windowAction === "opened") {
					if (state.window) throw new Error("Invalid Mom injection state in her sidecar.");
					state.window = { key: d.key, compaction: d.compaction, at: item.at, turns: 0, checks: 0 };
				} else if (windowAction === "checked") {
					if (!state.window || state.window.key !== d.key || !integer(d.turns) || d.turns < 1 || d.turns > 3 ||
						!integer(d.checks) || d.checks > 3 || (d.error !== undefined && typeof d.error !== "string")) throw new Error("Invalid Mom injection state in her sidecar.");
					if (d.flagged !== undefined && (!Array.isArray(d.flagged) || !d.flagged.every((flag: any) => record(flag) &&
						typeof flag.class === "string" && (WINDOW_FLAG_CLASSES as readonly string[]).includes(flag.class) &&
						typeof flag.node === "string" && typeof flag.label === "string" && typeof flag.intent === "string" &&
						Array.isArray(flag.matched) && flag.matched.every((matched: unknown) => typeof matched === "string") &&
						Array.isArray(flag.sources) && flag.sources.every((source: unknown) => typeof source === "string")))) throw new Error("Invalid Mom injection state in her sidecar.");
					state.window = { ...state.window, turns: d.turns, checks: d.checks };
				} else if (windowAction === "corrected") {
					if (!state.window || state.window.key !== d.key || typeof d.content !== "string") throw new Error("Invalid Mom injection state in her sidecar.");
					state.lastWindow = { key: d.key, compaction: d.compaction, at: item.at, held: false, reason: "correction" };
					state.window = undefined;
				} else {
					if (!["user-message", "turns", "correction", "superseded"].includes(d.reason) || typeof d.held !== "boolean" ||
						!integer(d.turns) || d.turns > 3) throw new Error("Invalid Mom injection state in her sidecar.");
					if (state.window) {
						if (state.window.key !== d.key) throw new Error("Invalid Mom injection state in her sidecar.");
						state.window = undefined;
					} else if (state.lastWindow?.key !== d.key) throw new Error("Invalid Mom injection state in her sidecar.");
					state.lastWindow = { key: d.key, compaction: d.compaction, at: item.at, held: d.held, reason: d.reason };
				}
				continue;
			}
			if (d.action === "pending") state.pendingAnchor = { key: d.key, compaction: d.compaction, at: item.at };
			else {
				// Reserving publication consumes the queue without claiming delivery.
				if (state.pendingAnchor && item.at >= state.pendingAnchor.at) delete state.pendingAnchor;
				// A reservation the lead has not acknowledged survives a reload of the lead.
				if (d.action === "reserved") state.reservedAnchor = { key: d.key, compaction: d.compaction, at: item.at, content: d.content };
				if (d.action === "delivered" || d.action === "skipped") delete state.reservedAnchor;
				if (d.action === "delivered") state.lastAnchor = { key: d.key, compaction: d.compaction, at: item.at };
			}
			continue;
		}
		if (Object.keys(item.data).some(key => !mapKeys.has(key)) || !Object.keys(item.data).length) throw new Error("Invalid Mom map state in her sidecar.");
		if (item.data.observation !== undefined) {
			const observation = item.data.observation;
			if (!record(observation) || typeof observation.key !== "string" || !observation.key.startsWith("mom-") ||
				(observation.parent !== null && typeof observation.parent !== "string") || !Array.isArray(observation.entries) ||
				(observation.entries.length < 1 || observation.entries.length > 2) || observation.entries.some((entry: unknown) => !record(entry) || typeof entry.id !== "string" ||
					entry.type !== "message" || typeof entry.timestamp !== "string" || !record(entry.message) || !["assistant", "toolResult"].includes(entry.message.role)) ||
				(observation.entries.length === 2 && (observation.entries[0].message.role !== "assistant" || observation.entries[1].message.role !== "toolResult")))
				throw new Error("Invalid Mom tool observation in her sidecar.");
			if (observation.parent === null || branch.has(observation.parent)) state.observations.push(observation as Observation);
		}
		let branchAnchor = false, applies = false, screenRecord: unknown;
		if (item.data.screen !== undefined) {
			// Resolve this receipt against the record's own coverage anchor before later records move the cursor.
			if (!isAdvisorScreenRecord(item.data.screen)) throw new Error("Invalid Mom screen receipt in her sidecar.");
			screenRecord = item.data.screen;
		}
		if (item.data.snapshot !== undefined) {
			branchAnchor = true;
			const parsed = checkpointValue(item.data.snapshot, true);
			if (!parsed) throw new Error("Invalid Mom map snapshot in her sidecar; refusing to silently replace it.");
			if (parsed.checkpoint.cut.parent === null || branch.has(parsed.checkpoint.cut.parent)) {
				applies = true;
				state.checkpoint = parsed.checkpoint; state.checkpointId = item.id; state.coverageCut = parsed.checkpoint.cut;
				if (parsed.cutover) state.cutover = true; else delete state.cutover;
				coverageAt = item.at; delete state.failure;
			}
		}
		if (item.data.enabled !== undefined) {
			if (typeof item.data.enabled !== "boolean") throw new Error("Invalid Mom enabled state in her sidecar.");
			state.enabled = item.data.enabled;
		}
		if (item.data.inject !== undefined) {
			if (typeof item.data.inject !== "boolean") throw new Error("Invalid Mom injection control in her sidecar.");
			state.inject = item.data.inject;
		}
		if (item.data.mode !== undefined) {
			// Sidecar records are history: validate the effective mode after replay, not a superseded value.
			if (typeof item.data.mode !== "string") throw new Error("Invalid Mom mode in her sidecar.");
			state.mode = item.data.mode;
		}
		if (item.data.model !== undefined) {
			// Empty means "the configured default"; anything else must be a non-empty provider/id.
			if (typeof item.data.model !== "string") throw new Error("Invalid Mom model in her sidecar.");
			state.model = item.data.model.trim();
			if (state.model && !/^[\w.-]+\/[\w./:-]+$/.test(state.model)) throw new Error(`Invalid Mom model ${JSON.stringify(state.model)}; expected provider/id.`);
		}
		if (item.data.decider !== undefined) {
			// Unlike Mom's model, empty deliberately disables semantic classification.
			if (typeof item.data.decider !== "string") throw new Error("Invalid Mom decision model in her sidecar.");
			state.decider = item.data.decider.trim();
			if (state.decider && !/^[\w.-]+\/[\w./:-]+$/.test(state.decider)) throw new Error(`Invalid Mom decision model ${JSON.stringify(state.decider)}; expected provider/id.`);
		}
		if (item.data.nudgedClasses !== undefined) {
			if (!Array.isArray(item.data.nudgedClasses) || item.data.nudgedClasses.some((value: unknown) => !PROCESS_RISK_CLASSES.includes(value as never)))
				throw new Error("Invalid Mom nudge control in her sidecar.");
			state.nudgedClasses = [...new Set(item.data.nudgedClasses as ProcessRiskClass[])] as ProcessRiskClass[];
		}
		if (item.data.cut !== undefined) {
			branchAnchor = true;
			if ((item.data.base !== null && typeof item.data.base !== "string") || !cutLike(item.data.cut)) throw new Error("Invalid Mom map cursor in her sidecar.");
			const sameMap = item.data.base === state.checkpointId || (!state.checkpointId && item.data.base === null);
			if (sameMap && item.at >= coverageAt && (item.data.cut.parent === null || branch.has(item.data.cut.parent))) {
				applies = true;
				state.coverageCut = item.data.cut; coverageAt = item.at; delete state.failure;
				if (state.checkpoint) state.checkpoint = { ...state.checkpoint, cut: item.data.cut, at: item.at };
			}
		}
		if (item.data.failure !== undefined) {
			if (item.data.failure === null) {
				if (!branchAnchor) throw new Error("Invalid Mom failure clearing state in her sidecar.");
				if (applies) delete state.failure;
			} else {
				// A retry record never advances coverage, so an unreadable one (e.g. an older format
				// without range fields) is dropped: its evidence is simply read again.
				if (!failureLike(item.data.failure)) { if (item.at >= coverageAt) delete state.failure; }
				else if (item.at >= coverageAt && (item.data.failure.through.parent === null || branch.has(item.data.failure.through.parent))) state.failure = item.data.failure;
			}
		}
		if (item.data.gap !== undefined) {
			const gapData = item.data.gap;
			if (!record(gapData) || typeof gapData.id !== "string" || !["open", "resolved"].includes(gapData.action)) throw new Error("Invalid Mom skipped-gap state in her sidecar.");
			if (gapData.action === "resolved") {
				if (!branchAnchor) throw new Error("Invalid Mom skipped-gap resolution in her sidecar.");
				if (applies) gaps.delete(gapData.id);
			} else {
				const id = gapData.id;
				if (!failureLike(gapData)) throw new Error("Invalid Mom skipped-gap state in her sidecar.");
				if (gapData.through.parent === null || branch.has(gapData.through.parent)) gaps.set(id, { ...gapData, id });
			}
		}
		if (item.data.resolvedGaps !== undefined) {
			if (!branchAnchor || !Array.isArray(item.data.resolvedGaps) || !item.data.resolvedGaps.every((id: unknown) => typeof id === "string" && id.length > 0)) throw new Error("Invalid Mom skipped-gap resolutions in her sidecar.");
			if (applies) for (const id of item.data.resolvedGaps) gaps.delete(id);
		}
		if (item.data.resolvedNotices !== undefined) {
			if (!branchAnchor || !Array.isArray(item.data.resolvedNotices) || !item.data.resolvedNotices.every((key: unknown) => typeof key === "string")) throw new Error("Invalid Mom process-risk resolution in her sidecar.");
			if (applies) for (const key of item.data.resolvedNotices) { unresolvedNotices.delete(key); delete state.feedback[key]; }
		}
		if (screenRecord !== undefined && applies) state.screen = screenRecord as AdvisorScreenRecord;
	}
	state.gaps = [...gaps.values()]; state.unresolvedNotices = [...unresolvedNotices];
	// Mom's controls are global (globals.ts) and win over anything a session saved before them. Both
	// sides read this — the lead's client and her slice in oven — so a setting saved once holds
	// everywhere, and a value that is not valid is simply absent.
	const globals = readMomGlobals();
	const sessionMode = state.mode === "act_labels" ? DEFAULT_MODE : state.mode;
	const saved = mergeGlobals(globals, { enabled: state.enabled, inject: state.inject, nudgedClasses: state.nudgedClasses,
		mode: sessionMode, model: state.model, ...(state.decider === undefined ? {} : { decider: state.decider }) });
	state.enabled = saved.enabled as boolean;
	state.inject = saved.inject as boolean;
	state.nudgedClasses = saved.nudgedClasses as ProcessRiskClass[];
	const selectedMode = String(saved.mode ?? "");
	state.mode = selectedMode ? modeFor(selectedMode).name : "";
	state.model = String(saved.model ?? "");
	state.decider = saved.decider === undefined ? undefined : String(saved.decider);
	return state;
}

export const noticeKey = (note: Notice) => processNoticeKey(note);
export function sumUsage(a: Usage, b: Usage): Usage {
	const sum = emptyUsage();
	for (const key of Object.keys(sum) as (keyof Usage)[]) sum[key] = a[key] + b[key];
	return sum;
}
