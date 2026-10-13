import "./setup.ts";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { provider, sandbox, harness, OVEN_AVAILABLE, startOven } from "./fixture.ts";

const FLAGS = { "mom-model": "fixture/fixture", "mom-mode": "trail", "mom-interval-ms": "0", "mom-max-wait-ms": "0", "mom-retry-ms": "100,100,100" };
const skip = OVEN_AVAILABLE ? false : "Oven checkout unavailable; set OVEN_DIR.";

const textOf = (content: any): string => typeof content === "string" ? content : (content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
const until = async <T>(what: string, read: () => Promise<T | undefined>, context: () => unknown, ms = 15000) => {
	for (const deadline = Date.now() + ms; Date.now() < deadline; await new Promise(resolve => setTimeout(resolve, 25))) { const value = await read(); if (value) return value; }
	throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(context())}`);
};

test("the trail watcher reads each batch as delivered, answers with one record_waypoints call, and keeps its memory; a refresh is one call too", { timeout: 60000, skip }, async () => {
	const api = await provider(), box = sandbox(api.url);
	const daemon = await startOven(box.root, box.agentDir);
	const { TrailStore, trailFor } = await import("../src/trail/store.ts");
	let h: Awaited<ReturnType<typeof harness>> | undefined;
	// Every request Path's watcher made: its tools and what it was sent, newest last.
	const calls: { tools: string[]; last: string; all: string[] }[] = [];
	try {
		h = await harness(box, undefined, { flags: FLAGS });
		const first = "Does pstack cover how GrokBot's team built their own framework?", second = "Go deeper on the primitives.";
		api.script(first, { text: "Yes: Dune, their agent framework." });
		api.script(second, { text: "Dune's primitives are Feature, registry and host." });
		api.onUnscripted(request => {
			const tools: string[] = (request.tools ?? []).map((tool: any) => tool.function?.name);
			const users = (request.messages ?? []).filter((message: any) => message.role === "user").map((message: any) => textOf(message.content));
			const last: string = users.at(-1) ?? "";
			calls.push({ tools, last, all: users });
			if (last.startsWith("Refresh")) {
				// The goal carries the user's words; the refresh titles it from them.
				const goal = last.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line)).find((entry: any) => entry.kind === "set_out");
				return { tool: { name: "record_waypoints", arguments: { waypoints: [], revise: JSON.stringify([{ id: goal.id, title: "Pstack on GrokBot's framework" }]) } } };
			}
			const userLine = last.split("\n").find(line => / user: /.test(line));
			if (!last.startsWith("New entries") || !userLine) return { tool: { name: "record_waypoints", arguments: { waypoints: [] } } };
			const id = userLine.replace(/^- /, "").split(" ")[0];
			return { tool: { name: "record_waypoints", arguments: { waypoints: userLine.includes(first.slice(0, 20))
				? [{ kind: "set_out", line: "Pstack framework analysis", refs: [id], title: "Analyze Dune framework", caption: "Find whether pstack covers GrokBot's own framework." }]
				: [{ kind: "decided", line: "Pstack framework analysis", refs: [id], title: "Primitives in depth", caption: "Go deeper on Dune's primitives." }] } } };
		});
		const manager = h.runtime.session.sessionManager, sessionId = manager.getSessionId();
		const context = () => ({ errors: api.errors, calls: calls.map(call => ({ tools: call.tools, last: call.last.slice(0, 80) })), extensionErrors: h!.errors });
		const read = async () => trailFor(await new TrailStore(() => h!.parent, sessionId).load(), new Set(manager.getBranch().map((entry: any) => entry.id)));

		await h.runtime.session.prompt(first);
		const opened = await until("the set_out", async () => { const t = await read(); return t.waypoints.find(w => w.kind === "set_out"); }, context);
		const userEntry = manager.getBranch().find((entry: any) => entry.type === "message" && entry.message.role === "user")!;
		assert.deepEqual(opened.refs, [`${sessionId}:${userEntry.id}`], "an entry id as delivered is recorded as its ref");
		const watcher = calls.filter(call => call.tools.length);
		assert.ok(watcher.every(call => call.tools.join() === "record_waypoints"), "its one tool");
		assert.ok(!watcher.some(call => call.tools.includes("mom_begin")), "no handshake");

		await h.runtime.session.prompt(second);
		await until("the decided", async () => (await read()).waypoints.some(w => w.kind === "decided") ? true : undefined, context);
		const later = calls.filter(call => call.last.startsWith("New entries") && call.last.includes(second.slice(0, 15))).at(-1)!;
		assert.ok(later.all.some(text => text.includes(first.slice(0, 20))), "it still holds the first batch: its memory is kept");

		const notifications: string[] = [];
		const interactive = { ...h.ctx(), ui: { ...h.ctx().ui, notify: (text: string) => { notifications.push(text); } } };
		const before = calls.length;
		await h.commands.get("path").handler("refresh", interactive);
		const refreshes = calls.slice(before).filter(call => call.last.startsWith("Refresh"));
		assert.equal(refreshes.length, 1, "a refresh is one call");
		assert.match(refreshes[0]!.last, new RegExp(`"said":"${first.slice(0, 20)}`), "the goal is shown with the user's words");
		const trail = await read();
		assert.equal(trail.waypoints.find(w => w.kind === "set_out")!.title, "Pstack on GrokBot's framework", "titled from what was asked");
		assert.match(notifications.at(-1)!, /^Path: refreshed/);

		// /path opens the view on the same trail the widget reads: its Trail tab lists every entry.
		const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text, bg: (_: string, text: string) => text, dim: (text: string) => text, italic: (text: string) => text };
		let screen = (_key?: string) => "", closed = () => {};
		const viewing = h.commands.get("path").handler("", { ...interactive, mode: "tui", ui: { ...interactive.ui, custom: (factory: any) => new Promise<void>(resolve => {
			const component = factory({ terminal: { rows: 30, columns: 120 }, requestRender() {} }, theme, {}, () => resolve());
			screen = (key?: string) => { if (key) component.handleInput(key); return component.render(120).join("\n").replace(/\x1b\[[0-9;]*m/g, ""); };
			closed = () => resolve();
		}) } });
		await until("the view", async () => screen() ? true : undefined, context);
		const tab = screen("\x1bOQ"); // F2
		assert.doesNotMatch(tab, /Nothing on the trail yet/);
		assert.match(tab, /Find whether pstack covers GrokBot's own framework/, "the goal");
		assert.match(tab, /Go deeper on Dune's primitives/, "and the step after it");
		closed(); await viewing;
		assert.deepEqual(h.errors, []);
		assert.deepEqual(api.errors, []);
	} finally {
		await h?.runtime.dispose(); await daemon.stop(); await api.close(); rmSync(box.root, { recursive: true, force: true });
	}
});
