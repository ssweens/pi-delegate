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

test("preserves the .mom path and recovers a torn final record before append", async () => {
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
		assert.deepEqual((await new SidecarStore(() => session, sessionId).load()).map(record => record.type), ["usage", "map"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
