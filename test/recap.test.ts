import assert from "node:assert/strict";
import { mock, test } from "node:test";
import piRecap from "../src/recap.ts";
import { ActivityCoordinator } from "../src/ui/activity.ts";
import { deferred } from "./capture.ts";

const text = (value: string) => [{ type: "text" as const, text: value }];
const user = (value: string, timestamp: number) => ({ role: "user" as const, content: text(value), timestamp });
const assistant = (value: string, timestamp: number, stopReason = "stop") => ({ role: "assistant" as const, content: text(value), timestamp, stopReason });

function fixture(responseText: string, priorRecapCounts: number[] = [], draft = "", conversation?: any[], sources?: Parameters<typeof piRecap>[2]) {
	const raw = "<tool_call><function=delegate>" + "raw transcript ".repeat(1500) + "</function></tool_call>";
	const messages = conversation ?? [
		user("We are building the integrated search pipeline.", 1),
		{ role: "bashExecution", command: "delegate", output: raw, timestamp: 2 },
		{ ...assistant("※ recap: commissioning three lanes", 3, "toolUse"), content: [
			...text("※ recap: commissioning three lanes"),
			{ type: "toolCall", id: "d1", name: "delegate", arguments: { task: "lane1_integration" } },
		] },
		{ role: "toolResult", content: text(raw), toolCallId: "d1", toolName: "delegate", timestamp: 4 },
		user("The assistant leaked raw calls: " + raw + " Please summarize the outcome.", 5),
		assistant("※ recap: <tool_call><function=delegate>another raw call</function></tool_call>", 6),
		assistant("Three lanes and a coherence review are running.", 7),
	];
	const entries = messages.map((message, i) => ({
		type: "message", id: String(i), parentId: i ? String(i - 1) : null, message,
	}));
	entries.push({ type: "custom_message", id: String(entries.length), parentId: String(entries.length - 1), customType: "debug", content: raw, timestamp: 8 } as never);
	const savedEntries = [...entries, ...priorRecapCounts.map((count, i) => ({ type: "custom", id: `recap-${i}`, parentId: null, customType: "pi-recap", data: { count } }))];
	const commands = new Map<string, any>();
	const handlers = new Map<string, any>();
	const recaps: (string | undefined)[] = [];
	const notices: { message: string; kind: string }[] = [];
	const requests: any[] = [];
	let idle = true, pending = false;
	let reply = Promise.resolve({ stopReason: "stop", content: text(responseText) });
	let terminalInput: ((data: string) => void) | undefined;
	const activity = new ActivityCoordinator();
	const setRecap = activity.setRecap.bind(activity);
	activity.setRecap = value => { recaps.push(value); setRecap(value); };
	piRecap({
		on(name: string, handler: any) { handlers.set(name, handler); },
		appendEntry() {},
		registerCommand(name: string, command: any) { commands.set(name, command); },
	} as any, activity, sources);
	const ctx = {
		model: { provider: "fixture", id: "fixture" },
		mode: "tui", hasUI: true,
		isIdle: () => idle,
		hasPendingMessages: () => pending,
		sessionManager: { getBranch: () => entries, getLeafId: () => entries.at(-1)?.id ?? null, getEntries: () => savedEntries },
		modelRegistry: {
			complete(_model: unknown, context: unknown, options: unknown) {
				requests.push({ context, options });
				return reply;
			},
		},
		ui: {
			setWidget() {},
			onTerminalInput(handler: (data: string) => void) { terminalInput = handler; return () => { terminalInput = undefined; }; },
			getEditorText: () => draft,
			notify(message: string, kind: string) { notices.push({ message, kind }); },
		},
	};
	return {
		run: () => commands.get("recap").handler("test", ctx),
		command: (args: string) => commands.get("recap").handler(args, ctx),
		start: () => handlers.get("session_start")?.({}, ctx),
		input: () => handlers.get("input")?.({ source: "interactive" }, ctx),
		agentEnd: () => handlers.get("agent_end")?.({}, ctx),
		settle: () => { idle = false; handlers.get("agent_end")?.({}, ctx); idle = true; return handlers.get("agent_settled")?.({}, ctx); },
		fire: (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx),
		key: (data = "x") => terminalInput?.(data),
		setDraft: (value: string) => { draft = value; },
		setIdle: (value: boolean) => { idle = value; },
		setPending: (value: boolean) => { pending = value; },
		hold: () => { const gate = deferred<any>(); reply = gate.promise; return () => gate.resolve({ stopReason: "stop", content: text(responseText) }); },
		entries, recaps, notices, requests, activity,
	};
}

