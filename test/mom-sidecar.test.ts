import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SidecarStore, sidecarFile } from "../src/mom/sidecar.ts";

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
