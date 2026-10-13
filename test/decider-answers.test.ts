import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDeciderAnswer, type DeciderQuestion } from "../src/mom/decider.ts";

test("decider answers: System One's three kinds, each only in its own shape and range", () => {
	const noul: DeciderQuestion = { type: "noul", instructions: "?" };
	const choice: DeciderQuestion = { type: "choice", instructions: "?", criteria: { a: "A", b: "B" } };
	const score: DeciderQuestion = { type: "score", instructions: "?", criteria: ["none", "minor", "clear", "major"] };
	assert.deepEqual(parseDeciderAnswer(noul, { noul: 0.2 }), { type: "noul", noul: 0.2 });
	assert.deepEqual(parseDeciderAnswer(choice, { choice: "b", probabilities: { a: 0.1, b: 0.9 } }), { type: "choice", choice: "b", probabilities: { a: 0.1, b: 0.9 } });
	assert.deepEqual(parseDeciderAnswer(score, { type: "score", score: 2.4, confidence: 0.8 }), { type: "score", score: 2.4, confidence: 0.8 }, "the expected level");
	assert.deepEqual(parseDeciderAnswer(score, { score: 0 }), { type: "score", score: 0 });
	assert.equal(parseDeciderAnswer(score, { score: 3.5 }), undefined, "past the top level");
	assert.equal(parseDeciderAnswer(score, { score: -0.1 }), undefined);
	assert.equal(parseDeciderAnswer(score, { noul: 0.4 }), undefined, "a noul is not a score");
	assert.equal(parseDeciderAnswer(score, { type: "choice", score: 1 }), undefined);
});
