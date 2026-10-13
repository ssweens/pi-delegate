// Map-maintenance modes: how Path turns new activity into an update of its map — a work graph
// (commit_graph, v2) or the trail (an append-only index into the transcript, docs/trail.md).
//
// One module, one responsibility — the mode DECLARATION and RESOLUTION. It deliberately does not
// route or schedule anything: those stay on the existing seams (momConfiguration's instructions,
// engine.begin's settlement boundary, Path.prepare's staging, each finalizer's single-writer
// acceptance). Adding a mode is one entry here plus the work named in docs/map-modes.md; it is not
// a new runtime layer.
//
// Why modes exist: the map-maintenance judgment (Path's "soul") is encoded as prose in one prompt,
// and a small local model cannot hold it all at once. Competing designs move different parts of
// that judgment between the model and host code. A mode names which split is in force.
import { MOM_PROMPT } from "./contract.ts";
import type { FeedEvent } from "./feed.ts";
import type { WorkGraph } from "./graph.ts";
import { applySpec, applyV2, fromWorkGraph, specFocus, toWorkGraph, V2_OPERATION, V2_PROMPT, type SpecOp } from "./v2.ts";
import { TRAIL_OPERATION, TRAIL_PROMPT } from "../trail/prompt.ts";

/** What a mode's apply step is handed: the map to change, the model's committed payload, and the
 *  evidence refs it may cite. */
export interface ModeApplyInput {
	prior: WorkGraph;
	committed: unknown;
	known: ReadonlyMap<string, FeedEvent>;
	/** The ops decided for this batch, when the decision model read it (v2). */
	spec?: readonly SpecOp[];
}

export interface ModeApplyResult {
	graph: WorkGraph;
	/** Why the host declined part of the payload. Reported, never silently dropped. */
	declined: string[];
	/** Permitted changes that the payload omitted. Kept as diagnostics, never manufactured. */
	unmet?: string[];
}

export interface MapMode {
	/** Stable id, lowercase_underscore. Select with --path-mode. */
	readonly name: string;
	readonly description: string;
	/** The model's standing map-maintenance instructions. The host appends the operation prompt
	 *  and the settings line; a mode never supplies those. */
	readonly prompt: string;
	/** The operation instructions that follow the prompt. Omitted: the shared operation prompt. */
	readonly operation?: string;
	/** The finalizer tool this mode's model calls to commit one update. */
	readonly finalizer: string;
	/** Classification rounds required, excluding preparation, audits, and one repair.
	 *  Only one round is supported — see docs/map-modes.md, M3. */
	readonly turns: number;
	/**
	 * Turn this mode's committed output into the next graph. This is the mode-owned apply step
	 * (docs/map-modes.md, M5). A mode that omits it emits a graph transaction and uses the default
	 * path — `acceptGraph` then `editGraph`, which is correct only when the model authors the write.
	 * A mode whose model emits anything else (acts, facts) MUST supply this, so host code derives
	 * every write and the model never does. A mode that keeps no graph at all (trail) omits it too:
	 * its finalizer persists its own records in mom-tools and only the coverage cursor touches `.mom`.
	 */
	readonly apply?: (input: ModeApplyInput) => ModeApplyResult | Promise<ModeApplyResult>;
}

/** How the checked-in working approach maintains the map: the model reads the evidence and commits
 *  a commit_graph transaction, which the host validates and applies. This is the shipped behaviour
 *  and the reference every other mode is measured against. It needs no `apply` because it emits a
 *  transaction, which the default path already understands. */
export const COMMIT_GRAPH_MODE: MapMode = {
	name: "commit_graph",
	description: "Free-form commit_graph transaction over the evidence. The shipped behaviour; the reference every other mode is measured against.",
	prompt: MOM_PROMPT.trim(),
	finalizer: "commit_graph",
	turns: 1,
};

/**
 * The minimal map (src/mom/v2.ts): the model edits one tree of work, rules and notes directly with
 * commit_v2; the host checks structure and, when present, a per-node change spec. The decision model
 * reads eligible background batches before its model. Stored in the shared map record, so commit_graph
 * and every map reader are unchanged.
 */
