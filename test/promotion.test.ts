import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { provider, sandbox, harness } from "./fixture.ts";

test("human contribution promotes a Pi child; model steering does not promote", { timeout: 30000 }, async () => {
	const api = await provider();
	const box = sandbox(api.url);
	const h = await harness(box);
	try {
		api.script("Promotion seed", { text: "SEED-OK" });
		const started = await h.waitLaunch("Promotion seed");
		const run = h.state().runs.get(started.details.id);
		const original = run.sessionFile as string;
		assert.ok(original.startsWith(join(realpathSync(join(box.root, "parents")), "subsessions")), original);

		api.script("Agent continuation", { text: "AGENT-OK" });
		await h.ctl("steer", run.id, { message: "Agent continuation" });
		await h.ctl("wait", run.id);
		assert.equal(run.sessionFile, original, "model-authored steering does not promote");

		const owner = [...h.state().owners.values()].find((candidate: any) => candidate.binding);
		assert.equal(typeof owner?.live?.steer, "function");
		api.script("Human contribution", { text: "HUMAN-OK" });
		await owner.live.steer(run.id, "Human contribution");
		const done = await h.ctl("wait", run.id);
		assert.equal(done.details.status, "complete", done.content[0].text);
		assert.equal(done.details.output, "HUMAN-OK");
		assert.notEqual(run.sessionFile, original);
		assert.ok(run.sessionFile.startsWith(realpathSync(join(box.root, "parents")) + "/"), run.sessionFile);
		assert.equal(existsSync(original), false, "promotion removes the subsessions copy");
		assert.match(readFileSync(run.sessionFile, "utf8"), /Human contribution/);
		assert.equal(JSON.parse(readFileSync(run.recordPath, "utf8")).sessionFile, run.sessionFile);
	} finally {
		await h.runtime.dispose();
		await api.close();
		rmSync(box.root, { recursive: true, force: true });
	}
});
