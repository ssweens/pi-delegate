import assert from "node:assert/strict";
import { test } from "node:test";
import { bootstrapDigest, chapterDigest, DEFAULT_BOOTSTRAP_POLICY, segmentChapters, type BootstrapFeed } from "../src/mom/bootstrap.ts";
import { Mom } from "../src/mom/mother.ts";
import type { FeedEvent } from "../src/mom/feed.ts";

const event = (ref: string, kind: string, text = "recorded activity"): FeedEvent => ({ ref, actor: "lead", kind, at: `2026-10-09T00:00:${ref.padStart(2, "0")}.000Z`, text });

test("large catch-up drains locally into one bounded thread-map digest", async () => {
	const chunks: FeedEvent[][] = [
		[event("01", "user", "Start the first chapter"), event("02", "compaction", "chapter one claim")],
		[event("03", "user", "Continue the second chapter"), event("04", "compaction", "chapter two claim")],
		[event("05", "user", "Continue the live chapter")],
	];
	let calls = 0;
	const all: FeedEvent[] = [];
	const feed: BootstrapFeed = {
		events: all,
		async capture() {
			const next = chunks[calls++] ?? [];
			all.push(...next);
			return { events: next, cut: { parent: next.at(-1)?.ref ?? null, workers: [] }, more: calls < chunks.length };
		},
	};
	const digest = await bootstrapDigest(feed, true, { maxChapters: 2, maxDigestChars: 6000, maxWindows: 10 });
	assert(digest);
	assert.equal(calls, 3, "the host drains windows without a model call per window");
	assert.equal(digest.chapters, 3);
	assert.equal(digest.remainingMore, false);
	assert.match(digest.text, /BOOTSTRAP CHAPTER CHAIN/);
	assert.match(digest.text, /first direction/);
});

test("strict rebuild keeps a complete prefix when the next capture window exceeds its thread-map budget", async () => {
	const initial = [event("01", "user", "Keep the first direction"), event("02", "compaction", "first claim")];
	const following = [event("03", "user", "A second, very long direction ".repeat(20))];
	let calls = 0;
	const restored = [event("00", "user", "Previously covered work"), ...initial];
	const feed: BootstrapFeed = {
		events: restored,
		async capture() { calls++; restored.push(...following); return { events: following, cut: { parent: "03", workers: [] }, more: false }; },
	};
	const digest = await bootstrapDigest(feed, true, { maxChapters: 1, maxDigestChars: 650, maxWindows: 10 }, 1,
		{ parent: "02", workers: [] });
	assert(digest);
	assert.equal(calls, 1);
	assert.equal(digest.cut.parent, "02", "the accepted cut never includes an omitted direction");
	assert.equal(digest.drainedCount, 2);
	assert.equal(digest.remainingMore, true, "the next pass must re-read the rejected window");
	assert.doesNotMatch(digest.text, /src:00|src:03|omitted for budget/);
});

test("Mom commits only the complete thread-map prefix, not a capture window it already read past the limit", async () => {
	const first = event("01", "user", "Keep the first direction"), second = event("02", "user", "Keep a separate second direction");
	const full = chapterDigest(segmentChapters([first]), { ...DEFAULT_BOOTSTRAP_POLICY, maxDigestChars: 5000 })!;
	const policy = { maxChapters: 1, maxDigestChars: full.length + 10, maxWindows: 10 };
	let captures = 0;
	const events: FeedEvent[] = [];
	const feed: any = { events, byRef: new Map(), gaps: new Map(), hasRunningWorkers: false,
		uncertainEffects: () => [], cut: () => ({ parent: events.at(-1)?.ref ?? null, workers: [] }),
		async capture() {
			const item = ++captures === 1 ? first : second;
			events.push(item);
			return { events: [item], cut: { parent: item.ref, workers: [] }, gaps: [], more: captures === 1 };
		},
	};
	const manager = { getSessionId: () => "session", getSessionFile: () => "/tmp/session.jsonl", getCwd: () => "/tmp",
		getLeafId: () => "02", getEntry: (id: string) => ({ id, parentId: id === "02" ? "01" : null }), getBranch: () => [] };
	const mom = new Mom({ ctx: { cwd: "/tmp", isIdle: () => true, sessionManager: manager, ui: { notify() {} } },
		mapMode: "v2", model: "omlx/test", bootstrapPolicy: policy,
		store: { append: async () => ({ id: "record" }) }, steps: async () => ({ messages: [] }), changed() {} } as any);
	(mom as any).feed = feed;
	const prepared = await mom.prepare({ refresh: true, forceDigest: true, job: "rebuild" });
	assert.equal(prepared.kind, "work");
	if (prepared.kind !== "work") return;
	assert.equal(captures, 2, "the next window was read but refused when it would omit a direction");
	assert.deepEqual(prepared.header.refs, ["01"]);
	assert.equal(prepared.header.cut?.parent, "01");
	assert.equal(prepared.batch.more, true);
});

