// Map-maintenance modes: how Mom turns new activity into an update of her work graph.
//
// One module, one responsibility — the mode DECLARATION and RESOLUTION. It deliberately does not
// route or schedule anything: those stay on the existing seams (momConfiguration's instructions,
// engine.begin's settlement boundary, Mom.prepare's staging, commit_graph's single-writer
// acceptance). Adding a mode is one entry here plus the work named in docs/map-modes.md; it is not
// a new runtime layer.
//
// Why modes exist: the map-maintenance judgment (Mom's "soul") is encoded as prose in one prompt,
// and a small local model cannot hold it all at once. Competing designs move different parts of
// that judgment between the model and host code. A mode names which split is in force.
import { ACT_LABEL_PROMPT, deriveActs, parseActs } from "./act-derivation.ts";
import type { Candidate } from "./candidate.ts";
import { MOM_PROMPT } from "./contract.ts";
import type { FeedEvent } from "./feed.ts";
import type { WorkGraph } from "./graph.ts";

/** What a mode's apply step is handed: the map to change, the staged fragments, the model's
 *  committed payload, and the evidence it may cite. */
export interface ModeApplyInput {
	prior: WorkGraph;
	candidates: readonly Candidate[];
	committed: unknown;
	known: ReadonlyMap<string, FeedEvent>;
	events: readonly FeedEvent[];
}

export interface ModeApplyResult {
	graph: WorkGraph;
	/** Why the host declined part of the payload. Reported, never silently dropped. */
	declined: string[];
}

export interface MapMode {
	/** Stable id, lowercase_underscore. Select with --mom-mode. */
	readonly name: string;
	readonly description: string;
	/** The model's standing map-maintenance instructions. The host appends the operation prompt
	 *  and the settings line; a mode never supplies those. */
	readonly prompt: string;
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
	 * every write and the model never does.
	 */
	readonly apply?: (input: ModeApplyInput) => ModeApplyResult;
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
 * Act labeling: the model decides each fragment's act and writes concise labels for new work;
 * host code decides everything else the graph does about it. Selected with --mom-mode act_labels.
 */
export const ACT_LABELS_MODE: MapMode = {
	name: "act_labels",
	description: "The model labels each fragment with one linguistic act and labels new work; host code derives graph operations. Native updates normally take two requests.",
	prompt: ACT_LABEL_PROMPT,
	finalizer: "commit_acts",
	turns: 1,
	apply: ({ prior, candidates, committed, known, events }) => {
		const ids = candidates.map(candidate => candidate.id);
		const { acts, labels, defects } = parseActs(committed, ids);
		if (defects.length) return { graph: prior, declined: defects };
		const derived = deriveActs(prior, candidates, acts, known, events, labels);
		return { graph: derived.graph, declined: [] };
	},
};

/** Every declared mode. The default is the shipped behaviour: selecting no mode changes nothing. */
export const MODES: readonly MapMode[] = [COMMIT_GRAPH_MODE, ACT_LABELS_MODE];

export const DEFAULT_MODE = COMMIT_GRAPH_MODE.name;

export const modeNames = (): string[] => MODES.map(mode => mode.name);

/**
 * A declared mode the operation can actually run. Exported so the call-budget invariant (M3) is
 * testable without registering a mode that cannot be selected.
 */
export function assertRunnable(mode: MapMode): MapMode {
	// One classification round plus one repair; preparation and audits are separate requests.
	// A multi-stage mode needs the operation seam in docs/map-modes.md (M3) extended first.
	if (mode.turns !== 1) throw new Error(`Mom mode ${JSON.stringify(mode.name)} needs ${mode.turns} model turns; the operation runs one. See docs/map-modes.md.`);
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
	if (!mode) throw new Error(`Unknown Mom mode ${JSON.stringify(wanted)}; --mom-mode accepts ${modeNames().join(", ")}.`);
	return assertRunnable(mode);
}

/**
 * Assemble the standing instructions for a slice: the mode's map-maintenance prompt, the shared
 * operation prompt, then the settings line. The current mode reproduces the pre-mode assembly
 * exactly; test/mom-modes.test.ts pins that.
 */
export function modeInstructions(mode: MapMode, operationPrompt: string, settingsLine: string): string {
	const operation = mode.name === "commit_graph" ? operationPrompt.trim()
		: "Every message starts one operation. Call mom_begin first, alone. If it reports nothing to do, stop. For a normal background update, label exactly the supplied fragments and finish with commit_acts as a sole direct call. A historical catch-up task may supply a host-compressed thread-map digest; in that case reconcile it once with commit_graph and do not call commit_acts. For an explicit question, use answer_question as a sole direct call.";
	return `${mode.prompt}\n\n${operation}\n\n${settingsLine}`;
}
