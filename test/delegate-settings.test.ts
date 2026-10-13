import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./capture.ts";
import { DEFAULT_DELEGATE_SETTINGS, normalizeDelegateSettings, pickModel, readDelegateSettings, saveDelegateSettings } from "../src/delegate-settings.ts";
import { modelList } from "../src/roles.ts";

test("a missing or malformed delegate section reads as its defaults, field by field", () => {
	assert.deepEqual(normalizeDelegateSettings(undefined), DEFAULT_DELEGATE_SETTINGS);
	assert.deepEqual(normalizeDelegateSettings([]), DEFAULT_DELEGATE_SETTINGS);
	assert.deepEqual(normalizeDelegateSettings({ mode: "orchestrator", maxDepth: 99, maxConcurrent: 0, modelPicking: "nope" }),
		{ ...DEFAULT_DELEGATE_SETTINGS, mode: "orchestrator", maxConcurrent: 0 });
	assert.equal(normalizeDelegateSettings({ maxDepth: 2.5 }).maxDepth, DEFAULT_DELEGATE_SETTINGS.maxDepth, "only whole numbers");
});

test("saving a delegate setting merges into the one settings file and keeps the other sections", async (t) => {
	const dir = tempDir("pi-delegate-settings-", t);
	const file = join(dir, "pi-delegate.json");
	writeFileSync(file, JSON.stringify({ mom: { mode: "v2" }, defaults: { approved: { scout: { spec: "a/b", approvedAt: 1 } } } }));
	assert.deepEqual(await saveDelegateSettings({ maxConcurrent: 4 }, file), { ...DEFAULT_DELEGATE_SETTINGS, maxConcurrent: 4 });
	await saveDelegateSettings({ mode: "off" }, file);
	const saved = JSON.parse(readFileSync(file, "utf8"));
	assert.deepEqual(saved.delegate, { maxConcurrent: 4, mode: "off" }, "only what was chosen is written");
	assert.deepEqual(saved.mom, { mode: "v2" });
	assert.equal(saved.defaults.approved.scout.spec, "a/b");
	assert.equal(readDelegateSettings(file).mode, "off");
	await assert.rejects(saveDelegateSettings({ maxDepth: 0 }, file), /invalid maxDepth/);
	assert.equal(readDelegateSettings(file).maxDepth, DEFAULT_DELEGATE_SETTINGS.maxDepth, "a refused value is not written");
});

test("a role's model line is one entry, a comma list, a bracket list, or a YAML list", () => {
	assert.deepEqual(modelList("openai/gpt-x"), ["openai/gpt-x"]);
	assert.deepEqual(modelList("openai/gpt-x, anthropic/claude-y:high"), ["openai/gpt-x", "anthropic/claude-y:high"]);
	assert.deepEqual(modelList("[a/b, c/d]"), ["a/b", "c/d"]);
	// parseFrontmatter folds `model:\n  - a/b\n  - c/d` into one line.
	assert.deepEqual(modelList("- a/b - c/d"), ["a/b", "c/d"]);
	assert.deepEqual(modelList("a/b, a/b"), ["a/b"]);
	assert.equal(modelList("inherit"), undefined);
	assert.equal(modelList(""), undefined);
});

test("a model list resolves to the first entry with credentials, and within Pi's scope when one is set", () => {
	const m = (provider: string, id: string) => ({ provider, id });
	const available = [m("openrouter", "big"), m("local", "small"), m("cloud", "small")];
	const picked = pickModel(["missing/one", "openrouter/big:high", "local/small"], available, [], "scoped");
	assert.deepEqual(picked.model, m("openrouter", "big"));
	assert.equal(picked.model && picked.thinking, "high");
	assert.deepEqual(picked.skipped, ["missing/one: no credentials or not in the catalog"]);

	const scoped = pickModel(["openrouter/big", "small"], available, [m("cloud", "small")], "scoped");
	assert.deepEqual(scoped.model, m("cloud", "small"), "a bare id takes the in-scope offering");
	assert.deepEqual(scoped.skipped, ["openrouter/big: not in Pi's scoped models"]);

	assert.deepEqual(pickModel(["openrouter/big"], available, [m("cloud", "small")], "available").model, m("openrouter", "big"), "available picking ignores the scope");
	assert.deepEqual(pickModel(["small"], available, [], "scoped").model, m("local", "small"), "no scope configured: every available model is in it");

	const none = pickModel(["x/y", "openrouter/big"], available, [m("local", "small")], "scoped");
	assert.equal(none.model, undefined);
	assert.equal(none.skipped.length, 2, "each skipped entry says why");
});
