import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync } from "node:fs";
import {
	LEGACY_TODO_CUSTOM_TYPE,
	TODO_CUSTOM_TYPE,
	TODO_WIDGET_KEY,
	installTodo,
	loadState,
} from "../src/todo-ext.ts";
import type { TodoStyler } from "../src/todo-render.ts";

const plainTheme: TodoStyler = {
	fg: (_color, text) => text,
	bold: (text) => text,
	strikethrough: (text) => text,
};

type WidgetRecord = { key: string; content: ((tui: unknown, theme: TodoStyler) => { render(width: number): string[] }) | undefined; options?: unknown };

interface Harness {
	tools: Map<string, any>;
	commands: Map<string, any>;
	entries: { type: string; customType: string; data: unknown }[];
	widgets: WidgetRecord[];
	notices: { message: string; level: string }[];
	sent: string[];
	fire: (event: string, payload: unknown, ctx?: unknown) => void;
	ui: { setWidget: (key: string, content: WidgetRecord["content"], options?: unknown) => void; notify: (message: string, level: string) => void };
	ctx: (branch?: unknown[]) => any;
}

function harness(options: Parameters<typeof installTodo>[1] = {}): Harness {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const entries: Harness["entries"] = [];
	const widgets: WidgetRecord[] = [];
	const notices: Harness["notices"] = [];
	const sent: string[] = [];

	const pi = {
		registerTool: (tool: any) => void tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => void commands.set(name, command),
		on: (event: string, handler: (event: any, ctx: any) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		appendEntry: (customType: string, data: unknown) => void entries.push({ type: "custom", customType, data }),
		sendUserMessage: (content: string) => void sent.push(content),
	};
	installTodo(pi as unknown as ExtensionAPI, options);

	const ui = {
		setWidget: (key: string, content: WidgetRecord["content"], options?: unknown) => void widgets.push({ key, content, options }),
		notify: (message: string, level: string) => void notices.push({ message, level }),
	};
	return {
		tools,
		commands,
		entries,
		widgets,
		notices,
		sent,
		ui,
		ctx: (branch: unknown[] = entries) => ({ sessionManager: { getBranch: () => branch }, ui, cwd: "/tmp", mode: "tui" }),
		fire: (event, payload, ctx) => {
			for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
		},
	};
}

const widgetLines = (record: WidgetRecord | undefined, width = 80) =>
	record?.content?.(undefined, plainTheme).render(width) ?? [];

test("installs exactly one todo tool and one todo command", () => {
	const h = harness();
	assert.equal(h.tools.size, 1);
	assert.ok(h.tools.has("todo"));
	assert.equal(h.tools.get("todo").executionMode, "sequential");
	assert.equal(h.tools.get("todo").renderShell, "self");
	assert.deepEqual([...h.commands.keys()], ["todo"]);
});

test("tool drives the widget, restores it on session navigation, and clears when done", async () => {
	const h = harness();
	const tool = h.tools.get("todo");
	const ctx = h.ctx();

	const added = await tool.execute(
		"todo-1",
		{ op: "add", phase: "Research", content: "Keep the current task visible" },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(h.entries.at(-1)?.customType, TODO_CUSTOM_TYPE);
	assert.equal(h.widgets.at(-1)?.key, TODO_WIDGET_KEY);
	assert.deepEqual(h.widgets.at(-1)?.options, { placement: "aboveEditor" });
	assert.ok(widgetLines(h.widgets.at(-1)).some((line) => line.includes("☐ Keep the current task visible")));

	const compact = tool.renderResult(added, { expanded: false }, plainTheme, { isError: false }).render(80).join("\n");
	assert.ok(compact.includes("☑ Todo 1 task"));
	assert.ok(compact.includes("└─ ☐ Keep the current task visible"));
	const expanded = tool.renderResult(added, { expanded: true }, plainTheme, { isError: false }).render(80).join("\n");
	assert.ok(expanded.includes("☑ Todo 1 task"));

	h.fire("session_start", { type: "session_start" }, ctx);
	h.fire("session_tree", { type: "session_tree" }, ctx);
	assert.equal(h.widgets.filter((w) => w.content !== undefined).length, 3);

	// Branch navigation to a sibling branch that still carries legacy pi-omp state.
	const legacy = [{ type: "custom", customType: LEGACY_TODO_CUSTOM_TYPE, data: { phases: [{ name: "Sibling", tasks: [{ content: "Use sibling task", status: "pending" }] }] } }];
	h.fire("session_tree", { type: "session_tree" }, h.ctx(legacy));
	assert.ok(widgetLines(h.widgets.at(-1)).some((line) => line.includes("☐ Use sibling task")));

	await tool.execute("todo-2", { op: "done", content: "Keep the current task visible" }, undefined, undefined, ctx);
	assert.deepEqual(h.widgets.at(-1), { key: TODO_WIDGET_KEY, content: undefined, options: undefined });
	const completion = tool.renderResult(
		await tool.execute("todo-3", { op: "view" }, undefined, undefined, ctx),
		{ expanded: false },
		plainTheme,
		{ isError: false },
	)
		.render(80)
		.join("\n");
	assert.ok(completion.includes("☑ Todo 1 task"));
	assert.ok(completion.includes("☑ Keep the current task visible"));
});

test("loadState prefers delegate entries, falls back to legacy pi-omp, skips malformed input", () => {
	const legacy = { type: "custom", customType: LEGACY_TODO_CUSTOM_TYPE, data: { phases: [{ name: "Old", tasks: [{ content: "from omp", status: "pending" }] }] } };
	const own = { type: "custom", customType: TODO_CUSTOM_TYPE, data: { phases: [{ name: "New", tasks: [{ content: "from delegate", status: "pending" }] }] } };
	const junk = { type: "custom", customType: TODO_CUSTOM_TYPE, data: { phases: "corrupt" } };

	assert.deepEqual(loadState({ getBranch: () => [legacy] }).phases[0]!.tasks[0]!.content, "from omp");
	// A delegate write always wins over an older legacy entry.
	assert.deepEqual(loadState({ getBranch: () => [legacy, own] }).phases[0]!.tasks[0]!.content, "from delegate");
	// A corrupt delegate entry must not hide usable legacy state behind it.
	assert.deepEqual(loadState({ getBranch: () => [legacy, junk] }).phases[0]!.tasks[0]!.content, "from omp");
	assert.deepEqual(loadState({ getBranch: () => [junk] }), { phases: [] });
	assert.deepEqual(loadState({ getBranch: () => [] }), { phases: [] });
});

test("malformed tool input degrades to an error component instead of throwing", async () => {
	const h = harness();
	const tool = h.tools.get("todo");
	const ctx = { sessionManager: { getBranch: () => [{ type: "custom", customType: TODO_CUSTOM_TYPE, data: { phases: "corrupt" } }] }, ui: h.ui, cwd: "/tmp" };
	const result = await tool.execute("todo-bad", { op: "view" }, undefined, undefined, ctx);
	assert.equal(result.details.open, 0);
	const rendered = tool.renderResult(result, { expanded: false }, plainTheme, { isError: false }).render(80).join("\n");
	assert.ok(rendered.includes("☑ Todo 0 tasks"));
});

test("/todo command edits state, exports and imports Markdown", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-delegate-todo-"));
	try {
		const h = harness();
		const command = h.commands.get("todo");
		const ctx = { ...h.ctx(), cwd: dir };

		await command.handler("add Ship the transfer", ctx);
		assert.equal(h.entries.at(-1)?.customType, TODO_CUSTOM_TYPE);
		assert.deepEqual(h.widgets.at(-1)?.key, TODO_WIDGET_KEY);
		assert.ok(h.notices.at(-1)!.message.includes("Added: Ship the transfer"));

		await command.handler("", ctx);
		assert.ok(h.notices.at(-1)!.message.includes("Todos: 1 open across 1 phase(s)."));

		await command.handler("export", ctx);
		const target = join(dir, "TODO.md");
		assert.equal(readFileSync(target, "utf8"), "# Tasks\n- [ ] Ship the transfer");

		await command.handler("done Ship the transfer", ctx);
		assert.deepEqual(h.widgets.at(-1), { key: TODO_WIDGET_KEY, content: undefined, options: undefined });

		await command.handler("import", ctx);
		assert.equal(h.notices.at(-1)!.message.includes("Imported 1 open tasks"), true);
		assert.equal(loadState(ctx.sessionManager).phases[0]!.tasks[0]!.content, "Ship the transfer");

		writeFileSync(target, "# From file\n- [/] Halfway there\n");
		await command.handler(`import ${target}`, ctx);
		assert.equal(loadState(ctx.sessionManager).phases[0]!.tasks[0]!.status, "in_progress");

		await command.handler("add", ctx);
		assert.equal(h.notices.at(-1)!.level, "warning");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

function todoBranch() {
	return [{ type: "custom", customType: TODO_CUSTOM_TYPE, data: { phases: [{ name: "Work", tasks: [{ content: "Finish the thing", status: "pending" }] }] } }];
}

function agentEnd(stopReason: string, text: string) {
	return {
		type: "agent_end",
		messages: [{ role: "assistant", content: [{ type: "text", text }], stopReason }],
	};
}

test("reminder fires once on a natural stop with open todos", () => {
	const h = harness();
	h.fire("agent_end", agentEnd("stop", "working on it"), h.ctx(todoBranch()));
	assert.equal(h.sent.length, 1);
	assert.ok(h.sent[0]!.includes("1 open todo item"));
});

test("reminder is suppressed by abort, an open question, active jobs, and its cap", () => {
	// Escape settles the turn: never auto-restart it with a reminder.
	const aborted = harness();
	aborted.fire("agent_end", agentEnd("aborted", "stopped"), aborted.ctx(todoBranch()));
	assert.deepEqual(aborted.sent, []);

	// A late abort signal can arrive even when the final assistant message says stop.
	const lateAbort = harness();
	const controller = new AbortController();
	controller.abort();
	lateAbort.fire("agent_end", agentEnd("stop", "stopped"), { ...lateAbort.ctx(todoBranch()), signal: controller.signal });
	assert.deepEqual(lateAbort.sent, []);

	// The model asked the user something — the ball is in the human's court.
	const asked = harness();
	asked.fire("agent_end", agentEnd("stop", "Which provider should I use?"), asked.ctx(todoBranch()));
	assert.deepEqual(asked.sent, []);

	// A background delegate child will wake the parent anyway.
	const busy = harness({ hasActiveJobs: () => true });
	busy.fire("agent_end", agentEnd("stop", "done for now"), busy.ctx(todoBranch()));
	assert.deepEqual(busy.sent, []);
});

test("reminder waits for model progress and stops at the cap", () => {
	const h = harness({ maxReminders: 2 });
	const ctx = h.ctx(todoBranch());
	const stop = () => h.fire("agent_end", agentEnd("stop", "stopped with work open"), ctx);

	stop();
	assert.equal(h.sent.length, 1);

	// Still waiting on the model to act on reminder #1: no second nag.
	stop();
	assert.equal(h.sent.length, 1);

	// Any tool result means the model acted; a later stop may remind again.
	h.fire("message_end", { type: "message_end", message: { role: "toolResult" } }, ctx);
	stop();
	assert.equal(h.sent.length, 2);

	// Cap spent.
	h.fire("message_end", { type: "message_end", message: { role: "toolResult" } }, ctx);
	stop();
	assert.equal(h.sent.length, 2);
});

test("an empty todo list resets the reminder budget", () => {
	const h = harness({ maxReminders: 1 });
	const ctx = h.ctx(todoBranch());
	h.fire("agent_end", agentEnd("stop", "stopped"), ctx);
	assert.equal(h.sent.length, 1);
	h.fire("agent_end", agentEnd("stop", "stopped again"), ctx);
	assert.equal(h.sent.length, 1);

	// Everything is done → nothing to nag about, and the budget comes back.
	const cleared = [{ type: "custom", customType: TODO_CUSTOM_TYPE, data: { phases: [{ name: "Work", tasks: [{ content: "Finish the thing", status: "completed" }] }] } }];
	h.fire("agent_end", agentEnd("stop", "all clear"), h.ctx(cleared));
	assert.equal(h.sent.length, 1);

	h.fire("agent_end", agentEnd("stop", "stopped"), ctx);
	assert.equal(h.sent.length, 2);
});

test("pi-omp no longer registers a todo tool or command (both extensions may be installed)", () => {
	const extensionsDir = new URL("../../pi-omp/extensions/", import.meta.url);
	if (!existsSync(extensionsDir)) return; // standalone checkout of pi-delegate alone
	for (const file of readdirSync(extensionsDir)) {
		if (!file.endsWith(".ts")) continue;
		const source = readFileSync(join(extensionsDir.pathname, file), "utf8");
		assert.ok(!/name:\s*"todo"/.test(source), `${file} still registers a todo tool`);
		assert.ok(!/registerCommand\(\s*"todo"/.test(source), `${file} still registers a /todo command`);
		assert.ok(!/pi_omp\.todo/.test(source), `${file} still owns the pi_omp.todo namespace`);
	}
});
