import { boundedText, endpoint } from "./advisor.ts";

/**
 * Mom's local decider: a System One endpoint (decider/serve.py) that answers narrow yes/no and choice questions,
 * so a step can skip a full model call. It can only clear or suggest: callers fall back to the model on any doubt.
 */
export type DeciderQuestion =
	| { type: "noul"; instructions: string; criteria?: { false: string; true: string } }
	| { type: "choice"; instructions: string; criteria: Record<string, string> };
export type DeciderAnswer = { type: "noul"; noul: number } | { type: "choice"; choice: string; probabilities: Record<string, number> };

const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const probability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/** Normalize only a complete answer to the menu the classifier was given. */
export function parseDeciderAnswer(question: DeciderQuestion, value: unknown): DeciderAnswer | undefined {
	if (!record(value)) return undefined;
	if (question.type === "noul") return (value.type === undefined || value.type === "noul") && probability(value.noul) ? { type: "noul", noul: value.noul } : undefined;
	if ((value.type !== undefined && value.type !== "choice") || typeof value.choice !== "string" || !Object.hasOwn(question.criteria, value.choice) || !record(value.probabilities)) return undefined;
	const names = Object.keys(question.criteria), raw = value.probabilities;
	if (Object.keys(raw).length !== names.length) return undefined;
	const probabilities: Record<string, number> = {};
	for (const name of names) {
		if (!Object.hasOwn(raw, name) || !probability(raw[name])) return undefined;
		probabilities[name] = raw[name];
	}
	return { type: "choice", choice: value.choice, probabilities };
}

export class Decider {
	private readonly url: URL;
	/** `model` is the server's native model ID; servers that host several (Beverly's) require it. */
	constructor(url: string, private readonly timeoutMs = 15000, private readonly model?: string) { this.url = endpoint(url); }

	async ask<K extends string>(state: string, questions: Record<K, DeciderQuestion>, signal?: AbortSignal): Promise<{ answers: Record<K, DeciderAnswer>; latencyMs: number }> {
		const started = performance.now();
		const response = await fetch(this.url, { method: "POST", redirect: "error", headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...(this.model ? { model: this.model } : {}), state, questions }), signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]) });
		if (!response.ok) throw new Error(`Mom's decider returned HTTP ${response.status}.`);
		const value = JSON.parse(await boundedText(response));
		if (!record(value) || !record(value.answers)) throw new Error("Mom's decider returned an invalid response.");
		const answers = {} as Record<K, DeciderAnswer>;
		for (const name of Object.keys(questions) as K[]) {
			const answer = parseDeciderAnswer(questions[name], value.answers[name]);
			if (!answer) throw new Error(`Mom's decider returned an invalid answer for ${name}.`);
			answers[name] = answer;
		}
		return { answers, latencyMs: Math.round(performance.now() - started) };
	}
}
