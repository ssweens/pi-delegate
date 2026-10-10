// The v2 semantic gate: does a real local model actually maintain the minimal map?
//
// Direct-write cases skip unless MOM_V2_GATE_MODEL (provider/id) and MOM_V2_GATE_URL are set. The
// classifier case additionally requires MOM_V2_GATE_DECIDER_URL (System One base URL) and
// MOM_V2_GATE_DECIDER_MODEL (server model ID). The ordinary suite stays offline and free.
//
//   MOM_V2_GATE_MODEL=omlx/Qwen3.6-35B-A3B-8bit MOM_V2_GATE_URL=http://127.0.0.1:9991/v1 \
//   MOM_V2_GATE_DECIDER_URL=http://192.168.1.52:9999/v1 MOM_V2_GATE_DECIDER_MODEL=beverly-4B \\
//     npx tsx --import ./test/setup.ts --test --test-name-pattern="real decision model" test/mom-v2-semantic.test.ts
//
// The lead is scripted (the fixture provider); Mom and, in the classifier case, the System One
// decision model run for real, so every scenario's evidence is exactly what this file says it is.
import "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { provider, sandbox, harness, OVEN_AVAILABLE, startOven } from "./fixture.ts";

const REF = process.env.MOM_V2_GATE_MODEL ?? "";
const URL = process.env.MOM_V2_GATE_URL ?? "";
const DECIDER_URL = process.env.MOM_V2_GATE_DECIDER_URL ?? "";
const DECIDER_MODEL = process.env.MOM_V2_GATE_DECIDER_MODEL ?? "";
const DECIDER_REF = DECIDER_MODEL ? `gate-classifier/${DECIDER_MODEL}` : "";
/** How long one turn may take before the gate calls it a failure. Every wait in here is bounded by
 *  this, so each test's own budget is derived from the turns it runs. */
const TURN_BUDGET_MS = Number(process.env.MOM_V2_GATE_TURN_MS ?? 60000);
const budgetFor = (turns: number) => turns * TURN_BUDGET_MS + 60000;
const enabled = Boolean(REF && URL && OVEN_AVAILABLE);
const reason = !OVEN_AVAILABLE ? "Oven checkout unavailable; set OVEN_DIR."
	: !REF || !URL ? "set MOM_V2_GATE_MODEL (provider/id) and MOM_V2_GATE_URL (chat-completions base) to run the real-model gate" : "";
const classifierReason = reason || (!DECIDER_URL || !DECIDER_MODEL
	? "also set MOM_V2_GATE_DECIDER_URL (System One base URL) and MOM_V2_GATE_DECIDER_MODEL (server model ID)" : "");

type Stored = { revision: number; nodes: { id: string; kind: string; parent: string | null; state: string; label: string; intent: string; sources: string[] }[]; focus: string | null; purpose: string | null; edges: unknown[] };
type Check = { label: string; ok: boolean };
const work = (map: Stored) => map.nodes.filter(node => ["feature", "theory", "postulate", "try"].includes(node.kind));
const notes = (map: Stored) => map.nodes.filter(node => !["feature", "theory", "postulate", "try"].includes(node.kind));
const found = (map: Stored, re: RegExp) => map.nodes.filter(node => re.test(node.label.toLowerCase()));
/** The work nodes matching a name. Checks about state must use this: a note with the same words is not work. */
const workNamed = (map: Stored, re: RegExp) => work(map).filter(node => re.test(node.label.toLowerCase()));
const noteNamed = (map: Stored, re: RegExp) => notes(map).filter(node => re.test(node.label.toLowerCase()));
const check = (label: string, ok: boolean): Check => ({ label, ok });
const show = (map: Stored) => `focus=${map.focus} ${JSON.stringify(map.nodes.map(node => [node.id, node.kind, node.state, node.parent, node.label]))}`;

