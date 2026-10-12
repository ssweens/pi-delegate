import "./setup.ts";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadState, type Checkpoint } from "../src/mom/checkpoint.ts";
import { emptyGraph } from "../src/mom/graph.ts";
import { writeMomGlobals } from "../src/mom/globals.ts";
import { acceptRebuiltMap, rebuildMap, type RebuiltMap } from "../src/mom/rebuild.ts";
import { sessionFromFile } from "../src/mom/session-file.ts";
import { SidecarStore } from "../src/mom/sidecar.ts";
import { identityOf, ownerKey } from "../src/mom/slice.ts";
import { MomRebuildPanel } from "../src/ui/mom-rebuild.ts";
import { momSectionLines } from "../src/ui/panel.ts";
import { provider, sandbox, harness, deferred, OVEN_AVAILABLE, startOven } from "./fixture.ts";

const theme: any = { fg: (_: string, s: string) => s, bold: (s: string) => s, bg: (_: string, s: string) => s };
const checkpoint = (sessionId: string, leaf: string, label: string): Checkpoint => ({ sessionId, at: Date.now(), model: "fixture/fixture",
	cut: { parent: leaf, workers: [] }, note: null, unfinished: [], graph: { ...emptyGraph(), revision: 1, motherThread: "root", purpose: "root", focus: "root",
		nodes: [{ id: "root", kind: "feature", parent: null, state: "active", label, intent: label, observed: "", actor: "lead", sources: [`${sessionId}:${leaf}`] }] } });

