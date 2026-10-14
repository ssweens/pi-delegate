import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./capture.ts";
import { DEFAULT_RECAP_SETTINGS, normalizeRecapSettings, readRecapSettings, saveRecapSettings } from "../src/recap-settings.ts";

test("recap settings normalize malformed values field by field", () => {
	assert.equal(DEFAULT_RECAP_SETTINGS.idleThresholdMs, 5 * 60 * 1000);
	assert.deepEqual(normalizeRecapSettings(undefined), DEFAULT_RECAP_SETTINGS);
	assert.deepEqual(normalizeRecapSettings({ enabled: false, idleThresholdMs: 30_000 }), { enabled: false, idleThresholdMs: 30_000 });
	assert.deepEqual(normalizeRecapSettings({ enabled: "yes", idleThresholdMs: 0 }), DEFAULT_RECAP_SETTINGS);
	assert.equal(normalizeRecapSettings({ idleThresholdMs: 1.5 }).idleThresholdMs, DEFAULT_RECAP_SETTINGS.idleThresholdMs);
});

test("recap settings share the settings file and reject values outside the normalized range", async (t) => {
	const dir = tempDir("pi-delegate-recap-settings-", t);
	const file = join(dir, "pi-delegate.json");
	writeFileSync(file, JSON.stringify({ delegate: { maxDepth: 4 }, todo: { reminders: true } }));

	assert.deepEqual(await saveRecapSettings({ enabled: false, idleThresholdMs: 30_000 }, file), { enabled: false, idleThresholdMs: 30_000 });
	assert.deepEqual(readRecapSettings(file), { enabled: false, idleThresholdMs: 30_000 });
	const saved = JSON.parse(readFileSync(file, "utf8"));
	assert.deepEqual(saved.recap, { enabled: false, idleThresholdMs: 30_000 });
	assert.deepEqual(saved.delegate, { maxDepth: 4 });
	assert.deepEqual(saved.todo, { reminders: true });
	await assert.rejects(saveRecapSettings({ idleThresholdMs: 0 }, file), /invalid idleThresholdMs/);
	assert.deepEqual(readRecapSettings(file), { enabled: false, idleThresholdMs: 30_000 });
});
