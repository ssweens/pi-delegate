import "./setup.ts"; // First: isolates this file from the real home even when run on its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { rmSync } from "node:fs";
import { provider, sandbox, harness } from "./fixture.ts";

const text = (content: any) => typeof content === "string" ? content : (content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
const lastUser = (request: any) => text(request.messages.findLast((m: any) => m.role === "user")?.content);
const system = (request: any) => text(request.messages.find((m: any) => m.role === "system" || m.role === "developer")?.content);

test("every child sees the plan-conflict rule first, including a role that brings its own STATUS contract (real SDK, loopback provider)", { timeout: 60000 }, async () => {
	const api = await provider();
	const box = sandbox(api.url);
	const h = await harness(box);
	api.onUnscripted((request) => ({ text: `DONE ${lastUser(request)}` }));
	try {
		for (const role of ["worker", "scout"]) {
			const task = `Plan rule for ${role}`;
			const done = await h.waitLaunch(task, { role });
			assert.equal(done.details.status, "complete", done.content[0].text);
			const seen = api.requests.filter((request) => lastUser(request).includes(task)).map(system);
			assert.ok(seen.length, `${role}: the child reached the model`);
			for (const prompt of seen) assert.match(prompt, /^## Plan conflicts come first\n/, `${role}: the rule leads the child's system prompt`);
		}
	} finally {
		api.onUnscripted();
		await h.runtime.session.agent.waitForIdle();
		await h.runtime.dispose();
		await api.close();
		rmSync(box.root, { recursive: true, force: true });
	}
});