test("accepting a rebuild replaces only Mom's map; a stale checkpoint or branch is refused", async () => {
	const dir = await mkdtemp(join(tmpdir(), "mom-rebuild-accept-"));
	try {
		const sessionId = "test-session", leaf = "first", file = join(dir, "session.jsonl");
		await writeFile(file, [JSON.stringify({ type: "session", id: sessionId, cwd: dir }),
			JSON.stringify({ type: "message", id: leaf, parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "Build the map" }] } }), ""].join("\n"));
		const manager = sessionFromFile(file, leaf), context: any = { cwd: dir, sessionManager: manager };
		const store = new SidecarStore(() => file, sessionId);
		const old = checkpoint(sessionId, leaf, "Old interpretation");
		old.graph.revision = 12;
		const first = await store.append("map", { snapshot: old, base: null });
		const rebuilt = checkpoint(sessionId, leaf, "From the transcript");
		const candidate: RebuiltMap = { session: identityOf(manager, dir), branchIds: [leaf], sourceSize: (await stat(file)).size, baseId: first.id,
			checkpoint: rebuilt, view: {} as never, batches: 1 };
		await acceptRebuiltMap(context, candidate);
		const saved = await loadState(new SidecarStore(() => file, sessionId), manager);
		assert.equal(saved.checkpoint?.graph.nodes[0]?.label, "From the transcript");
		assert.equal(saved.checkpoint?.graph.revision, 13, "the live revision does not go backwards after a fresh rebuild");
		assert.equal((await new SidecarStore(() => file, sessionId).load()).filter(record => record.data.snapshot).length, 2, "the earlier checkpoint remains in history");
		await assert.rejects(acceptRebuiltMap(context, candidate), /saved map changed/);
		assert.equal((await loadState(new SidecarStore(() => file, sessionId), manager)).checkpointId, saved.checkpointId);
		const wrongBranch = { ...candidate, baseId: saved.checkpointId, branchIds: ["other"] };
		await assert.rejects(acceptRebuiltMap(context, wrongBranch), /session branch changed/);
		await appendFile(file, JSON.stringify({ type: "message", id: "later", parentId: leaf, timestamp: new Date().toISOString(),
			message: { role: "user", content: [{ type: "text", text: "Another direction" }] } }) + "\n");
		await assert.rejects(acceptRebuiltMap(context, { ...candidate, baseId: saved.checkpointId }), /session transcript changed/);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("an unfollowed Oven slice rebuilds the transcript independently, then acceptance saves its graph", { timeout: 45000,
	skip: OVEN_AVAILABLE ? false : "Oven checkout unavailable; set OVEN_DIR." }, async () => {
	const api = await provider(), box = sandbox(api.url);
	const daemon = await startOven(box.root, box.agentDir);
	let h: Awaited<ReturnType<typeof harness>> | undefined;
	let digestSeen = false, rebuildGate: ReturnType<typeof deferred<void>> | undefined;
	try {
		const flags = { "mom-model": "fixture/fixture", "mom-mode": "v2", "mom-bootstrap": "1", "mom-interval-ms": "0", "mom-max-wait-ms": "0", "mom-retry-ms": "100,100,100" };
		h = await harness(box, undefined, { flags });
		const direction = "Build a durable map for this task.";
		api.script(direction, { text: "I will keep track of this task." });
		api.onUnscripted(request => {
			const names = (request.tools ?? []).map((tool: any) => tool.function?.name);
			if (names.includes("mom_begin")) return { tool: { name: "mom_begin", arguments: {} } };
			const last = request.messages.findLast((message: any) => message.role === "tool")?.content;
			const body = JSON.parse(typeof last === "string" ? last : last.map((part: any) => part.text).join("\n"));
			if (body.newEvents?.startsWith("BOOTSTRAP CHAPTER CHAIN")) digestSeen = true;
			const source = body.newUserDirections?.find((item: any) => item.text === direction)?.ref
				?? /first direction \[src:([^\]]+)\] Build a durable map for this task\./.exec(body.newEvents ?? "")?.[1];
			const gate = rebuildGate; rebuildGate = undefined;
			return { text: gate ? "Reading the recorded directions." : undefined, gate,
				tool: { name: "commit_v2", arguments: source && !body.map.nodes.length
				? { put: [{ id: "task", parent: null, kind: "work", state: "active", label: "Build a durable map", sources: [source] }], focus: "task" }
				: {} } };
		});
		await h.runtime.session.prompt(direction);
		const manager = h.runtime.session.sessionManager, file = h.parent;
		let original;
		for (const deadline = Date.now() + 12000; Date.now() < deadline;) {
			original = await loadState(new SidecarStore(() => file, manager.getSessionId()), manager);
			if (original.checkpoint) break;
			await new Promise(resolve => setTimeout(resolve, 25));
		}
		assert(original?.checkpoint, `Mom's initial map did not save: ${JSON.stringify(api.errors)}`);
		const wrong = checkpoint(manager.getSessionId(), manager.getLeafId()!, "Wrong saved interpretation");
		await new SidecarStore(() => file, manager.getSessionId()).append("map", { snapshot: wrong, base: original.checkpointId });
		original = await loadState(new SidecarStore(() => file, manager.getSessionId()), manager);
		assert.equal(original.checkpoint?.graph.nodes[0]?.label, "Wrong saved interpretation");
		const identity = identityOf(manager, box.cwd);
		await writeMomGlobals({ enabled: false }); // An explicit rebuild still runs without resuming background tracking.
		await assert.rejects(rebuildMap(h.ctx(), identity, { ...flags, "mom-bootstrap-chars": "100" }, () => {},
			new AbortController().signal), /thread-map digest cannot include every chapter direction/);
		assert.equal((await loadState(new SidecarStore(() => file, identity.sessionId), manager)).checkpointId, original.checkpointId,
			"a digest that cannot cover the evidence must not replace the map");
		const updates: { message: string; url?: string }[] = [];
		const gate = rebuildGate = deferred<void>();
		const pending = rebuildMap(h.ctx(), identity, flags, (message, url) => { updates.push({ message, url }); }, new AbortController().signal);
		for (const deadline = Date.now() + 12000; Date.now() < deadline && !updates.some(update => update.message.includes("chars streamed"));)
			await new Promise(resolve => setTimeout(resolve, 20));
		const streamed = updates.some(update => update.message.includes("chars streamed"));
		gate.resolve();
		const rebuilt = await pending;
		assert.ok(streamed, "rebuild forwards live model output before the pass finishes");
		assert.ok(updates.every(update => update.url?.startsWith(`${process.env.OVEN_URL}/slice/s-`)), "each progress update identifies its actual Oven slice");
		assert.ok(digestSeen, "even one short chapter must be rebuilt through thread-map evidence");
		assert.equal(rebuilt.checkpoint.graph.nodes[0]?.label, "Build a durable map");
		assert.equal(rebuilt.checkpoint.cut.parent, manager.getLeafId(), "accepted evidence covers the selected transcript leaf");
		assert.equal(rebuilt.baseId, original.checkpointId);
		assert.equal((await loadState(new SidecarStore(() => file, identity.sessionId), manager)).checkpointId, original.checkpointId,
			"running the reconstruction does not touch the live sidecar");
		let modalSaved = false, opened = 0;
		const live = h.ctx();
		const notifications: string[] = [];
		const custom: any = async (factory: any, options: any) => {
			opened++;
			assert.equal(options?.overlay, true, "review opens an overlay only after background reconstruction");
			let finish!: (result: string) => void;
			const completed = new Promise<string>(resolve => { finish = resolve; });
			const tui: any = { terminal: { rows: 30, columns: 100 }, requestRender() {} };
			const panel = factory(tui, theme, undefined, finish);
			assert.match(panel.render(100).join("\n"), /Nothing has been replaced/);
			panel.handleInput("\x1b[B"); // only one visible root: down selects the save action
			panel.handleInput("\r");
			const result = await completed;
			panel.dispose?.();
			modalSaved = result === "saved";
			return result;
		};
		const interactive = { ...live, mode: "tui", ui: { ...live.ui, custom, notify(text: string) { notifications.push(text); } } };
		const tracking = (await daemon.oven.list()).find((slice: any) => slice.key === ownerKey(identity));
		assert.ok(tracking, "the tracking slice uses the canonical session identity");
		await h.commands.get("mom").handler("status", interactive);
		assert.ok(notifications.some(text => text.includes(`${process.env.OVEN_URL}/slice/${tracking.id}`)), "general Mom status links to the tracking slice, not the rebuild");
		await h.commands.get("mom").handler("rebuild", interactive);
		assert.equal(opened, 0, "starting the rebuild returns without opening a modal");
		for (const deadline = Date.now() + 12000; Date.now() < deadline && !notifications.some(text => text.includes("ready"));)
			await new Promise(resolve => setTimeout(resolve, 20));
		assert.match(notifications.join("\n"), /ready/, "background reconstruction reports when review is available");
		await h.commands.get("mom").handler("rebuild", interactive);
		assert.ok(modalSaved, "review saves only after its action received Enter");
		await h.commands.get("mom").handler("graph", interactive);
		assert.match(notifications.join("\n"), /Build a durable map/, "Mom's public graph view reloads after acceptance");
		const saved = await loadState(new SidecarStore(() => file, identity.sessionId), manager);
		assert.notEqual(saved.checkpointId, original.checkpointId);
		assert.equal(saved.checkpoint?.graph.nodes[0]?.label, "Build a durable map");

		// Chapters fill separate capture windows; the digest fits all eight. Rebuild must not
		// silently replace the configured chapter target with one.
		const replayFile = join(box.root, "chapters.jsonl"), entries: Record<string, unknown>[] = [];
		let parentId: string | null = null;
		const add = (entry: Record<string, unknown>) => {
			const id = `chapter-entry-${entries.length}`;
			entries.push({ ...entry, id, parentId, timestamp: new Date().toISOString() }); parentId = id;
		};
		for (let chapter = 0; chapter < 8; chapter++) {
			add({ type: "message", message: { role: "user", content: [{ type: "text", text: chapter ? `Continue chapter ${chapter + 1}.` : direction }] } });
			add({ type: "message", message: { role: "assistant", content: [{ type: "text",
				text: `Chapter ${chapter + 1} completed. ${"Recorded work completed. ".repeat(800)}` }] } });
			add({ type: "compaction", summary: `Chapter ${chapter + 1} claim.` });
		}
		await writeFile(replayFile, [JSON.stringify({ type: "session", id: "chapter-rebuild", cwd: box.cwd }),
			...entries.map(entry => JSON.stringify(entry)), ""].join("\n"));
		const replayManager = sessionFromFile(replayFile, parentId);
		const replayContext = { ...h.ctx(), sessionManager: replayManager } as never;
		const replayIdentity = identityOf(replayManager, box.cwd);
		const small = await rebuildMap(replayContext, replayIdentity, { ...flags, "mom-bootstrap-chapters": "1" }, () => {}, new AbortController().signal);
		const batched = await rebuildMap(replayContext, replayIdentity, flags, () => {}, new AbortController().signal);
		console.log(`Eight-chapter rebuild: single-chapter target ${small.batches} passes; default target ${batched.batches} passes.`);
		assert.ok(small.batches > 1, "the fixture exercises multiple single-chapter passes");
		assert.equal(batched.batches, 1, "the configured default batches every chapter whose complete digest fits");
		assert.equal(batched.checkpoint.cut.parent, parentId, "batching still covers the complete selected branch");
		assert.equal(batched.checkpoint.graph.nodes[0]?.label, "Build a durable map");
		assert.deepEqual(api.errors, []);
	} finally {
		await h?.runtime.dispose(); await daemon.stop(); await api.close(); await rm(box.root, { recursive: true, force: true });
	}
});

