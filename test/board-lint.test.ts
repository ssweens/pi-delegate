import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { clock } from "../src/health.ts";
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
		assert.match(long, /firstDeliverableMin \(minutes until the first file is due\)/, "the warning names the parameter");
		assert.match(long, /ends \d\d:\d\d \(3[01] min left\)/, "the launch reply names the end time");
		assert.doesNotMatch(await text("Short run", 10 * min), warning);
		assert.doesNotMatch(await text("Long run\nFIRST DELIVERABLE: a plan in 10 min", 31 * min), warning);
		assert.doesNotMatch(await text("Long run\nSTOP WHEN: tests pass", 31 * min), warning);
	} finally { await h.runtime.dispose(); await api.close(); }
});

test("the launch reply names the first deliverable's time: a writer's default, a set value, none for a reader", { timeout: 60_000 }, async () => {
	const api = await provider();
	const h = await harness(sandbox(api.url));
	const min = 60_000;
	try {
		/** The reply, and the due times it may name for `dueMs` after launch (the minute can turn during the call). */
		const launch = async (task: string, extra: Record<string, unknown>, dueMs: number) => {
			api.script(task, { text: "ok" });
			const before = Date.now();
			const r = await h.launch(task, extra);
			const after = Date.now();
			if (!r.isError) await h.ctl("wait", r.details.id);
			return { text: r.content[0].text as string, due: new Set([clock(before + dueMs), clock(after + dueMs)]) };
		};
		const dueIn = (text: string) => /, first deliverable due (\d\d:\d\d)\. /.exec(text)?.[1];

		const reader = await launch("Reader", { timeoutMs: 60 * min }, 0);
		assert.equal(dueIn(reader.text), undefined, "a reader has no deadline unless the call sets one");
		const readerSet = await launch("Reader with a deadline", { timeoutMs: 60 * min, firstDeliverableMin: 7 }, 7 * min);
		assert.ok(readerSet.due.has(dueIn(readerSet.text)!), readerSet.text);
		const writer = await launch("Writer", { role: "worker", timeoutMs: 20 * min }, 6 * min);
		assert.ok(writer.due.has(dueIn(writer.text)!), `6 min floor of 20 min: ${writer.text}`);
		const longWriter = await launch("Long writer", { role: "worker", timeoutMs: 120 * min }, 15 * min);
		assert.ok(longWriter.due.has(dueIn(longWriter.text)!), `15 min cap: ${longWriter.text}`);

		// The role's default budget (15 min) is known only at launch.
		const late = await launch("Late deadline", { firstDeliverableMin: 15 }, 0);
		assert.equal(late.text, "INPUT_INVALID: firstDeliverableMin (15 min) must be before the timeout (15 min)");
	} finally { await h.runtime.dispose(); await api.close(); }
});
