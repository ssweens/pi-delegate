import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, provider, sandbox } from "./fixture.ts";

test("a long budget without FIRST DELIVERABLE / STOP WHEN warns; with one, or a short budget, it does not", { timeout: 60_000 }, async () => {
	const api = await provider();
	const h = await harness(sandbox(api.url));
	const warning = /Warning: a long budget with no FIRST DELIVERABLE \/ STOP WHEN line/;
	const min = 60_000;
	try {
		const text = async (task: string, timeoutMs: number) => {
			api.script(task, { text: "ok" });
			const r = await h.launch(task, { timeoutMs });
			await h.ctl("wait", r.details.id);
			return r.content[0].text as string;
		};
		const long = await text("Long open run", 31 * min);
		assert.match(long, warning);
		assert.match(long, /ends \d\d:\d\d \(3[01] min left\)/, "the launch reply names the end time");
		assert.doesNotMatch(await text("Short run", 10 * min), warning);
		assert.doesNotMatch(await text("Long run\nFIRST DELIVERABLE: a plan in 10 min", 31 * min), warning);
		assert.doesNotMatch(await text("Long run\nSTOP WHEN: tests pass", 31 * min), warning);
	} finally { await h.runtime.dispose(); await api.close(); }
});