test("each chapter pairs a direction with the outcome its turn reported, a placeholder summary never replaces them, and edits name their files", () => {
	const lead = (ref: string, kind: string, extra: Partial<FeedEvent> = {}): FeedEvent => ({ ...event(ref, kind), ...extra });
	const chapters = segmentChapters([
		lead("01", "user", { text: "Point Oven at ~/.pi" }),
		lead("02", "assistant", { text: "Reading the tool host first." }),
		lead("03", "tool_call", { name: "edit", text: JSON.stringify({ path: "/src/oven/src/toolhost.ts", edits: [] }) }),
		lead("04", "tool_call", { name: "Write", text: JSON.stringify({ path: "/src/oven/README.md", content: "x" }) }),
		lead("05", "assistant", { text: "Oven now reads Pi's config from ~/.pi/agent." }),
		lead("06", "user", { text: "Hide the anchor" }),
		lead("07", "assistant", { text: "The anchor is sent with display false." }),
		lead("08", "compaction", { text: undefined, claim: "OpenAI remote compaction applied for openai-codex/gpt-6-luna via chatgpt.com." }),
	]);
	const text = chapterDigest(chapters, DEFAULT_BOOTSTRAP_POLICY)!;
	assert.match(text, /first direction \[src:01\] Point Oven at ~\/\.pi\n  outcome \(reported\) \[src:05\] Oven now reads Pi's config/);
	assert.match(text, /last direction \[src:06\] Hide the anchor\n  last outcome \(reported\) \[src:07\] The anchor is sent with display false\./);
	assert.doesNotMatch(text, /Reading the tool host first/, "only the text that closed a turn is its outcome");
	assert.match(text, /file \[src:03\] \/src\/oven\/src\/toolhost\.ts \(edit\u00d71\)/);
	assert.match(text, /file \[src:04\] \/src\/oven\/README\.md \(write\u00d71\)/);
	assert.match(text, /CLAIM\(placeholder \u2014 no content\)\n/);
	assert.doesNotMatch(text, /remote compaction applied/);
});

test("act-label preparation uses the local digest before asking the model", async () => {
	const chunks: FeedEvent[][] = [
		[event("11", "user", "Start the first chapter"), event("12", "compaction", "chapter one claim")],
		[event("13", "user", "Continue the second chapter"), event("14", "compaction", "chapter two claim")],
		[event("15", "user", "Continue the live chapter")],
	];
	let calls = 0;
	const events: FeedEvent[] = [];
	const feed: any = {
		events,
		byRef: new Map(),
		gaps: new Map(),
		hasRunningWorkers: false,
		uncertainEffects: () => [],
		cut: () => ({ parent: events.at(-1)?.ref ?? null, workers: [] }),
		async capture() {
			const next = chunks[calls++] ?? [];
			events.push(...next);
			return { events: next, cut: { parent: next.at(-1)?.ref ?? null, workers: [] }, gaps: [], more: calls < chunks.length };
		},
	};
	const manager = {
		getSessionId: () => "session",
		getSessionFile: () => "/tmp/session.jsonl",
		getCwd: () => "/tmp",
		getLeafId: () => "15",
		getEntry: (id: string) => ({ id, parentId: Number(id) > 11 ? String(Number(id) - 1) : null }),
		getBranch: () => [],
	};
	const mom = new Mom({
		ctx: { cwd: "/tmp", isIdle: () => true, sessionManager: manager, ui: { notify() {} } },
		mapMode: "v2", model: "omlx/test", bootstrapPolicy: { maxChapters: 2, maxDigestChars: 6000, maxWindows: 10 },
		store: { append: async () => ({ id: "record" }) }, steps: async () => ({ messages: [] }), changed() {},
	} as any);
	(mom as any).feed = feed;
	const prepared = await mom.prepare({ refresh: false, job: "job" });
	assert.equal(prepared.kind, "work");
	if (prepared.kind !== "work") return;
	assert.equal(calls, 3, "the cold backlog is drained locally, window by window");
	assert.match(prepared.batch.digest ?? "", /BOOTSTRAP CHAPTER CHAIN/);
	assert.equal(prepared.batch.more, false);
});
