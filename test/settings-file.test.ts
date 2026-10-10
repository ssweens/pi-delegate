import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings, writeSettings } from "../src/settings-file.ts";

test("concurrent settings writes preserve distinct sections and entries", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-delegate-settings-"));
	const file = join(dir, "pi-delegate.json");
	const rating = (score: number) => ({ score, source: "fixture" });
	try {
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
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
