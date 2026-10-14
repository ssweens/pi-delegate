import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { AgentsPanel, type LiveSource } from "../src/inspector.ts";
import type { RunView } from "../src/render.ts";
import { delegateRows, recapRows, todoRows } from "../src/ui/delegate-settings.ts";
import { SettingsPanel } from "../src/ui/settings-panel.ts";
import { DEFAULT_DELEGATE_SETTINGS, type DelegateSettings } from "../src/delegate-settings.ts";
import { DEFAULT_TODO_SETTINGS, type TodoSettings } from "../src/todo-settings.ts";
import { DEFAULT_RECAP_SETTINGS, type RecapSettings } from "../src/recap-settings.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
const LEFT = "\x1b[D", RIGHT = "\x1b[C", DOWN = "\x1b[B", ESC = "\x1b", ENTER = "\r";

const run = (id: string, extra: Partial<RunView> = {}): RunView => ({
	id, segment: 1, stopped: false, settled: false, role: "scout", model: "fixture/fixture", cwd: "/tmp", thinking: "", context: "fresh",
	status: "running", task: id, output: "", turns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0,
	durationMs: 1000, changedFiles: [], droppedTools: [], toolCalls: [], revision: 0, depth: 1, ...extra,
} as RunView);

function fakeTui(editor: { text: string; cursor: { line: number; col: number }; autocomplete?: boolean }) {
	const listeners: ((data: string) => { consume?: boolean } | undefined)[] = [];
	const editorComponent = { render: () => [], invalidate() {}, getText: () => editor.text, getCursor: () => editor.cursor, isShowingAutocomplete: () => Boolean(editor.autocomplete) };
	let focused: Component | null = editorComponent;
	const tui = {
		terminal: { rows: 40, columns: 120 },
		addInputListener: (listener: any) => { listeners.push(listener); return () => {}; },
		hasOverlay: () => false,
		requestRender() {},
		// As Pi's TUI does: the focus flag moves with focus.
		setFocus: (component: Component | null) => { if (focused) (focused as any).focused = false; focused = component; if (component) (component as any).focused = true; },
		getFocusedComponent: () => focused,
	};
	/** A key as the terminal delivers it: input listeners first, then the focused component. */
	const press = (data: string) => {
		for (const listener of listeners) if (listener(data)?.consume) return true;
		(focused as any)?.handleInput?.(data);
		return false;
	};
	return { tui: tui as any, press, focused: () => focused, editorComponent };
}

function source(rows: RunView[]): LiveSource & { opened: string[] } {
	const opened: string[] = [];
	return { opened, all: () => rows, activity: () => ({ messages: [], activeTools: new Map() }) as any, subscribe: () => () => {}, steer: async () => {}, cancel: async () => {} };
}

test("← at the very start of the draft enters the agents list; anywhere else it stays the editor's", () => {
	const editor = { text: "draft", cursor: { line: 0, col: 3 } };
	const { tui, press, focused, editorComponent } = fakeTui(editor);
	const panel = new AgentsPanel(source([run("a")]), theme, tui, async () => {});
	assert.equal(press(LEFT), false, "mid-draft ← moves the cursor");
	assert.equal(focused(), editorComponent);
	editor.cursor = { line: 0, col: 0 }; (editor as any).autocomplete = true;
	assert.equal(press(LEFT), false, "not while a completion menu is open");
	(editor as any).autocomplete = false;
	assert.equal(press(LEFT), true);
	assert.equal(focused(), panel, "the list has focus");
	assert.equal(panel.focused, true);
	press(LEFT);
	assert.equal(focused(), editorComponent, "← again returns to the editor");
	panel.dispose();
});

test("→ opens the selected child, and the list keeps focus when the child view closes", async () => {
	const opened: string[] = [];
	const { tui, press, focused } = fakeTui({ text: "", cursor: { line: 0, col: 0 } });
	let close!: () => void;
	const panel = new AgentsPanel(source([run("a"), run("b")]), theme, tui, (id) => { opened.push(id); return new Promise<void>((resolve) => { close = resolve; }); });
	press(LEFT); press(DOWN); press(RIGHT);
	assert.deepEqual(opened, ["b"]);
	close(); await new Promise((resolve) => setImmediate(resolve));
	assert.equal(focused(), panel, "back in the list, so ← and → keep walking");
	press(ESC);
	assert.notEqual(focused(), panel);
	panel.dispose();
});

