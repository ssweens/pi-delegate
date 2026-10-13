import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { defineSection, readSettings, writeSettings } from "../src/settings-file.ts";
import { isRecord } from "../src/util/text.ts";
import { tempDir } from "./capture.ts";

test("concurrent settings writes preserve distinct sections and entries", async (t) => {
	const dir = tempDir("pi-delegate-settings-", t);
	const file = join(dir, "pi-delegate.json");
	const rating = (score: number) => ({ score, source: "fixture" });
	await Promise.all([
		writeSettings({ mom: { mode: "v2" } }, file),
		writeSettings({ defaults: { approved: { scout: { spec: "fixture/scout", approvedAt: 1 } } } }, file),
		writeSettings({ defaults: { approved: { reviewer: { spec: "fixture/reviewer", approvedAt: 2 } } } }, file),
		writeSettings({ ratings: { entries: { "fixture/model-a": rating(0.8) } } }, file),
		writeSettings({ ratings: { entries: { "fixture/model-b": rating(0.9) } } }, file),
	]);
	assert.deepEqual(readSettings(file), {
		mom: { mode: "v2" },
		defaults: { approved: {
			scout: { spec: "fixture/scout", approvedAt: 1 },
			reviewer: { spec: "fixture/reviewer", approvedAt: 2 },
		} },
		ratings: { entries: {
			"fixture/model-a": rating(0.8),
			"fixture/model-b": rating(0.9),
		} },
	});
});

test("a section's save validates against its normalizer and keeps the exact error text", async (t) => {
	const file = join(tempDir("pi-delegate-section-", t), "pi-delegate.json");
	const section = defineSection("todo", (value) => ({ reminders: isRecord(value) && value.reminders === true }));
	assert.deepEqual(section.read(file), { reminders: false });
	assert.deepEqual(await section.save({ reminders: true }, file), { reminders: true });
	await assert.rejects(section.save({ reminders: "yes" as never }, file), /^Error: invalid reminders: "yes"$/);
	assert.deepEqual(section.read(file), { reminders: true });
});