test("Mom's widget shows background rebuild progress and the review action in both layouts", () => {
	for (const compact of [false, true]) {
		const base = { status: "up to date", summary: "Saved work", compact,
			sliceUrl: "http://127.0.0.1:6836/slice/s-tracking", rebuildUrl: "http://127.0.0.1:6836/slice/s-rebuild" };
		const screen = momSectionLines({ ...base, rebuild: "Rebuilding · pass 3 · reasoning" }, theme, 90).join("\n");
		assert.ok(screen.includes(`Slice: ${base.sliceUrl}`));
		assert.ok(screen.includes(`Rebuild slice: ${base.rebuildUrl}`));
		assert.match(momSectionLines({ ...base, rebuild: "Rebuilding from the selected branch · pass 3" }, theme, 90).join("\n"), /pass 3/);
		assert.match(momSectionLines({ ...base, rebuild: "Rebuild ready · \/mom rebuild to review" }, theme, 90).join("\n"), /rebuild to review/);
	}
});

test("completed rebuild modal browses with arrows; Enter saves only on its action, Esc discards", async () => {
	let saved = 0, outcome: string | undefined, renders = 0;
	const tui: any = { requestRender: () => { renders++; } };
	const prior = checkpoint("test-session", "first", "Old saved story");
	const savedView = { endeavors: [{ ...prior.graph.nodes[0], annotations: [] }], unattachedAnnotations: [],
		focus: "root", focusEndeavor: "root", focusPath: ["root"], connections: [] } as never;
	const graph = checkpoint("test-session", "first", "Rebuilt story");
	const child = { ...graph.graph.nodes[0]!, id: "child", parent: "root", label: "Child task" };
	graph.graph.nodes.push(child);
	const candidate: RebuiltMap = { checkpoint: graph, session: { cwd: "/tmp", sessionFile: "/tmp/session.jsonl", sessionId: "test-session" },
		branchIds: ["first"], sourceSize: 0, batches: 1, view: { endeavors: [{ ...graph.graph.nodes[0], annotations: [] }, { ...child, annotations: [] }],
			unattachedAnnotations: [], focus: "root", focusEndeavor: "root", focusPath: ["root"], connections: [] } as never };
	const panel = new MomRebuildPanel(tui, theme, () => 25, candidate,
		async () => { saved++; }, result => { outcome = result; }, 2, savedView);
	assert.match(panel.render(90).join("\n"), /Rebuilt story/);
	panel.handleInput("\x1b[D"); // left from rebuilt root shows the old map
	assert.match(panel.render(90).join("\n"), /Old saved story/);
	panel.handleInput("\x1b[C"); // right returns to the candidate
	assert.match(panel.render(90).join("\n"), /Rebuilt story/);
	panel.handleInput("\x1b[C"); // focused root starts expanded; right collapses it
	assert.doesNotMatch(panel.render(90).join("\n"), /Child task/);
	panel.handleInput("\x1b[C"); // right expands it again
	assert.match(panel.render(90).join("\n"), /Child task/);
	panel.handleInput("\x1b[B"); // down selects the child
	panel.handleInput("\x1b[D"); // left returns to parent
	panel.handleInput("\x1b[A"); // up stays on root
	panel.handleInput("\r");
	assert.equal(saved, 0, "Enter on a map item is not consent to overwrite");
	panel.handleInput("\x1b[B"); // child
	panel.handleInput("\x1b[B"); // action
	assert.match(panel.render(90).join("\n"), /▶ Use rebuilt map/);
	panel.handleInput("\r");
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(saved, 1);
	assert.equal(outcome, "saved");
	assert.ok(renders > 0);

	const cancelling = new MomRebuildPanel(tui, theme, () => 25, candidate,
		async () => { saved++; }, result => { outcome = result; }, 2);
	cancelling.handleInput("\x1b");
	assert.equal(outcome, "cancelled");
	assert.equal(saved, 1);
});
