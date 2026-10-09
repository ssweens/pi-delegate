import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveActs, parseActs, type Act } from "../src/mom/act-derivation.ts";
import { enumerateCandidates } from "../src/mom/enumerate.ts";
import { extractEvents } from "../src/mom/feed.ts";
import type { Candidate } from "../src/mom/candidate.ts";
import type { FeedEvent } from "../src/mom/feed.ts";
import type { GraphNode, WorkGraph } from "../src/mom/graph.ts";

const event = (ref: string, actor: string, kind: string, at: string, text = ""): FeedEvent => ({ ref, actor, kind, at, text });
const node = (id: string, parent: string | null, state: GraphNode["state"], label: string, source: string, intent = label): GraphNode => ({
	id, kind: "feature", parent, state, label, intent, observed: "", actor: "", sources: [source],
});
const graph = (nodes: GraphNode[], focus: string): WorkGraph => ({
	revision: 1, motherThread: "root", purpose: "root", focus, edges: [], nodes,
});
const candidate = (id: string, source: string, source_role: Candidate["source_role"], quote: string, prior_ref: string | null = null): Candidate => ({
	id, kind: "new_work", source, source_role, quote, prior_ref, proposed: null,
});
const acts = (...entries: [string, Act][]) => new Map(entries);

test("act labels require and preserve a model-written work label", () => {
	const parsed = parseActs({ acts: [{ id: "c01", act: "request", label: "Repair Mom catch-up" }] }, ["c01"]);
	assert.deepEqual(parsed.defects, []);
	assert.equal(parsed.labels.get("c01"), "Repair Mom catch-up");
	const missing = parseActs({ acts: [{ id: "c01", act: "request" }] }, ["c01"]);
	assert.deepEqual(missing.defects, ["c01: request needs a model-written label"]);
	const prior = graph([node("root", null, "active", "Reliable work", "root-source")], "root");
	const result = deriveActs(prior, [candidate("c01", "user-request", "user", "Please make Mom fast.")], acts(["c01", "request"]), new Map([["user-request", event("user-request", "lead", "user", "2026-10-09T08:00:00.000Z")]]), [], new Map([["c01", "Make Mom fast"]]));
	assert.equal(result.graph.nodes.find(item => item.id.startsWith("actw"))?.label, "Make Mom fast");
	assert.deepEqual(result.graph.nodes.find(item => item.id.startsWith("actw"))?.sources, ["user-request"]);
	const opening = deriveActs({ revision: 0, motherThread: null, purpose: null, focus: null, edges: [], nodes: [] },
		[candidate("c01", "user-request", "user", "Please make Mom fast.")], acts(["c01", "request"]),
		new Map([["user-request", event("user-request", "lead", "user", "2026-10-09T08:00:00.000Z")]]), [], new Map([["c01", "Make Mom fast"]]));
	assert.equal(opening.graph.nodes.find(item => item.id === opening.graph.purpose)?.label, "Make Mom fast");
	assert.deepEqual(opening.graph.nodes.find(item => item.id === opening.graph.purpose)?.sources, ["user-request"]);
});

test("a structured dialog answer cannot become new work", () => {
	const prior = graph([node("root", null, "active", "Reliable work", "root-source")], "root");
	const answer = event("answer", "lead", "user_answer", "2026-10-09T08:00:00.000Z", "User answers: Code only");
	const result = deriveActs(prior, [{ ...candidate("c01", answer.ref, "user", answer.text!), source_kind: "user_answer" }], acts(["c01", "request"]), new Map([[answer.ref, answer]]), [answer], new Map([["c01", "Apply the bounded-tool fix"]]));
	assert.equal(result.graph.nodes.filter(item => item.id.startsWith("actw")).length, 0);
});

test("a recorded dialog result retains its provenance through enumeration and apply", () => {
	const prior = graph([node("root", null, "active", "Reliable work", "root-source")], "root");
	const stream = { key: "session", actor: "lead" };
	const prompt = extractEvents(stream, { id: "question", type: "message", timestamp: "2026-10-09T08:00:00.000Z", message: {
		role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "gather_input", arguments: { question: "Which scope?" } }],
	} });
	const answer = extractEvents(stream, { id: "reply", type: "message", timestamp: "2026-10-09T08:00:01.000Z", message: {
		role: "toolResult", toolName: "gather_input", toolCallId: "call-1", content: [{ type: "text", text: "User answered: Ship the adapter" }],
	} });
	const known = new Map([...prompt, ...answer].map(item => [item.ref, item]));
	const { candidates } = enumerateCandidates(prior, answer, known, [...prompt, ...answer], { fullQuotes: true });
	assert.equal(candidates.length, 1);
	assert.equal(candidates[0]?.source_kind, "user_answer");
	assert.equal(candidates[0]?.source_role, "user");
	assert.equal(candidates[0]?.antecedent_ref, prompt[0]?.ref);
	const result = deriveActs(prior, candidates, acts([candidates[0]!.id, "request"]), known, answer, new Map([[candidates[0]!.id, "Ship the adapter"]]));
	assert.equal(result.graph.nodes.filter(item => item.id.startsWith("actw")).length, 0);
});