export const V2_MODE: MapMode = {
	name: "v2",
	description: "Minimal map: one tree of work, rules and notes with a focus. The model edits it directly; host checks structure and eligible change specs.",
	prompt: V2_PROMPT,
	operation: V2_OPERATION,
	finalizer: "commit_v2",
	turns: 1,
	apply: ({ prior, committed, known, spec }) => {
		const observed = new Set(known.keys());
		// With a spec, the commit is checked against what the decision model decided and nothing else;
		// without one (no decision model, a batch it could not read) structure is all the host checks.
		const input = fromWorkGraph(prior);
		let graph: ReturnType<typeof fromWorkGraph>, defects: string[], unmet: string[] | undefined;
		if (spec?.length) ({ graph, defects, unmet } = applySpec(spec, input, committed, observed));
		else {
			// Focus is the host's in every path (docs/v2-change-spec.md): the commit's own `focus` is ignored, so what
			// the model reacts to in a message (a quoted label, a complaint about the map) cannot move it. It follows
			// from the work added, else stays where it was.
			const applied = applyV2(input, committed, observed, { focus: false });
			graph = { ...applied.graph, focus: specFocus(input, applied.graph, []) }; defects = applied.defects;
		}
		return defects.length
			? { graph: prior, declined: defects, ...(unmet?.length ? { unmet } : {}) }
			: { graph: toWorkGraph(graph, prior), declined: [], ...(unmet?.length ? { unmet } : {}) };
	},
};

/**
 * The trail (src/trail, docs/trail.md): no graph. The model appends waypoints that point into the
 * transcript with record_waypoints; the host checks structure (refs observed, links well-typed) and
 * appends them to `session.trail`. Projections over the waypoints answer where we are and how we got
 * here. Only the coverage cursor is written to `.mom`, so the graph readers see no map.
 */
export const TRAIL_MODE: MapMode = {
	name: "trail",
	description: "Append-only trail of waypoints that point into the transcript; projections answer where we are and how we got here.",
	prompt: TRAIL_PROMPT,
	operation: TRAIL_OPERATION,
	finalizer: "record_waypoints",
	turns: 1,
};

/** Every declared mode. The default is the shipped behaviour: selecting no mode changes nothing. */
export const MODES: readonly MapMode[] = [COMMIT_GRAPH_MODE, V2_MODE, TRAIL_MODE];

export const DEFAULT_MODE = COMMIT_GRAPH_MODE.name;

export const modeNames = (): string[] => MODES.map(mode => mode.name);

/**
 * A declared mode the operation can actually run. Exported so the call-budget invariant (M3) is
 * testable without registering a mode that cannot be selected.
 */
export function assertRunnable(mode: MapMode): MapMode {
	// One classification round plus one repair; preparation and audits are separate requests.
	// A multi-stage mode needs the operation seam in docs/map-modes.md (M3) extended first.
	if (mode.turns !== 1) throw new Error(`Path mode ${JSON.stringify(mode.name)} needs ${mode.turns} model turns; the operation runs one. See docs/map-modes.md.`);
	return mode;
}

/**
 * Resolve a mode name. An empty name selects the default, so an unconfigured host is unchanged.
 * An unknown name, or a declared mode the operation cannot yet run, throws naming the flag —
 * a mode is either in force or loudly refused, never silently ignored.
 */
export function modeFor(name: string | undefined): MapMode {
	const wanted = name?.trim();
	if (!wanted) return COMMIT_GRAPH_MODE;
	const mode = MODES.find(candidate => candidate.name === wanted);
	if (!mode) throw new Error(`Unknown Path mode ${JSON.stringify(wanted)}; --path-mode accepts ${modeNames().join(", ")}.`);
	return assertRunnable(mode);
}

/**
 * Assemble the standing instructions for a slice: the mode's map-maintenance prompt, the shared
 * operation prompt, then the settings line. The current mode reproduces the pre-mode assembly
 * exactly; test/mom-modes.test.ts pins that.
 */
export function modeInstructions(mode: MapMode, operationPrompt: string, settingsLine: string): string {
	return `${mode.prompt}\n\n${mode.operation ?? operationPrompt.trim()}\n\n${settingsLine}`;
}
