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

export class Decider {
	private readonly url: URL;
	constructor(url: string, private readonly timeoutMs = 15000) { this.url = endpoint(url); }

	async ask<K extends string>(state: string, questions: Record<K, DeciderQuestion>, signal?: AbortSignal): Promise<{ answers: Record<K, DeciderAnswer>; latencyMs: number }> {
		const started = performance.now();
		const response = await fetch(this.url, { method: "POST", redirect: "error", headers: { "content-type": "application/json" },
			body: JSON.stringify({ state, questions }), signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]) });
		if (!response.ok) throw new Error(`Mom's decider returned HTTP ${response.status}.`);
		const value = JSON.parse(await boundedText(response));
		if (!record(value) || !record(value.answers)) throw new Error("Mom's decider returned an invalid response.");
		const answers = {} as Record<K, DeciderAnswer>;
		for (const name of Object.keys(questions) as K[]) {
			const a = value.answers[name], q = questions[name];
			if (q.type === "noul" && record(a) && probability(a.noul)) answers[name] = { type: "noul", noul: a.noul };
			else if (q.type === "choice" && record(a) && typeof a.choice === "string" && a.choice in q.criteria && record(a.probabilities)) answers[name] = { type: "choice", choice: a.choice, probabilities: a.probabilities };
			else throw new Error(`Mom's decider returned an invalid answer for ${name}.`);
		}
		return { answers, latencyMs: Math.round(performance.now() - started) };
	}
}