test("act labels treat conversational user requests as new work instead of incidental id matches", () => {
	const prior = graph([
		node("root", null, "active", "Reliable work", "root-source"),
		node("oven", "root", "active", "Deploy and apply Oven ephemeral-slice cleanup", "oven-source"),
	], "oven");
	const request = event("user-request", "lead", "user", "2026-10-09T08:00:00.000Z", "Gonna need you to work out the kinks a lot better.");
	const result = deriveActs(prior, [candidate("c01", request.ref, "user", request.text!)], acts(["c01", "request"]), new Map([
		["root-source", event("root-source", "lead", "user", "2026-10-09T01:00:00.000Z")],
		["oven-source", event("oven-source", "lead", "assistant", "2026-10-09T02:00:00.000Z")],
		[request.ref, request],
	]), [request], new Map([["c01", "Work out the remaining kinks"]]));
	assert.equal(result.graph.nodes.find(node => node.id === result.graph.focus)?.label, "Work out the remaining kinks");
	assert.notEqual(result.graph.focus, "oven");
});

test("an empty refresh reorients stale focus to the latest unfinished work", () => {
	const prior = graph([
		node("root", null, "active", "Reliable work", "root-source"),
		node("oven", "root", "active", "Deploy and apply Oven ephemeral-slice cleanup", "oven-source"),
		node("reload-readiness", "root", "parked", "Confirm Mom is ready after reload", "latest-source", "Reload Mom before trusting the saved state."),
	], "oven");
	const known = new Map([
		["root-source", event("root-source", "lead", "user", "2026-10-09T01:00:00.000Z")],
		["oven-source", event("oven-source", "lead", "assistant", "2026-10-09T02:00:00.000Z")],
		["latest-source", event("latest-source", "lead", "assistant", "2026-10-09T07:00:00.000Z")],
	]);
	const result = deriveActs(prior, [], new Map(), known, []);
	assert.equal(result.graph.focus, "reload-readiness");
});

test("completion reports retain numeric native results as findings", () => {
	const prior = graph([
		node("root", null, "active", "Reliable work", "root-source"),
		node("pipeline", "root", "active", "Validate native pipeline", "pipeline-source"),
	], "pipeline");
	const report = event("report-source", "lead", "assistant", "2026-10-09T08:00:00.000Z", "The native run finished. 112/112 native oMLX checks passed across eight sessions.");
	const candidates = [
		{ ...candidate("c01", report.ref, "assistant", "The native run finished.", "pipeline"), kind: "note_add" as const },
		{ ...candidate("c02", report.ref, "assistant", "112/112 native oMLX checks passed across eight sessions."), kind: "note_add" as const },
	];
	const result = deriveActs(prior, candidates, acts(["c01", "report-of-completion"], ["c02", "answer"]), new Map([
		["root-source", event("root-source", "lead", "user", "2026-10-09T01:00:00.000Z")],
		["pipeline-source", event("pipeline-source", "lead", "assistant", "2026-10-09T02:00:00.000Z")],
		[report.ref, report],
	]), [report]);
	assert.ok(result.graph.nodes.some(node => node.kind === "observation" && /112\/112/.test(node.observed) && node.sources.includes(report.ref)));
});

test("stale-state complaints become a finding on the current work", () => {
	const prior = graph([
		node("root", null, "active", "Reliable work", "root-source"),
		node("oven", "root", "active", "Deploy and apply Oven ephemeral-slice cleanup", "oven-source"),
		node("reload-readiness", "root", "parked", "Confirm Mom is ready after reload", "latest-source"),
	], "oven");
	const complaint = event("complaint-source", "lead", "user", "2026-10-09T08:00:00.000Z", "I'm noticing on refresh the Mom state is quite old and dated. Still shows Oven cleanup.");
	const c = { ...candidate("c01", complaint.ref, "user", complaint.text!), kind: "note_add" as const };
	const result = deriveActs(prior, [c], acts(["c01", "other"]), new Map([
		["root-source", event("root-source", "lead", "user", "2026-10-09T01:00:00.000Z")],
		["oven-source", event("oven-source", "lead", "assistant", "2026-10-09T02:00:00.000Z")],
		["latest-source", event("latest-source", "lead", "assistant", "2026-10-09T07:00:00.000Z")],
		[complaint.ref, complaint],
	]), [complaint]);
	assert.equal(result.graph.focus, "reload-readiness");
	assert.ok(result.graph.nodes.some(node => node.kind === "observation" && /dated/.test(node.observed) && node.parent === "reload-readiness"));
});
