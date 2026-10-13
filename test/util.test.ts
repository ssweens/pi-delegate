import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clipText, errorMessage, flatten, isProbability, isRecord, oneLine, textOf } from "../src/util/text.ts";
import { clockTime, formatAge, formatDuration } from "../src/util/format.ts";
import { isModelRefOrEmpty, matchesSpec, modelKey, parseModelSpec, splitModelRef } from "../src/model-ref.ts";
import { completeLines, nodeJsonlIO, parseJsonLines, readIfExists, siblingFile } from "../src/util/jsonl.ts";
import { entryIdOf, makeRef, parseRef } from "../src/util/ref.ts";

test("text helpers: one clip rule — at most max characters, the ellipsis included", () => {
	assert.equal(clipText("short", 10), "short");
	assert.equal(clipText("abcdefghij", 5), "abcd…");
	assert.equal(clipText("abcdefghij", 5).length, 5);
	assert.equal(clipText("abc def ghi jkl", 10, { words: true }), "abc def…", "cut back to a word");
	assert.equal(clipText("abcdefghij", 5, { ellipsis: "" }), "abcde", "a hard cut");
	assert.equal(clipText("abc   def", 5), "abc…", "no trailing space before the ellipsis");
	assert.equal(flatten("  a\n\tb  c "), "a b c");
	assert.equal(oneLine("a\nb c d e f", 6), "a b c…");
	assert.equal(errorMessage(new Error("boom")), "boom");
	assert.equal(errorMessage("plain"), "plain");
	assert.equal(isRecord({}), true); assert.equal(isRecord([]), false); assert.equal(isRecord(null), false);
	assert.equal(isProbability(0.5), true); assert.equal(isProbability(1.1), false); assert.equal(isProbability(Number.NaN), false);
	assert.equal(textOf("as is"), "as is");
	assert.equal(textOf([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]), "a\nb");
	assert.equal(textOf([{ type: "text", text: "a" }, { type: "text", text: "b" }], ""), "ab");
	assert.equal(textOf(undefined), "");
});

test("time formats: one duration form and one age form everywhere", () => {
	assert.equal(formatDuration(5_400), "5s");
	assert.equal(formatDuration(65_900), "1m05s", "floors");
	assert.equal(formatDuration(3 * 3600_000 + 5 * 60_000), "3h05m", "hours, never 185m");
	assert.equal(formatDuration(-10), "0s");
	const now = 10_000_000;
	assert.equal(formatAge(now - 30_000, now), "now");
	assert.equal(formatAge(now - 4 * 60_000, now), "4m");
	assert.equal(formatAge(now - 2 * 86_400_000, now), "2d");
	assert.match(clockTime(Date.UTC(2026, 0, 1, 12, 7)), /^\d\d:\d\d$/);
});

test("model refs: one parser, one formatter", () => {
	assert.deepEqual(parseModelSpec("openai/gpt-5:high"), { provider: "openai", id: "gpt-5", thinking: "high" });
	assert.deepEqual(parseModelSpec("openrouter/qwen/qwen3:free"), { provider: "openrouter", id: "qwen/qwen3", thinking: "free" });
	assert.deepEqual(parseModelSpec("ollama/llama3:8b/x"), { provider: "ollama", id: "llama3:8b/x" }, "a colon followed by / is part of the id");
	assert.deepEqual(parseModelSpec("gpt-5"), { id: "gpt-5" });
	assert.deepEqual(parseModelSpec("gpt-5:low"), { id: "gpt-5", thinking: "low" });
	assert.equal(splitModelRef("p/"), undefined); assert.equal(splitModelRef("/id"), undefined); assert.equal(splitModelRef("noslash"), undefined);
	assert.deepEqual(splitModelRef("lan/beverly"), { provider: "lan", id: "beverly" });
	assert.equal(modelKey({ provider: "a", id: "b" }), "a/b");
	assert.equal(isModelRefOrEmpty(""), true); assert.equal(isModelRefOrEmpty("a/b"), true); assert.equal(isModelRefOrEmpty("ab"), false);
	assert.equal(matchesSpec({ provider: "a", id: "m" }, { id: "m" }), true);
	assert.equal(matchesSpec({ provider: "a", id: "m" }, { provider: "b", id: "m" }), false);
});

test("refs: block refs name their entry; malformed refs name nothing", () => {
	assert.equal(makeRef("s", "e"), "s:e"); assert.equal(makeRef("s", "e", 2), "s:e:b2");
	assert.deepEqual(parseRef("s:e:b2"), { stream: "s", entryId: "e", block: 2 });
	assert.equal(entryIdOf("s:e:b2"), "e"); assert.equal(entryIdOf("s:e"), "e"); assert.equal(entryIdOf("nocolon"), undefined);
});

test("jsonl: complete lines only, read in bytes; appends finish a torn line first", async () => {
	const torn = Buffer.concat([Buffer.from('{"a":1}\n{"b":"é'), Buffer.from("é").subarray(0, 1)]);
	assert.deepEqual(completeLines(torn), [{ number: 1, line: '{"a":1}' }], "a torn multi-byte tail is left out");
	const parsed = parseJsonLines('{"a":1}\nnot json\n\n{"c":3}\n');
	assert.deepEqual(parsed.values.map(v => v.number), [1, 4]);
	assert.match(parsed.unreadable[0]!, /^line 2: /);
	assert.equal(siblingFile("/x/s.jsonl", "trail"), "/x/s.trail");
	const dir = await mkdtemp(join(tmpdir(), "jsonl-"));
	try {
		const file = join(dir, "f.mom");
		assert.equal((await readIfExists(nodeJsonlIO, file)).length, 0);
		assert.equal(await nodeJsonlIO.identity(file), undefined);
		await writeFile(file, '{"a":1}\n{"torn"');
		await nodeJsonlIO.append(file, '{"b":2}\n');
		assert.deepEqual(parseJsonLines(await readFile(file)).values.map(v => v.value), [{ a: 1 }, { b: 2 }]);
		assert.match(String(await nodeJsonlIO.identity(file)), /^\d+:\d+$/);
	} finally { await rm(dir, { recursive: true, force: true }); }
});