test("/recap test sends conversational outcomes, never tool traffic", async () => {
	const run = fixture("Building the integrated search pipeline. Next, verify the three lanes.");
	await run.run();
	assert.equal(run.requests.length, 1, JSON.stringify(run.notices));
	const { context, options } = run.requests[0];
	assert.ok(options.maxTokens <= 192);
	const excerpt = JSON.stringify(context.messages);
	assert.match(excerpt, /integrated search pipeline/);
	assert.match(excerpt, /Please summarize the outcome/);
	assert.match(excerpt, /Three lanes and a coherence review are running/);
	assert.doesNotMatch(excerpt, /tool_call|function=delegate|raw transcript|commissioning three lanes|another raw call|lane1_integration|Assistant tool calls/);
	assert.match(run.recaps.at(-1) ?? "", /Next, verify the three lanes/);
});

test("/recap test bounds the task anchor and recent dialogue instead of sending the full thread", async () => {
	const conversation = [
		user("THREAD-OPEN: build the persistent background agent manager. " + "early-context ".repeat(100) + "THREAD-OPEN-TAIL", 1),
		assistant("The initial goal is to keep agents alive across terminal UI exits. " + "early-outcome ".repeat(100) + "ASSISTANT-OPEN-TAIL", 2),
		user("THREAD-DECISION: use Switchbox itself as the process owner.", 3),
		assistant("Switchbox owns the resident process manager.", 4),
		user("THREAD-DETOUR: compare the Oven runtime before settling the host.", 5),
		assistant("The Oven path would introduce a generic process manager.", 6),
		user("THREAD-RETURN: keep the manager local to Switchbox.", 7),
		assistant("The implementation should preserve existing native session recovery.", 8),
		...Array.from({ length: 12 }, (_, i) => [
			user(`THREAD-MIDDLE-${i}: preserve the existing root and child conversation tree. ${"user detail ".repeat(20)}`, 9 + i * 2),
			assistant(`The host must keep one writer for root ${i}. ${"assistant outcome ".repeat(20)}`, 10 + i * 2),
		]).flat(),
		user("THREAD-CURRENT: implement global management with a cwd filter.", 21),
		assistant("The next step is to settle root-scoped identity and host lifecycle.", 22),
		user("LATEST-POST: clarify the manager row label.", 23),
		assistant("The row label should show the project and current state.", 24),
	];
	const run = fixture("Recap the whole thread.", [], "", conversation);
	await run.run();
	const excerpt = JSON.stringify(run.requests[0]?.context.messages ?? []);
	const context = run.requests[0].context;
	const inputChars = context.systemPrompt.length + context.messages[0].content[0].text.length;
	assert.ok(inputChars <= 8000, `expected approximately 2,000 tokens, got ${inputChars} characters`);
	for (const marker of ["THREAD-OPEN", "THREAD-OPEN-TAIL", "THREAD-CURRENT", "LATEST-POST"]) {
		assert.ok(excerpt.includes(marker), `recap request omitted ${marker}`);
	}
	assert.doesNotMatch(excerpt, /THREAD-MIDDLE-0|THREAD-DETOUR/);
	assert.match(context.messages[0].content[0].text, /Task anchor[\s\S]+Recent dialogue/);
	assert.match(context.systemPrompt, /recent.*(?:override|precedence)/i);
});

test("/recap test keeps overly long or raw model output out of the Activity section", async () => {
	const long = fixture("Planning work now. " + "More irrelevant detail ".repeat(100));
	await long.run();
	const shown = long.recaps.at(-1) ?? "";
	assert.ok(shown.startsWith("※ recap: Planning work now."), shown);
	assert.ok(shown.split(/\s+/).length <= 46, shown);

	const raw = fixture("<tool_call><function=delegate>raw call</function></tool_call>");
	await raw.run();
	assert.ok(raw.recaps.every((recap) => !recap?.includes("<tool_call>")));
	assert.match(raw.notices.at(-1)?.message ?? "", /tool markup/i);
});

test("recap count restoration uses the newest valid transcript entry", async () => {
	const run = fixture("The saved work is ready for verification.", [1, 3]);
	run.start();
	await run.run();
	assert.doesNotMatch(run.recaps.at(-1) ?? "", /\/recap off/);
});

test("idle recap waits while the editor contains a draft", async (t) => {
	mock.timers.enable({ apis: ["setTimeout"] });
	t.after(() => mock.timers.reset());
	const run = fixture("This must not be requested while the draft is open.", [], "unfinished draft");
	run.start(); run.input(); run.input();
	await run.settle();
	mock.timers.tick(5 * 60 * 1000);
	assert.equal(run.requests.length, 0);
	run.setDraft("");
	await run.settle();
	mock.timers.tick(5 * 60 * 1000);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(run.requests.length, 1);
});

