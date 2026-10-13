/** The words the panels use for Path's work states and annotation kinds, so one node reads the same everywhere. */

const FINISHED = ["settled", "finished", "completed", "done"];
const WAITING = ["parked", "waiting", "blocked"];

export const isFinished = (state: string): boolean => FINISHED.includes(state);
export const isWaiting = (state: string): boolean => WAITING.includes(state);

const STATE_WORDS: Record<string, string> = {
	active: "in progress", parked: "waiting", waiting: "waiting", blocked: "blocked", settled: "finished", proposed: "proposed", abandoned: "dropped",
};
/** A state in plain words. */
export const stateWord = (state: string): string => isFinished(state) ? "finished" : STATE_WORDS[state] ?? "not yet known";

export type KindClass = "rule" | "choice" | "observation" | "other";
/** Which kind of note an annotation is, folding the synonyms Path has used. */
export function kindClass(kind: string): KindClass {
	if (["rule", "constraint", "postulate"].includes(kind)) return "rule";
	if (["choice", "question", "decision"].includes(kind)) return "choice";
	if (kind === "observation") return "observation";
	return "other";
}

const KIND_WORDS: Record<KindClass, string> = { rule: "Rule", choice: "Open choice", observation: "Observation", other: "Attached note" };
/** An annotation kind in plain words. */
export const kindWord = (kind: string): string => KIND_WORDS[kindClass(kind)];
