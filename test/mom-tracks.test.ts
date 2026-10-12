import "./setup.ts";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadState, type Checkpoint } from "../src/mom/checkpoint.ts";
import { emptyGraph } from "../src/mom/graph.ts";
import { writeMomGlobals } from "../src/mom/globals.ts";
import { SidecarStore, sidecarFile, type SidecarRecord } from "../src/mom/sidecar.ts";
import { settingsFile } from "../src/settings-file.ts";

const cut = (parent: string | null) => ({ parent, workers: [] });
const reader = { getBranch: () => [{ id: "e1" }, { id: "e2" }, { id: "e3" }] } as never;
const checkpoint = (parent: string): Checkpoint => ({ sessionId: "s", graph: emptyGraph(), note: null, cut: cut(parent), at: 1, model: "" });
const rec = (id: string, at: number, data: Record<string, unknown>): SidecarRecord => ({ id, sessionId: "s", type: "map", at, data }) as SidecarRecord;
const memory = (records: SidecarRecord[]) => ({ load: async () => records }) as never;

async function withGlobals<T>(globals: Record<string, unknown> | undefined, run: () => Promise<T>): Promise<T> {
	const file = settingsFile();
	await rm(file, { force: true });
	if (globals) await writeMomGlobals(globals as never, file);
	try { return await run(); } finally { await rm(file, { force: true }); }
}

test("a graph-indexed session switched to trail starts the trail empty; the graph keeps its own coverage", () => withGlobals({ mode: "commit_graph" }, async () => {
	const records = [rec("snap", 1, { snapshot: checkpoint("e1"), base: null }), rec("cur", 2, { base: "snap", cut: cut("e2"), failure: null })];
	const graph = await loadState(memory(records), reader);
	assert.equal(graph.checkpointId, "snap");
	assert.equal(graph.coverageCut?.parent, "e2");
	assert.equal(graph.track, "graph");
	const trail = await loadState(memory(records), reader, { mode: "trail" });
	assert.equal(trail.checkpointId, undefined);
	assert.equal(trail.checkpoint, undefined);
	assert.equal(trail.coverageCut, undefined);
	assert.equal(trail.track, "trail");
	assert.equal(trail.mode, "commit_graph", "options.mode only selects the track, never the controls");
}));

test("trail cursors form their own track: trail mode follows them, graph mode ignores them", () => withGlobals({ mode: "commit_graph" }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-delegate-mom-tracks-"));
	const session = join(dir, "session.jsonl");
	try {
		await writeFile(session, "{}\n");
		const store = new SidecarStore(() => session, "s");
		await store.append("map", { snapshot: checkpoint("e1"), base: null }, "snap");
		await loadState(store, reader, { mode: "trail" }); // sets the store's track
		assert.equal(store.track, "trail");
		const written = await store.append("map", { base: null, cut: cut("e3"), failure: null }, "t1");
		assert.equal(written.data.trail, true);
		const trail = await loadState(new SidecarStore(() => session, "s"), reader, { mode: "trail" });
		assert.equal(trail.coverageCut?.parent, "e3");
		assert.equal(trail.checkpointId, undefined);
		const fresh = new SidecarStore(() => session, "s");
		const graph = await loadState(fresh, reader);
		assert.equal(fresh.track, "graph");
		assert.equal(graph.checkpointId, "snap");
		assert.equal(graph.coverageCut?.parent, "e1", "the trail cursor did not move the graph's coverage");
		assert.equal(graph.skipped, undefined);
	} finally { await rm(dir, { recursive: true, force: true }); }
}));

test("control fields on a record from the other track still apply", () => withGlobals(undefined, async () => {
	const records = [rec("a", 1, { trail: true, cut: cut("e1"), base: null, mode: "v2" })];
	const graph = await loadState(memory(records), reader, { mode: "commit_graph" });
	assert.equal(graph.coverageCut, undefined);
	assert.equal(graph.mode, "v2");
	assert.equal(graph.skipped, undefined);
}));

test("legacy: with no snapshots, an unmarked base-null cursor counts for the trail", () => withGlobals(undefined, async () => {
	const legacy = [rec("c", 1, { base: null, cut: cut("e2"), failure: null })];
	assert.equal((await loadState(memory(legacy), reader, { mode: "trail" })).coverageCut?.parent, "e2");
	const withSnapshot = [rec("s", 1, { snapshot: checkpoint("e1"), base: null }), ...legacy.map(r => ({ ...r, at: 2 }))];
	assert.equal((await loadState(memory(withSnapshot), reader, { mode: "trail" })).coverageCut, undefined, "a graph sidecar's unmarked records stay graph");
}));

test("the track follows the globals mode when the caller passes none", () => withGlobals({ mode: "trail" }, async () => {
	const records = [rec("snap", 1, { snapshot: checkpoint("e1"), base: null })];
	const state = await loadState(memory(records), reader);
	assert.equal(state.track, "trail");
	assert.equal(state.checkpointId, undefined);
}));

test("SidecarStore marks map records only on the trail track", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-delegate-mom-tracks-"));
	const session = join(dir, "session.jsonl");
	try {
		await writeFile(session, "{}\n");
		const store = new SidecarStore(() => session, "s");
		assert.equal((await store.append("map", { cut: cut("e1"), base: null })).data.trail, undefined);
		store.track = "trail";
		assert.equal((await store.append("map", { cut: cut("e2"), base: null })).data.trail, true);
		assert.equal((await store.append("usage", { usage: {}, error: null })).data.trail, undefined);
		assert.ok(sidecarFile(session));
	} finally { await rm(dir, { recursive: true, force: true }); }
});