test("one new completed exchange satisfies the two-message idle gate", async (t) => {
	mock.timers.enable({ apis: ["setTimeout"] });
	t.after(() => mock.timers.reset());
	const run = fixture("The new exchange is ready to recap.");
	run.start(); run.input();
	run.fire("message_end", { message: assistant("The work is ready for verification.", 9) });
	await run.settle();
	mock.timers.tick(5 * 60 * 1000);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(run.requests.length, 1);
});

test("idle recap waits five minutes by default", async (t) => {
	mock.timers.enable({ apis: ["setTimeout"] });
	t.after(() => mock.timers.reset());
	const run = fixture("The full thread is ready to recap.");
	run.start();
	run.input();
	run.input();
	await run.settle();
	mock.timers.tick(5 * 60 * 1000 - 1);
	assert.equal(run.requests.length, 0);
	mock.timers.tick(1);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(run.requests.length, 1);
});

test("recap prefers current Path state and otherwise uses a compaction summary", async () => {
	const compacted = fixture("Verify the process manager.");
	compacted.entries.push({ type: "compaction", id: "compact", parentId: compacted.entries.at(-1)!.id,
		summary: "SAVED-GOAL: build persistent agent management. Decision: keep Switchbox as the owner.",
		firstKeptEntryId: "4", tokensBefore: 12000 } as never);
	await compacted.run();
	const fallback = compacted.requests[0].context.messages[0].content[0].text;
	assert.match(fallback, /Task anchor\nSAVED-GOAL/);
	assert.doesNotMatch(fallback, /We are building the integrated search pipeline/);

	const path = fixture("Verify the active detour.", [], "", undefined, {
		anchor: () => "PATH-GOAL: persistent agent management. Active detour: recap. Decision: bounded input.",
	});
	await path.run();
	assert.match(path.requests[0].context.messages[0].content[0].text, /Task anchor\nPATH-GOAL/);
});

test("recap chooses the newest summary in branch chronology and respects omissions", async () => {
	const run = fixture("Use the latest task state.");
	run.entries.push({ type: "branch_summary", id: "older-summary", parentId: run.entries.at(-1)!.id,
		summary: "OLDER-BRANCH-GOAL", fromId: "0" } as never);
	run.entries.push({ type: "compaction", id: "newer-summary", parentId: "older-summary",
		summary: "NEWEST-COMPACTION-GOAL", firstKeptEntryId: "0", tokensBefore: 12000 } as never);
	await run.run();
	assert.match(run.requests[0].context.messages[0].content[0].text, /Task anchor\nNEWEST-COMPACTION-GOAL/);
	assert.doesNotMatch(run.requests[0].context.messages[0].content[0].text, /OLDER-BRANCH-GOAL/);
	run.entries.push({ type: "context_edit", id: "omit", parentId: "newer-summary", targetId: "newer-summary", replacement: null } as never);
	await run.run();
	assert.match(run.requests[1].context.messages[0].content[0].text, /Task anchor\nOLDER-BRANCH-GOAL/);
});

test("recap clips only an oversized exchange and omits previous recaps", async () => {
	const run = fixture("Check the current decision.", [], "", [
		user("OPEN-GOAL: build the process manager.", 1),
		assistant("※ recap: OLD-RECAP", 2),
		user("RECENT-CORRECTION: use Switchbox. " + "large detail ".repeat(2000), 3),
		assistant("Use the local manager. " + "large answer ".repeat(2000) + "NEXT-ACTION: verify persistence.", 4),
	]);
	await run.run();
	const context = run.requests[0].context, packet = context.messages[0].content[0].text;
	assert.ok(context.systemPrompt.length + packet.length <= 8000);
	assert.match(packet, /OPEN-GOAL/);
	assert.match(packet, /RECENT-CORRECTION/);
	assert.match(packet, /NEXT-ACTION/);
	assert.match(packet, /middle omitted/);
	assert.doesNotMatch(packet, /OLD-RECAP/);
});

test("session lifecycle clears retained recap while ordinary terminal keys preserve it", async () => {
	const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s } as any;
	for (const event of ["session_tree", "session_start"]) {
		const run = fixture("BRANCH-RECAP");
		run.start();
		await run.run();
		for (const key of ["\u001b[A", "\u001b[B", "\u001b[6~", "\u001b[H"]) {
			run.key(key);
			assert.match(run.activity.renderOverview(theme, 80).join("\n"), /BRANCH-RECAP/, `${event}: ${JSON.stringify(key)}`);
		}
		run.fire(event);
		const screen = run.activity.renderOverview(theme, 80).join("\n");
		assert.doesNotMatch(screen, /BRANCH-RECAP/, event);
		assert.match(screen, /No recap yet\./, event);
		run.fire("session_shutdown");
		run.activity.dispose();
	}
});

