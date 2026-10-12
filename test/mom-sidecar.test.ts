import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SidecarStore, sidecarFile } from "../src/mom/sidecar.ts";
import { mergeGlobals, readMomGlobals, writeMomGlobals } from "../src/mom/globals.ts";
import { writeSettings } from "../src/settings-file.ts";

test("loads an existing .mom record without rewriting it", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-delegate-mom-sidecar-old-"));
	const session = join(dir, "session.jsonl"), sessionId = "session-old";
	try {
		await writeFile(session, "{}\n");
		const raw = JSON.stringify({ id: "map-1", sessionId, type: "map", at: 42, data: { marker: "old" } }) + "\n";
		await writeFile(sidecarFile(session), raw);
		const store = new SidecarStore(() => session, sessionId);
		assert.deepEqual((await store.load()).map(record => record.data.marker), ["old"]);
		assert.equal(await readFile(sidecarFile(session), "utf8"), raw);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("Mom's controls are global: they live in one file in the agent dir, not in a session's sidecar", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-delegate-mom-globals-"));
	const file = join(dir, "pi-delegate.json");
	try {
		assert.deepEqual(readMomGlobals(file), {}, "no file yet reads as nothing saved");
		assert.deepEqual(await writeMomGlobals({ decider: "local-llm/beverly-4B" }, file), { decider: "local-llm/beverly-4B" });
		// A second save merges over the first, so one setting never wipes another.
		assert.deepEqual(await writeMomGlobals({ mode: "v2" }, file), { decider: "local-llm/beverly-4B", mode: "v2" });
		assert.deepEqual(readMomGlobals(file), { decider: "local-llm/beverly-4B", mode: "v2" });
		assert.equal(statSync(file).mode & 0o777, 0o600, "saved private");
		// Garbage is dropped field by field: one bad value must not stop Mom in every session.
		await writeFile(file, JSON.stringify({ mom: { mode: "nonsense", model: "not-a-provider-id", decider: "local-llm/beverly-4B", enabled: "yes", extra: 1 } }));
		assert.deepEqual(readMomGlobals(file), { decider: "local-llm/beverly-4B" });
		await writeFile(file, "{not json");
		assert.deepEqual(readMomGlobals(file), {});
		// A session's own older saved controls stay underneath the global file.
		assert.deepEqual(mergeGlobals({ mode: "v2" }, { mode: "commit_graph", enabled: false }), { mode: "v2", enabled: false });

		// One file, three sections, and no write drops another section's data.
		await rm(file, { force: true });
		await writeSettings({ defaults: { approved: { scout: { spec: "openai-codex/gpt-5.6-luna", approvedAt: 1 } }, catalogAtApproval: ["openai-codex/gpt-5.6-luna"] } }, file);
		await writeSettings({ ratings: { updatedAt: 2, entries: { "x/y": { score: 50, source: "test" } } } }, file);
		await writeSettings({ mom: { mode: "v2" } }, file);
		const all = JSON.parse(await readFile(file, "utf8"));
		assert.deepEqual(Object.keys(all).sort(), ["defaults", "mom", "ratings"]);
		assert.equal(all.defaults.approved.scout.spec, "openai-codex/gpt-5.6-luna", "an approved default survives a Mom write");
		assert.equal(all.ratings.entries["x/y"].score, 50, "a rating survives both");
		assert.equal(all.mom.mode, "v2");

		// The one file that did exist before this is folded in on the first write, so a default approved
		// earlier is not lost the moment anything else is saved.
		await rm(file, { force: true });
		await writeFile(join(dir, "delegate-models.json"), JSON.stringify({ approved: { reviewer: { spec: "openai-codex/gpt-6-astra", approvedAt: 3 } }, catalogAtApproval: [] }));
		await writeSettings({ mom: { mode: "commit_graph" } }, file);
		const migrated = JSON.parse(await readFile(file, "utf8"));
		assert.equal(migrated.defaults.approved.reviewer.spec, "openai-codex/gpt-6-astra", "the legacy default moved in");
		assert.equal(migrated.mom.mode, "commit_graph");
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("preserves the .mom path; a torn final record becomes one skipped line, never merged with the next record", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-delegate-mom-sidecar-"));
	const session = join(dir, "session.jsonl"), sessionId = "session-one";
	try {
		await writeFile(session, "{}\n");
		const initial = new SidecarStore(() => session, sessionId);
		await initial.append("usage", { marker: "durable" });
		const file = sidecarFile(session);
		assert.equal(file, join(dir, "session.mom"));
		await appendFile(file, Buffer.from('{"v":1,"id":"torn"'));
		const recovering = new SidecarStore(() => session, sessionId);
		assert.equal((await recovering.load()).length, 1);
		await recovering.append("map", { marker: "accepted" });
		assert.equal((await readFile(file)).at(-1), 0x0a);
		const reopened = new SidecarStore(() => session, sessionId);
		assert.deepEqual((await reopened.load()).map(record => record.type), ["usage", "map"]);
		assert.equal(reopened.skipped.length, 1, "the torn record is reported, not repaired by truncation");
		assert.match(await readFile(file, "utf8"), /"torn"\n\{/, "the torn line stays as written and the new record starts on its own line");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a corrupt complete line is skipped and reported; every other record still loads", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-delegate-mom-sidecar-"));
	const session = join(dir, "session.jsonl");
	try {
		await writeFile(session, "{}\n");
		const store = new SidecarStore(() => session, "session-one");
		await store.append("usage", { n: 1 });
		await appendFile(sidecarFile(session), "{not json}\n" + JSON.stringify({ id: "x", type: "map" }) + "\n");
		await store.append("map", { n: 2 });
		const reopened = new SidecarStore(() => session, "session-one");
		assert.deepEqual((await reopened.load()).map(record => record.type), ["usage", "map"]);
		assert.equal(reopened.skipped.length, 2);
		assert.match(reopened.skipped[0]!, /^line 2: /);
		assert.equal(reopened.skipped[1], "line 3: not a Mom record");
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("appends from several writers to one file are serialized: every record is a whole line", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-delegate-mom-sidecar-"));
	const session = join(dir, "session.jsonl");
	try {
		await writeFile(session, "{}\n");
		const big = "x".repeat(200_000);
		const writers = [0, 1, 2, 3].map(() => new SidecarStore(() => session, "session-one"));
		await Promise.all(writers.flatMap((writer, w) => [0, 1, 2, 3, 4].map(i => writer.append("usage", { w, i, big }))));
		const reopened = new SidecarStore(() => session, "session-one");
		assert.equal((await reopened.load()).length, 20);
		assert.deepEqual(reopened.skipped, []);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("a snapshot built from an older map never replaces a newer one; snapshots saved before bases existed still apply", async () => {
	const { loadState } = await import("../src/mom/checkpoint.ts");
	const { emptyGraph } = await import("../src/mom/graph.ts");
	const { fromWorkGraph, toWorkGraph } = await import("../src/mom/v2.ts");
	const snapshot = (label: string, parent: string) => ({ sessionId: "session", note: null, cut: { parent, workers: [] }, at: 1, model: "",
		graph: toWorkGraph({ focus: "ship", nodes: [{ id: "ship", parent: null, kind: "work", state: "active", label, sources: ["s:u1"] }] }, emptyGraph()) });
	const map = (id: string, data: Record<string, unknown>, at: number) => ({ id, sessionId: "session", type: "map" as const, at, data });
	const records = [
		map("r1", { snapshot: snapshot("A", "e1"), base: null }, 1),
		map("r2", { snapshot: snapshot("B", "e2"), base: "r1" }, 2),
		map("r3", { snapshot: snapshot("C", "e3"), base: "r1" }, 3),
		map("r4", { snapshot: snapshot("D", "e3") }, 4),
	];
	const read = (count: number) => loadState({ load: async () => records.slice(0, count), skipped: [] } as never, { getBranch: () => [{ id: "e1" }, { id: "e2" }, { id: "e3" }] } as never);
	const label = (state: Awaited<ReturnType<typeof read>>) => fromWorkGraph(state.checkpoint!.graph).nodes[0]!.label;
	assert.equal(label(await read(2)), "B");
	const stale = await read(3);
	assert.equal(label(stale), "B", "C was built from r1, so it must not replace r2's map");
	assert.equal(stale.checkpointId, "r2");
	assert.match(stale.skipped![0]!, /^map record r3: saved from an older map/);
	assert.equal(label(await read(4)), "D", "a snapshot with no base is a legacy one: taken as saved");
});

test("an unreadable record in her saved notes is skipped and reported, and the last good map stands", async () => {
	const { loadState } = await import("../src/mom/checkpoint.ts");
	const records = [
		{ id: "m1", sessionId: "session", type: "map" as const, at: 1, data: { model: "not a model id" } },
		{ id: "m2", sessionId: "session", type: "map" as const, at: 2, data: { snapshot: { nonsense: true } } },
		{ id: "m3", sessionId: "session", type: "map" as const, at: 3, data: { mode: "v2" } },
	];
	const state = await loadState({ load: async () => records, skipped: ["line 9: Unexpected token"] } as never, { getBranch: () => [] } as never);
	assert.equal(state.mode, "v2", "the records after a bad one still apply");
	assert.equal(state.skipped!.length, 3);
	assert.match(state.skipped![1]!, /^map record m1: Invalid Mom model/);
	assert.match(state.skipped![2]!, /^map record m2: Invalid Mom map snapshot/);
});
