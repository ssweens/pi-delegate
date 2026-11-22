import "./setup.ts"; // First: isolates this file from the real home even when run on its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { provider, sandbox, harness } from "./fixture.ts";
import { storagePathForManager } from "../src/storage.js";

test("a child in another cwd leaves the project clean: run state uses the configured session directory", { timeout: 30000 }, async () => {
	const api = await provider();
	const box = sandbox(api.url);
	const workspace = join(box.root, "workspace");
	mkdirSync(workspace, { recursive: true });
	const h = await harness(box);
	try {
		api.script("Work elsewhere", { text: "ELSEWHERE-OK" });
		const result = await h.waitLaunch("Work elsewhere", { cwd: workspace });
		assert.equal(result.details.status, "complete", result.content[0].text);
		assert.equal(existsSync(join(workspace, ".agents")), false, "the child's cwd stays clean");
		const run = h.state().runs.get(result.details.id);
		const parentStore = storagePathForManager(h.ctx().sessionManager);
		assert.ok(run.recordPath.startsWith(parentStore), run.recordPath);
		assert.ok(run.sessionFile.startsWith(parentStore), run.sessionFile);
		assert.equal(JSON.parse(readFileSync(run.sessionFile, "utf8").split("\n")[0]).cwd, realpathSync(workspace), "the child still runs in its own cwd");
	} finally {
		await h.runtime.dispose();
		await api.close();
	}
});
