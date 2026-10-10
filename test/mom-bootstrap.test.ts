import assert from "node:assert/strict";
import { test } from "node:test";
import { bootstrapDigest, type BootstrapFeed } from "../src/mom/bootstrap.ts";
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