test("runs a child started are indented under it, and settled runs stay until the next prompt", () => {
	const now = Date.now();
	const rows = [run("parent-run", { task: "Coordinate" }), run("grandchild", { task: "Nested scout", depth: 2, parentRunId: "parent-run" }),
		run("done", { task: "Finished scout", settled: true, status: "complete", endedAt: now })];
	const { tui } = fakeTui({ text: "", cursor: { line: 0, col: 0 } });
	const panel = new AgentsPanel(source(rows), theme, tui, async () => {});
	const lines = panel.renderSection(100);
	assert.match(lines[0]!, /Agents · 2 active · 1 done/);
	assert.match(lines.find((l) => l.includes("Nested scout"))!, /└ /, "a grandchild is drawn under its parent");
	assert.match(lines.find((l) => l.includes("Finished scout"))!, /complete/);
	panel.hideSettledBefore(now + 1);
	const after = panel.renderSection(100);
	assert.match(after[0]!, /Agents · 2 active$/);
	assert(!after.some((l) => l.includes("Finished scout")), "the person moved on: the settled run leaves the list");
	panel.dispose();
});

test("the settings panel opens a row's choices in place and saves the chosen one", async () => {
	const { initTheme } = await import("@earendil-works/pi-coding-agent");
	initTheme();
	let settings: DelegateSettings = { ...DEFAULT_DELEGATE_SETTINGS };
	const saved: Partial<DelegateSettings>[] = [];
	let closed = false;
	const panel = new SettingsPanel("Delegate settings", delegateRows(() => settings, async (change) => { saved.push(change); settings = { ...settings, ...change }; }), () => {}, () => { closed = true; });
	const first = plain(panel.render(120));
	assert.match(first, /Mode\s+Opportunistic ›/);
	assert.match(first, /How the main session uses children/, "the selected row's help is under the list, as in Pi's /settings");
	assert.match(first, /Type to search/, "Pi's SettingsList, with its search");
	panel.handleInput(ENTER);
	const open = plain(panel.render(120));
	assert.match(open, /Orchestrator\s+root delegates every task/, "each choice shows what it means");
	panel.handleInput(DOWN);
	assert.match(plain(panel.render(120)), /It never waits on a/, "and the highlighted choice's help");
	panel.handleInput(ENTER);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(saved, [{ mode: "orchestrator" }]);
	assert.match(plain(panel.render(120)), /Mode\s+Orchestrator ● ›/, "a changed row is marked");
	panel.handleInput(ESC);
	assert.equal(closed, true);
});

test("todo reminder settings are off by default and save On", async () => {
	const { initTheme } = await import("@earendil-works/pi-coding-agent");
	initTheme();
	let settings: TodoSettings = { ...DEFAULT_TODO_SETTINGS };
	const saved: Partial<TodoSettings>[] = [];
	const panel = new SettingsPanel("Delegate settings", todoRows(() => settings, async (change) => { saved.push(change); settings = { ...settings, ...change }; }), () => {}, () => {});
	assert.match(plain(panel.render(120)), /Reminders\s+Off/);
	// A two-way setting cycles on Enter, as Pi's toggles do.
	panel.handleInput(ENTER);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(saved, [{ reminders: true }]);
	assert.match(plain(panel.render(120)), /Reminders\s+On ●/);
});

test("recap settings use the shared SettingsPanel and expose the persisted controls", async () => {
	const { initTheme } = await import("@earendil-works/pi-coding-agent");
	initTheme();
	let settings: RecapSettings = { ...DEFAULT_RECAP_SETTINGS };
	const saved: Partial<RecapSettings>[] = [];
	const panel = new SettingsPanel("Delegate settings", recapRows(() => settings, async (change) => { saved.push(change); settings = { ...settings, ...change }; }), () => {}, () => {});
	assert.match(plain(panel.render(120)), /Away summaries\s+On/);
	assert.match(plain(panel.render(120)), /Idle threshold\s+5m/);
	panel.handleInput(ENTER);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(saved, [{ enabled: false }]);
	assert.match(plain(panel.render(120)), /Away summaries\s+Off ●/);
	assert.match(plain(panel.render(120)), /away recap after settled work has been idle/);
	panel.handleInput(DOWN);
	assert.match(plain(panel.render(120)), /waits after parent and delegate work settle/);
});
