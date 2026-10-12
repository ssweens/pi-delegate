import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_TODO_SETTINGS, normalizeTodoSettings, readTodoSettings, saveTodoSettings } from "../src/todo-settings.ts";

test("todo reminders default to disabled and malformed values use the default", () => {
	assert.deepEqual(normalizeTodoSettings(undefined), DEFAULT_TODO_SETTINGS);
	assert.deepEqual(normalizeTodoSettings({ reminders: "yes" }), DEFAULT_TODO_SETTINGS);
	assert.deepEqual(normalizeTodoSettings({ reminders: true }), { reminders: true });
});

test("saving todo settings preserves other settings and writes only the chosen todo field", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-delegate-todo-settings-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "pi-delegate.json");
	writeFileSync(file, JSON.stringify({ delegate: { maxDepth: 4 }, mom: { mode: "trail" } }));

	assert.deepEqual(await saveTodoSettings({ reminders: true }, file), { reminders: true });
	assert.equal(readTodoSettings(file).reminders, true);
	const saved = JSON.parse(readFileSync(file, "utf8"));
	assert.deepEqual(saved.todo, { reminders: true });
	assert.deepEqual(saved.delegate, { maxDepth: 4 });
	assert.deepEqual(saved.mom, { mode: "trail" });
});