test("input, new work and session changes abort an in-flight recap without publishing it", async () => {
	for (const event of ["input", "agent_start", "session_start", "session_tree", "session_shutdown", "model_select"]) {
		const run = fixture("STALE-RECAP");
		run.start();
		const release = run.hold(), pending = run.run();
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(run.requests.length, 1, event);
		if (event === "input") run.input(); else run.fire(event);
		assert.equal(run.requests[0].options.signal.aborted, true, event);
		release();
		await pending;
		assert.ok(run.recaps.every(value => value === undefined), event);
	}
});

test("returning to the terminal and disabling recap cancel generation", async () => {
	for (const action of ["key", "off"]) {
		const run = fixture("STALE-RECAP");
		run.start();
		const release = run.hold(), pending = run.run();
		await new Promise(resolve => setImmediate(resolve));
		if (action === "key") run.key(); else await run.command("off");
		assert.equal(run.requests[0].options.signal.aborted, true, action);
		release();
		await pending;
		assert.ok(run.recaps.every(value => value === undefined), action);
		if (action === "off") await run.command("on");
	}
});

test("cancellation holds the generation lock until the provider promise settles", async () => {
	const run = fixture("No overlapping recap calls.");
	run.start();
	const release = run.hold(), pending = run.run();
	await new Promise(resolve => setImmediate(resolve));
	run.key();
	await run.run();
	assert.equal(run.requests.length, 1);
	assert.match(run.notices.at(-1)!.message, /already generating/);
	release(); await pending;
	await run.run();
	assert.equal(run.requests.length, 2);
});

test("a changed transcript rejects a response even if no lifecycle hook arrived", async () => {
	const run = fixture("STALE-RECAP"), release = run.hold(), pending = run.run();
	await new Promise(resolve => setImmediate(resolve));
	run.entries.push({ type: "message", id: "new", parentId: run.entries.at(-1)!.id,
		message: user("The goal changed while recap was running.", 9) });
	release();
	await pending;
	assert.ok(run.recaps.every(value => value === undefined));
});

test("force testing cannot overlap requests or bypass active or queued work", async () => {
	const run = fixture("Only publish a current recap."), release = run.hold(), pending = run.run();
	await new Promise(resolve => setImmediate(resolve));
	const duplicate = run.run();
	await new Promise(resolve => setImmediate(resolve));
	const requests = run.requests.length;
	release();
	await Promise.all([pending, duplicate]);
	assert.equal(requests, 1);

	for (const gate of ["idle", "pending"]) {
		const blocked = fixture("This must not be requested.");
		if (gate === "idle") blocked.setIdle(false); else blocked.setPending(true);
		await blocked.run();
		assert.equal(blocked.requests.length, 0, gate);
	}
});

test("idle recap waits until background work settles and restarts the five-minute interval", async (t) => {
	mock.timers.enable({ apis: ["setTimeout"] });
	t.after(() => mock.timers.reset());
	let working = true, changed: (() => void) | undefined;
	const run = fixture("Background work is complete.", [], "", undefined, { work: {
		all: () => [{ id: "worker", segment: 1, status: working ? "running" : "complete", settled: !working }] as any,
		subscribe: (listener: () => void) => { changed = listener; return () => { changed = undefined; }; },
	} });
	run.start(); run.input(); run.input();
	await run.settle();
	mock.timers.tick(5 * 60 * 1000);
	assert.equal(run.requests.length, 0);
	working = false; changed?.();
	mock.timers.tick(5 * 60 * 1000 - 1);
	assert.equal(run.requests.length, 0);
	mock.timers.tick(1);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(run.requests.length, 1);
});

test("background work starting mid-call cancels the recap even if it finishes before the reply", async () => {
	let working = false, changed: (() => void) | undefined;
	const run = fixture("STALE-RECAP", [], "", undefined, { work: {
		all: () => [{ id: "worker", segment: 1, status: working ? "running" : "complete", settled: !working }] as any,
		subscribe: (listener: () => void) => { changed = listener; return () => { changed = undefined; }; },
	} });
	run.start();
	const release = run.hold(), pending = run.run();
	await new Promise(resolve => setImmediate(resolve));
	working = true; changed?.();
	assert.equal(run.requests[0].options.signal.aborted, true);
	working = false; changed?.();
	release();
	await pending;
	assert.ok(run.recaps.every(value => value === undefined));
	run.fire("session_shutdown");
});