interface Gate {
	/** Push a lead turn and its scripted answer; the prompt resolves when Pi settles the turn. */
	prompt(user: string, assistant: string): Promise<void>;
	/** Wait for her to account for the newest turn, then read the map she saved. */
	settle(): Promise<{ map: Stored; covered: boolean }>;
	/** `prompt` + `settle`, throwing only when she saved no map at all. */
	turn(user: string, assistant: string): Promise<Stored>;
	/** Record a scenario's checks and report them the moment they are known. */
	phase(name: string, checks: Check[], map: Stored): void;
	/** Read the real v2 spec decisions logged for this session. */
	specs(): Record<string, any>[];
}

async function withMom(body: (gate: Gate) => Promise<void>, useClassifier = false): Promise<void> {
	const api = await provider(), box = sandbox(api.url);
	// The lead stays on the fixture provider; Mom's model is the local one under test.
	const models = JSON.parse(readFileSync(join(box.agentDir, "models.json"), "utf8"));
	const slash = REF.indexOf("/");
	models.providers[REF.slice(0, slash)] = { api: "openai-completions", baseUrl: URL, apiKey: "local",
		models: [{ id: REF.slice(slash + 1), name: REF, reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] };
	writeFileSync(join(box.agentDir, "models.json"), JSON.stringify(models));
	let register: ((pi: any) => void) | undefined;
	if (useClassifier) {
		const { classify } = await import("@earendil-works/pi-ai/api/typesafe-system-one");
		register = pi => pi.registerProvider("gate-classifier", {
			name: "Real System One classifier for v2 semantic gate", baseUrl: DECIDER_URL, apiKey: "local",
			classifiers: { "typesafe-system-one": { classify } },
			models: [{ id: DECIDER_MODEL, name: DECIDER_MODEL, type: "classifier", api: "typesafe-system-one",
				input: ["text"], contextWindow: 32768, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		});
	}
	const daemon = await startOven(box.root, box.agentDir);
	const { SidecarStore } = await import("../src/mom/sidecar.ts");
	let h: Awaited<ReturnType<typeof harness>> | undefined;
	const phases: { name: string; checks: Check[] }[] = [];
	try {
		console.log(`\n=== v2 semantic gate: ${REF}${useClassifier ? ` with ${DECIDER_REF}` : " without a decision model"}, ${TURN_BUDGET_MS}ms per turn ===`);
		h = await harness(box, undefined, { register, flags: { "mom-model": REF, "mom-mode": "v2", "mom-decider": useClassifier ? DECIDER_REF : "", "mom-interval-ms": "0", "mom-max-wait-ms": "0", "mom-retry-ms": "2000,10000,30000" } });
		const manager = h.runtime.session.sessionManager;
		const records = () => new SidecarStore(() => h!.parent, manager.getSessionId()).load();
		const specs = () => {
			try { return readFileSync(h!.parent.replace(/\.jsonl$/, ".mom-decider"), "utf8").split(/\r?\n/).filter(Boolean)
				.map(line => JSON.parse(line)).filter(record => record.kind === "v2-spec"); }
			catch { return []; }
		};
		const savedMap = async (): Promise<Stored> => {
			const saved = (await records()).findLast(record => record.type === "map" && record.data.snapshot);
			assert(saved, `Mom never saved a map: ${JSON.stringify({ errors: api.errors, extensionErrors: h!.errors })}`);
			return saved.data.snapshot.graph as Stored;
		};
		const prompt = async (user: string, assistant: string): Promise<void> => {
			api.script(user, { text: assistant });
			await h!.runtime.session.prompt(user);
		};
		const settle = async (): Promise<{ map: Stored; covered: boolean }> => {
			const leaf = manager.getLeafId(), started = Date.now();
			if (!leaf) throw new Error("the lead session has no leaf yet");
			let covered = false;
			while (!covered && Date.now() - started < TURN_BUDGET_MS) {
				covered = (await records()).some(record => record.type === "map" && (record.data.cut ?? record.data.snapshot?.cut)?.parent === leaf);
				if (!covered) await new Promise(resolve => setTimeout(resolve, 500));
			}
			return { map: await savedMap(), covered };
		};
		const turn = async (user: string, assistant: string): Promise<Stored> => {
			await prompt(user, assistant);
			const { map, covered } = await settle();
			if (!covered) throw new Error(`Mom did not cover the turn ending at ${manager.getLeafId()} within ${TURN_BUDGET_MS}ms: ${JSON.stringify({ errors: api.errors, extensionErrors: h!.errors })}`);
			return map;
		};
		const phase = (name: string, checks: Check[], map: Stored) => {
			phases.push({ name, checks });
			const failed = checks.filter(item => !item.ok);
			console.log(`  ${failed.length ? "FAIL" : "PASS"}  ${name}${failed.length ? ` — ${failed.map(item => item.label).join("; ")}` : ""}`);
			if (failed.length) {
				console.log(`        map: ${show(map)}`);
				const latestSpec = specs().at(-1);
				if (latestSpec) console.log(`        latest spec: ${JSON.stringify(latestSpec)}`);
			}
		};
		await body({ prompt, settle, turn, phase, specs });
	} catch (error) {
		phases.push({ name: "the scenario itself", checks: [check(`threw: ${String(error).slice(0, 400)}`, false)] });
		console.log(`  FAIL  the scenario itself — threw: ${String(error).slice(0, 300)}`);
	} finally {
		const all = phases.flatMap(entry => entry.checks);
		const failed = phases.flatMap(entry => entry.checks.filter(item => !item.ok).map(item => `${entry.name}: ${item.label}`));
		console.log(`  ${all.length - failed.length}/${all.length} checks passed\n`);
		await h?.runtime.dispose(); await daemon.stop(); await api.close(); rmSync(box.root, { recursive: true, force: true });
		assert.deepEqual(failed, [], `${failed.length} gate checks failed`);
	}
}

test("v2's semantic gate: the map survives a session's worth of work", { timeout: budgetFor(12), skip: enabled ? false : reason }, async () => {
	await withMom(async ({ turn, phase }) => {
		// 1. Cold start: the first durable ask becomes the purpose, in focus, and nothing else exists.
		let map = await turn("I need you to build a CSV export for the reports page, with column selection.",
			"I'll build the CSV export with column selection.");
		const exportNode = () => workNamed(map, /(csv|export)/)[0];
		phase("cold start names the purpose", [
			check("exactly one root work item", work(map).filter(node => node.parent === null).length === 1),
			check("the root is the purpose", map.purpose === work(map).find(node => node.parent === null)?.id),
			check("the ask is work", Boolean(exportNode())),
			check("the ask is active", exportNode()?.state === "active"),
			check("focus is on the ask", map.focus === exportNode()?.id),
			check("the ask cites evidence", (exportNode()?.sources.length ?? 0) > 0),
		], map);

		// 2. Separate work: a second thread appears beside the first, which stays open.
		map = await turn("Separately, add dark mode to the settings page.", "I'll add dark mode to the settings page.");
		const darkNode = () => workNamed(map, /(dark mode|theme)/)[0];
		phase("separate work is added, not merged", [
			check("the new one names dark mode", Boolean(darkNode())),
			check("the new one is active", darkNode()?.state === "active"),
			check("the new one is in focus", map.focus === darkNode()?.id),
			check("the export is still active", exportNode()?.state === "active"),
			check("still one root", work(map).filter(node => node.parent === null).length === 1),
		], map);

		// 3. A standing rule is a rule, not new work.
		const beforeRule = work(map).length;
		map = await turn("From now on, never add a dependency without asking me first.", "Understood — I won't add dependencies without asking.");
		phase("a standing rule is recorded as a rule", [
			check("a rule names the dependency constraint", noteNamed(map, /(dependenc|package|install)/).some(node => node.kind === "rule")),
			check("no new work node", work(map).length === beforeRule),
			check("the rule hangs off work", noteNamed(map, /(dependenc|package|install)/).every(node => node.parent !== null)),
		], map);

		// 4. A reported outcome settles that work — and only that work.
		map = await turn("How's the dark mode going?", "Done — dark mode is implemented and I checked it in the browser.");
		phase("a reported outcome settles its work", [
			check("dark mode is settled", darkNode()?.state === "settled"),
			check("the export is untouched", exportNode()?.state === "active"),
			check("still one root", work(map).filter(node => node.parent === null).length === 1),
		], map);

		// 5. A caveat must not settle anything.
		map = await turn("And the export?", "The CSV export is written, but I have not run its tests yet.");
		phase("a caveat does not settle work", [
			check("the export is not settled", exportNode() ? exportNode()?.state !== "settled" : false),
		], map);

		// 6. Its stated outcome does.
		map = await turn("Run them now.", "Ran them: the export tests pass, 14 of 14, and the export is done.");
		phase("its stated outcome settles it", [
			check("the export is settled", exportNode()?.state === "settled"),
		], map);

		// 7. A correction reopens what it invalidates.
		map = await turn("Wait — the export ignores the date filter. That's wrong; fix it.", "You're right, the date filter is ignored. Fixing the export.");
		phase("a correction reopens its work", [
			check("the export is no longer settled", exportNode()?.state !== "settled"),
			check("the export is still there", Boolean(exportNode())),
			check("no settled work holds open work", work(map).every(node => node.state !== "settled"
				|| !work(map).some(child => child.parent === node.id && ["active", "parked"].includes(child.state)))),
		], map);

		// 8. New work, and the displaced work parks rather than disappears.
		map = await turn("Park the export for now. I need SSO login working before the demo.", "Parking the export; starting SSO login.");
		const ssoNode = () => workNamed(map, /(sso|login|sign.?in)/)[0];
		phase("a pivot parks what it displaces", [
			check("SSO is new work", Boolean(ssoNode()) && ["active", "parked"].includes(ssoNode()!.state)),
			check("SSO is in focus", map.focus === ssoNode()?.id),
			check("the export is parked or settled", exportNode() ? ["parked", "settled"].includes(exportNode()!.state) : true),
			check("the export was not deleted", Boolean(exportNode())),
		], map);

		// 9. A decision is recorded, not turned into a second work item.
		map = await turn("For SSO, let's go with the token-based approach, not SAML.", "Token-based it is.");
		phase("a decision is recorded, not duplicated", [
			check("a rule or note records the choice", noteNamed(map, /(token|saml|approach|auth)/).length > 0),
			check("no duplicate SSO work item", workNamed(map, /(sso|login|sign.?in)/).length <= 1),
		], map);

		// 10. Dropped work leaves the board — and the board stays.
		map = await turn("We're not shipping the CSV export this cycle — drop it.", "Dropping the CSV export.");
		phase("dropped work leaves the board", [
			check("no active export work", workNamed(map, /(csv|export)/).every(node => node.state !== "active")),
			check("the map was not emptied", work(map).length > 0),
			check("the drop is recorded", noteNamed(map, /(drop|not shipping|cancel)/).length > 0 || workNamed(map, /(csv|export)/).length === 0),
			check("the SSO work is untouched", ssoNode() ? ["active", "parked"].includes(ssoNode()!.state) : false),
		], map);

		// 11. A status question changes nothing. Compare what the map says, not its sources: a source
		// accumulates on a node that is re-cited, by design.
		const shape = (value: Stored) => JSON.stringify(value.nodes.map(node => [node.id, node.kind, node.parent, node.state, node.label]).sort()) + JSON.stringify(value.focus);
		const beforeQuiet = shape(map);
		map = await turn("where are we?", "SSO login is in progress; the CSV export is dropped.");
		phase("a status question changes nothing", [
			check("the map still says the same thing", shape(map) === beforeQuiet),
		], map);
	});
});

test("v2's semantic gate: a drop can never empty the map", { timeout: budgetFor(3), skip: enabled ? false : reason }, async () => {
	await withMom(async ({ prompt, settle, turn, phase }) => {
		await turn("I need you to build a CSV export for the reports page.", "I'll build the CSV export.");
		const withBoth = await turn("Separately, I need SSO login working before the demo.", "Starting SSO login.");
		const sso = workNamed(withBoth, /(sso|login|sign.?in)/)[0];
		assert(sso, `the run needs SSO work on the map before the drop: ${show(withBoth)}`);

		// The drop she used to answer by deleting everything. Her model gets one repair; a missing
		// coverage record is a check here, never a throw, because the saved map is the evidence.
		await prompt("We're not shipping the CSV export this cycle — drop it.", "Dropping the CSV export.");
		const { map, covered } = await settle();
		const ssoAfter = workNamed(map, /(sso|login|sign.?in)/)[0];
		phase("a drop can never empty the map", [
			check("she produced an acceptable commit", covered),
			check("the map was not emptied", work(map).length > 0),
			check("the SSO work survived", Boolean(ssoAfter)),
			check("the SSO state is unchanged", ssoAfter?.state === sso.state),
			check("no active export work", workNamed(map, /(csv|export)/).every(node => node.state !== "active")),
			check("still one root", work(map).filter(node => node.parent === null).length === 1),
		], map);
	});
});

test("v2's semantic gate: the real decision model constrains edits and skips no-ops", { timeout: budgetFor(7), skip: classifierReason || false }, async () => {
	await withMom(async ({ prompt, settle, turn, phase, specs }) => {
		const shape = (value: Stored) => JSON.stringify(value.nodes.map(node => [node.id, node.kind, node.parent, node.state, node.label]).sort()) + JSON.stringify(value.focus);
		let map = await turn("I need a reports page.", "I'll build the reports page.");
		const purpose = () => work(map).find(node => node.parent === null);
		phase("classifier gate cold start", [
			check("one active root is the saved purpose", Boolean(purpose() && purpose()!.id === map.purpose && purpose()!.state === "active")),
			check("reports page is active work", workNamed(map, /reports page/).some(node => node.state === "active")),
		], map);

		map = await turn("Separately, I need you to build a CSV export for the reports page, with column selection.", "I'll build the CSV export with column selection.");
		const csv = () => workNamed(map, /(csv|export)/)[0];
		phase("classifier permits new work", [
			check("CSV export is active work", csv()?.state === "active"),
			check("the classifier emitted new_work", specs().at(-1)?.ops?.some((op: any) => op.kind === "new_work")),
		], map);

		map = await turn("Separately, add dark mode to settings.", "I'll add dark mode to settings.");
		const dark = () => workNamed(map, /(dark mode|theme)/)[0];
		phase("classifier preserves separate work", [
			check("dark mode is active", dark()?.state === "active"),
			check("CSV stays active", csv()?.state === "active"),
			check("the classifier emitted new_work", specs().at(-1)?.ops?.some((op: any) => op.kind === "new_work")),
		], map);

		map = await turn("Ran them: the export tests pass, 14 of 14, and the export is done.", "The export tests pass; the CSV export is done.");
		phase("classifier constrains a finished state", [
			check("CSV is settled", csv()?.state === "settled"),
			check("dark mode stays active", dark()?.state === "active"),
			check("the classifier emitted finished for CSV", specs().at(-1)?.ops?.some((op: any) => op.kind === "state" && op.to === "finished")),
		], map);

		map = await turn("We're not shipping the CSV export this cycle — drop it.", "Dropping the CSV export.");
		phase("classifier constrains a drop", [
			check("CSV work was removed", !csv()),
			check("dark mode remains active", dark()?.state === "active"),
			check("the classifier emitted dropped for CSV", specs().at(-1)?.ops?.some((op: any) => op.kind === "state" && op.to === "dropped")),
		], map);

		const before = shape(map);
		await prompt("Where are we?", "The reports page and dark mode are active; the CSV export is dropped.");
		const { map: after, covered } = await settle();
		const noOp = specs().at(-1);
		phase("classifier skips a no-op", [
			check("the batch was covered", covered),
			check("the map is unchanged", shape(after) === before),
			check("the complete empty spec skipped Mom", noOp?.ran === false && Array.isArray(noOp.ops) && noOp.ops.length === 0),
		], after);
	}, true);
});
