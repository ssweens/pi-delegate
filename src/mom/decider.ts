import { isProbability, isRecord } from "../util/text.ts";
import { endpoint, postSystemOne } from "./advisor.ts";

/**
 * Path's local decider: a System One endpoint (decider/serve.py) that answers narrow questions of System One's three
 * kinds: a noul (yes/no probability), a choice (one of named options) and a score (a position on ordered levels),
 * so a step can skip a full model call. It can only clear or suggest: callers fall back to the model on any doubt.
 */
export type DeciderQuestion =
	| { type: "noul"; instructions: string; criteria?: { false: string; true: string } }
	| { type: "choice"; instructions: string; criteria: Record<string, string> }
	/** Levels lowest first; the answer is the expected level, 0 to levels − 1. */
	| { type: "score"; instructions: string; criteria: string[] };
export type DeciderAnswer = { type: "noul"; noul: number } | { type: "choice"; choice: string; probabilities: Record<string, number> }
	| { type: "score"; score: number; confidence?: number };

/** Normalize only a complete answer to the menu the classifier was given. */
export function parseDeciderAnswer(question: DeciderQuestion, value: unknown): DeciderAnswer | undefined {
	if (!isRecord(value)) return undefined;
	if (question.type === "noul") return (value.type === undefined || value.type === "noul") && isProbability(value.noul) ? { type: "noul", noul: value.noul } : undefined;
	if (question.type === "score") {
		const top = question.criteria.length - 1, score = value.score;
		if ((value.type !== undefined && value.type !== "score") || typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > top) return undefined;
		return { type: "score", score, ...(isProbability(value.confidence) ? { confidence: value.confidence } : {}) };
	}
	if ((value.type !== undefined && value.type !== "choice") || typeof value.choice !== "string" || !Object.hasOwn(question.criteria, value.choice) || !isRecord(value.probabilities)) return undefined;
	const names = Object.keys(question.criteria), raw = value.probabilities;
	if (Object.keys(raw).length !== names.length) return undefined;
	const probabilities: Record<string, number> = {};
	for (const name of names) {
		if (!Object.hasOwn(raw, name) || !isProbability(raw[name])) return undefined;
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
		const value = await postSystemOne(this.url, JSON.stringify({ ...(this.model ? { model: this.model } : {}), state, questions }),
			{ timeoutMs: this.timeoutMs, signal, label: "Path's decider" });
		if (!isRecord(value) || !isRecord(value.answers)) throw new Error("Path's decider returned an invalid response.");
		const answers = {} as Record<K, DeciderAnswer>;
		for (const name of Object.keys(questions) as K[]) {
			const answer = parseDeciderAnswer(questions[name], value.answers[name]);
			if (!answer) throw new Error(`Path's decider returned an invalid answer for ${name}.`);
			answers[name] = answer;
		}
		return { answers, latencyMs: Math.round(performance.now() - started) };
	}
}
