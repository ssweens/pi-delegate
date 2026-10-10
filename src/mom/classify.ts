// Mom's decision model: Beverly over a System One endpoint. It decides two narrow things and invents
// nothing — the v2 gate's change questions (asked from v2.ts) and the two guards on a repair of saved
// labels. Both callers fall back to her model on any doubt, so a failure here is never a verdict.
import { Decider, type DeciderQuestion } from "./decider.ts";

const ask = (question: string, definition: string, yes: string, no: string): DeciderQuestion =>
	({ type: "noul", instructions: `${question} ${definition}`, criteria: { true: yes, false: no } });

/** What one saved work item is, for a label repair: the saved label, and the one proposed for it. */
export interface WorkSubject { state: string; label: string; intent?: string; observed?: string; proposed?: string }
export const LABEL_QUESTIONS = {
	wrapper_label: ask("Is this label a conversational wrapper?",
		"The label describes the conversation rather than naming the work: it restates a question or a request (\"Explain whether…\", \"Check if…\", \"Clarify…\", \"Request to…\", or ends with a question mark) instead of naming the deliverable.",
		"The label restates the conversation.",
		"The label names the work."),
} as const;
const NAMES_WORK = ask("Does the proposed label name this work?",
	"It names the work when it describes the same deliverable as the work's intent, in any words. A label about something the intent never asks for does not.",
	"The proposed label describes this work.",
	"The proposed label describes something else.");
/** Fitted on nothing: these two guards only ever refuse a rewrite, so a plain midpoint is the honest start. */
const LABEL_CUTOFF: Record<string, number> = { wrapper_label: 0.5, names_work: 0.5 };

export type LabelVerdict = Record<keyof typeof LABEL_QUESTIONS, boolean> & { names_work?: boolean };

const TEXT_LIMIT = 2000;
const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max)}…`;
export const workState = (s: WorkSubject): string => [`Work item (${s.state})`, `Label: ${JSON.stringify(s.label)}`,
	...(s.intent ? [`Intent: ${JSON.stringify(clip(s.intent, TEXT_LIMIT))}`] : []), ...(s.observed ? [`Observed: ${JSON.stringify(clip(s.observed, TEXT_LIMIT))}`] : []),
	...(s.proposed ? [`Proposed label: ${JSON.stringify(s.proposed)}`] : [])].join("\n");

const MAX_IN_FLIGHT = 8;
const CACHE_LIMIT = 2000;
// One GPU behind the endpoint: bound concurrent calls, and ask each distinct subject once.
let active = 0;
const waiting: (() => void)[] = [];
async function slot<T>(run: () => Promise<T>): Promise<T> {
	if (active >= MAX_IN_FLIGHT) await new Promise<void>(resolve => waiting.push(resolve));
	active++;
	try { return await run(); } finally { active--; waiting.shift()?.(); }
}
const cache = new Map<string, Promise<Record<string, number>>>();

/** Beverly over System One: `{ url, model }` resolved from the chosen decision model, never a default.
 *  Any failure throws naming the endpoint — no verdict is ever invented. */
export class Beverly {
	private readonly client: Decider;
	private readonly key: string;
	private readonly endpoint: string;
	constructor(options: { url: string; model: string; timeoutMs?: number }) {
		this.client = new Decider(options.url, options.timeoutMs ?? 15000, options.model);
		this.key = `${options.url}\n${options.model}\n`;
		this.endpoint = `${options.url} (${options.model})`;
	}

	/** Raw nouls — the probability of true, per question. The v2 gate asks its own questions here. */
	async probabilities(state: string, questions: Record<string, DeciderQuestion>): Promise<Record<string, number>> {
		const key = `${this.key}${Object.keys(questions).join(",")}\n${state}`;
		let pending = cache.get(key);
		if (!pending) {
			pending = slot(() => this.client.ask(state, questions)).then(({ answers }) =>
				Object.fromEntries(Object.entries(answers).map(([name, answer]) => [name, answer.type === "noul" ? answer.noul : 0])));
			pending.catch(() => cache.delete(key));
			if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
			cache.set(key, pending);
		}
		try { return await pending; }
		catch (error) { throw new Error(`Beverly ${this.endpoint} could not classify: ${error instanceof Error ? error.message : String(error)}`); }
	}

	/** The label guards. `names_work` is asked only when a replacement label is proposed. */
	async work(subject: WorkSubject): Promise<LabelVerdict> {
		const questions = subject.proposed ? { ...LABEL_QUESTIONS, names_work: NAMES_WORK } : LABEL_QUESTIONS;
		const p = await this.probabilities(workState(subject), questions);
		return Object.fromEntries(Object.keys(questions).map(name => [name, (p[name] ?? 0) >= (LABEL_CUTOFF[name] ?? 0.5)])) as LabelVerdict;
	}
}
