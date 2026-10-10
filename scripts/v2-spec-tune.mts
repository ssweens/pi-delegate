// Tuning the change-spec questions. Beverly only.
//   npx tsx scripts/v2-spec-tune.mts tuning | holdout
// Per work node, two choice questions — its state, and what attaches to it — plus one whole-map
// question for work that is not on the map. Choices are read by argmax; no threshold to fit.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Decider, type DeciderAnswer, type DeciderQuestion } from "../src/mom/decider.ts";

const URL_ = process.env.SPEC_CAL_URL ?? "http://192.168.1.52:9999/v1/systemone";
const MODEL = process.env.SPEC_CAL_MODEL ?? "beverly-4B";
const decider = new Decider(URL_, 60000, MODEL);
const mode = process.argv[2] ?? "tuning";
const DEBUG_NEW_WORK = process.env.DEBUG_NEW_WORK === "1";
const DEBUG_ATTACH = process.env.DEBUG_ATTACH === "1";
const FLOOR = 0.25; // an op below this is not a decision, whatever the argmax
const FITTED_DIR = process.env.SPEC_CAL_DIR || join(tmpdir(), "v2-spec-tune");
const FITTED_PATH = join(FITTED_DIR, "fitted.json");

type State = "active" | "parked" | "settled";
interface Node { id: string; parent?: string | null; kind: "work" | "rule" | "note"; state?: State; label: string }
interface Pair { name: string; map: Node[]; focus?: string; user?: string; assistant?: string; expect: Record<string, boolean | string> }

const csv = (state: State): Node => ({ id: "csv-export", kind: "work", state, label: "CSV export for the reports page" });
const dark = (state: State): Node => ({ id: "dark-mode", kind: "work", state, label: "Dark mode for the settings page" });
const sso = (state: State): Node => ({ id: "sso-login", kind: "work", state, label: "SSO login working before the demo" });
const dep = (): Node => ({ id: "dep-rule", parent: "csv-export", kind: "rule", label: "Never add a dependency without asking" });
/** Both answers for one quiet node; spread these FIRST, then the expectations that differ. */
const quiet = (id: string): Record<string, boolean | string> => ({ [`state__${id}`]: "none", [`attach__${id}`]: "none" });
const falseFor = (ids: string[]): Record<string, boolean | string> => Object.fromEntries(ids.flatMap(id => Object.entries(quiet(id))));

const tuning: Pair[] = [
	{ name: "1 cold start", map: [], user: "I need you to build a CSV export for the reports page, with column selection.", expect: { new_work: true } },
	{ name: "2 separate work", map: [csv("active")], focus: "csv-export", user: "Separately, add dark mode to the settings page.",
		expect: { ...quiet("csv-export"), new_work: true } },
	{ name: "3 standing rule", map: [csv("active"), dark("active")], focus: "csv-export", user: "From now on, never add a dependency without asking me first.",
		expect: { ...quiet("csv-export"), ...quiet("dark-mode"), "attach__csv-export": "rule", "attach__dark-mode": "none|rule", new_work: false } },
	{ name: "4 outcome reported", map: [csv("active"), dark("active")], focus: "csv-export", assistant: "Done — dark mode is implemented and I checked it in the browser.",
		expect: { ...quiet("csv-export"), ...quiet("dark-mode"), "state__dark-mode": "finished", new_work: false } },
	{ name: "5 caveat", map: [csv("active"), dark("settled")], focus: "csv-export", assistant: "The CSV export is written, but I have not run its tests yet.",
		expect: { ...quiet("csv-export"), ...quiet("dark-mode"), new_work: false } },
	{ name: "6 stated outcome", map: [csv("active"), dark("settled")], focus: "csv-export", assistant: "Ran them: the export tests pass, 14 of 14, and the export is done.",
		expect: { ...quiet("csv-export"), ...quiet("dark-mode"), "state__csv-export": "finished", new_work: false } },
	{ name: "7 correction reopens", map: [csv("settled"), dark("settled")], focus: "dark-mode", user: "Wait — the export ignores the date filter. That's wrong; fix it.",
		expect: { ...quiet("csv-export"), ...quiet("dark-mode"), "state__csv-export": "reopened", "attach__csv-export": "none|rule|child", new_work: false } },
	{ name: "8 pivot to new demo work", map: [csv("active"), dark("settled")], focus: "csv-export", user: "Park the export for now. I need SSO login working before the demo.",
		expect: { ...quiet("csv-export"), ...quiet("dark-mode"), "state__csv-export": "deferred", new_work: true, focus: "new" } },
	{ name: "9 decision on current work", map: [csv("parked"), sso("active")], focus: "sso-login", user: "For SSO, let's go with the token-based approach, not SAML.",
		expect: { ...quiet("csv-export"), ...quiet("sso-login"), "attach__sso-login": "note", new_work: false } },
	{ name: "10 drop, user only", map: [csv("parked"), sso("active")], focus: "sso-login", user: "We're not shipping the CSV export this cycle — drop it.",
		expect: { ...quiet("csv-export"), ...quiet("sso-login"), "state__csv-export": "dropped", "attach__csv-export": "none|note", new_work: false } },
	{ name: "11 drop, with reply", map: [csv("parked"), sso("active")], focus: "csv-export",
		user: "We're not shipping the CSV export this cycle — drop it.", assistant: "Dropping the CSV export.",
		expect: { ...quiet("csv-export"), ...quiet("sso-login"), "state__csv-export": "dropped", "attach__csv-export": "none|note", new_work: false, focus: "sso-login" } },
	{ name: "12 status question", map: [sso("active")], focus: "sso-login", user: "where are we?", assistant: "SSO login is in progress.",
		expect: { ...quiet("sso-login"), new_work: false } },
	{ name: "13 thanks", map: [sso("active")], focus: "sso-login", user: "thanks", assistant: "You're welcome.",
		expect: { ...quiet("sso-login"), new_work: false } },
	{ name: "14 one-off explanation", map: [sso("active")], focus: "sso-login", user: "why is no-unused-vars flagging the handler args?",
		assistant: "Because the express handler declares next but never uses it; prefixing with _ silences the rule.",
		expect: { ...quiet("sso-login"), new_work: false } },
	{ name: "15 attention back to parked work", map: [csv("active"), dark("parked")], focus: "csv-export", user: "Forget the export for now — the dark mode toggle is the priority.",
		expect: { ...quiet("csv-export"), ...quiet("dark-mode"), "state__dark-mode": "resumed|deferred", "state__csv-export": "deferred", new_work: false, focus: "dark-mode" } },
	{ name: "16 failure report", map: [csv("active")], focus: "csv-export", assistant: "The export build fails: the bundler can't resolve the workspace package. I can't proceed until that's fixed.",
		expect: { ...quiet("csv-export"), "attach__csv-export": "note", new_work: false } },
	{ name: "17 scope change on existing work", map: [csv("active"), dep()], focus: "csv-export", user: "The export also needs to include the current filter state.",
		expect: { ...quiet("csv-export"), "attach__csv-export": "rule|child", new_work: false } },
	{ name: "18 approved proposal", map: [csv("active")], focus: "csv-export", user: "yes, go ahead", assistant: "Want me to add the missing export tests?",
		expect: { ...quiet("csv-export"), new_work: true, "attach__csv-export": "child" } },
	{ name: "19 bare status ping", map: [csv("active"), sso("parked")], focus: "csv-export", user: "status?",
		expect: { ...falseFor(["csv-export", "sso-login"]), new_work: false } },
	{ name: "20 rule lifted", map: [csv("active"), dep()], focus: "csv-export", user: "Actually you can add dependencies, just ask me first.",
		expect: { ...quiet("csv-export"), "attach__csv-export": "rule", new_work: false } },
];

/** Written after tuning, on the tuned wording: the same operations in different words. */
const holdout: Pair[] = [
	{ name: "H1 first ask, other words", map: [], user: "Let's get the reports page exporting to CSV.", expect: { new_work: true } },
	{ name: "H2 new separate thread", map: [csv("active")], focus: "csv-export", user: "Next, I want the settings page to have a dark theme.",
		expect: { ...quiet("csv-export"), new_work: true } },
	{ name: "H3 prohibition", map: [csv("active")], focus: "csv-export", user: "Don't ever touch the migration files without asking.",
		expect: { ...quiet("csv-export"), "attach__csv-export": "rule", new_work: false } },
	{ name: "H4 completion, other words", map: [csv("active")], focus: "csv-export", assistant: "The export is wrapped up: it writes the file and the browser check passed.",
		expect: { ...quiet("csv-export"), "state__csv-export": "finished", new_work: false } },
	{ name: "H5 half-done", map: [csv("active")], focus: "csv-export", assistant: "The export writes the file now, but the date filter is still ignored.",
		expect: { ...quiet("csv-export"), new_work: false } },
	{ name: "H6 rejected outcome", map: [csv("settled")], focus: "csv-export", user: "The export is broken — the columns are in the wrong order.",
		expect: { ...quiet("csv-export"), "state__csv-export": "reopened", new_work: false } },
	{ name: "H7 abandonment", map: [csv("parked"), sso("active")], focus: "sso-login", user: "Scrap the export entirely.",
		expect: { ...quiet("csv-export"), ...quiet("sso-login"), "state__csv-export": "dropped", "attach__csv-export": "none|note", new_work: false } },
	{ name: "H8 pure status question", map: [csv("active")], focus: "csv-export", user: "how's it looking?",
		expect: { ...quiet("csv-export"), new_work: false } },
	{ name: "H9 idea, not yet work", map: [csv("active")], focus: "csv-export", assistant: "One thought: we could cache the report query instead of re-running it.",
		expect: { ...quiet("csv-export"), "attach__csv-export": "note", new_work: false } },
	{ name: "H10 measurement", map: [csv("active")], focus: "csv-export", assistant: "The export runs in 1.4s for 12k rows, down from 9s.",
		expect: { ...quiet("csv-export"), "attach__csv-export": "note", new_work: false } },
];

/** Fresh shapes, never used to fit anything: the out-of-sample check on the new-work rule.
 *  Four that name something to do, six that do not. */
const gap: Pair[] = [
	{ name: "G1 ship the audit log", map: [csv("active"), { id: "lint", parent: "csv-export", kind: "work", state: "parked", label: "Fix the lint errors" }], focus: "csv-export",
		user: "Let's also ship the audit log this sprint.", expect: { new_work: true } },
	{ name: "G2 build the import tool", map: [csv("active"), { id: "lint", parent: "csv-export", kind: "work", state: "parked", label: "Fix the lint errors" }], focus: "csv-export",
		user: "Can you build the import tool next?", expect: { new_work: true } },
	{ name: "G3 need an export", map: [csv("active"), { id: "lint", parent: "csv-export", kind: "work", state: "parked", label: "Fix the lint errors" }], focus: "csv-export",
		user: "I need a way to export the audit trail.", expect: { new_work: true } },
	{ name: "G4 invoices download", map: [csv("active"), { id: "lint", parent: "csv-export", kind: "work", state: "parked", label: "Fix the lint errors" }], focus: "csv-export",
		user: "Next up: the billing page should let users download invoices.", expect: { new_work: true } },
	{ name: "G5 export is fine", map: [csv("active"), { id: "lint", parent: "csv-export", kind: "work", state: "parked", label: "Fix the lint errors" }], focus: "csv-export",
		user: "The export is fine as it is.", expect: { new_work: false } },
	{ name: "G6 cancel the export", map: [csv("active"), { id: "lint", parent: "csv-export", kind: "work", state: "parked", label: "Fix the lint errors" }], focus: "csv-export",
		user: "Cancel the export work — I don't want it.", expect: { new_work: false } },
	{ name: "G7 change to utf-8", map: [csv("active"), { id: "lint", parent: "csv-export", kind: "work", state: "parked", label: "Fix the lint errors" }], focus: "csv-export",
		user: "Change the export to use UTF-8.", expect: { new_work: false } },
	{ name: "G8 why dropped", map: [csv("active"), { id: "lint", parent: "csv-export", kind: "work", state: "parked", label: "Fix the lint errors" }], focus: "csv-export",
		user: "Remind me why we dropped the export.", expect: { new_work: false } },
	{ name: "G9 lint is priority", map: [csv("active"), { id: "lint", parent: "csv-export", kind: "work", state: "parked", label: "Fix the lint errors" }], focus: "csv-export",
		user: "Make the lint fix the priority.", expect: { new_work: false } },
	{ name: "G10 add a rule", map: [csv("active"), { id: "lint", parent: "csv-export", kind: "work", state: "parked", label: "Fix the lint errors" }], focus: "csv-export",
		user: "Add a rule: no new dependencies without asking.", expect: { new_work: false } },
];

/** Written after the last wording change, with no pair-specific fitting: the honest out-of-sample check. */
const fresh2: Pair[] = [
	{ name: "F1 add an import", map: [csv("active"), { id: "lint", parent: "csv-export", kind: "work", state: "parked", label: "Fix the lint errors" }], focus: "csv-export",
		user: "Add a CSV import to the admin page.", expect: { new_work: true } },
	{ name: "F2 need rate limiting", map: [csv("active"), { id: "lint", parent: "csv-export", kind: "work", state: "parked", label: "Fix the lint errors" }], focus: "csv-export",
		user: "We're going to need rate limiting before launch.", expect: { new_work: true } },
	{ name: "F3 wire up slack", map: [csv("active"), { id: "lint", parent: "csv-export", kind: "work", state: "parked", label: "Fix the lint errors" }], focus: "csv-export",
		user: "Please wire up the Slack notifications.", expect: { new_work: true } },
	{ name: "F4 wants a dashboard", map: [csv("active"), { id: "lint", parent: "csv-export", kind: "work", state: "parked", label: "Fix the lint errors" }], focus: "csv-export",
		user: "The team wants a dashboard for the pipeline.", expect: { new_work: true } },
	{ name: "F5 change to tabs", map: [csv("active"), { id: "lint", parent: "csv-export", kind: "work", state: "parked", label: "Fix the lint errors" }], focus: "csv-export",
		user: "Nudge the export to use tabs instead of commas.", expect: { new_work: false } },
	{ name: "F6 forget the audit log", map: [csv("active"), { id: "lint", parent: "csv-export", kind: "work", state: "parked", label: "Fix the lint errors" }], focus: "csv-export",
		user: "Forget the audit log for now.", expect: { new_work: false } },
	{ name: "F7 is it done", map: [csv("active"), { id: "lint", parent: "csv-export", kind: "work", state: "parked", label: "Fix the lint errors" }], focus: "csv-export",
		user: "Is the export done?", expect: { new_work: false } },
	{ name: "F8 that works", map: [csv("active"), { id: "lint", parent: "csv-export", kind: "work", state: "parked", label: "Fix the lint errors" }], focus: "csv-export",
		user: "Great, that works now.", expect: { new_work: false } },
];

const noul = (instructions: string): DeciderQuestion => ({ type: "noul", instructions, criteria: { true: "Yes.", false: "No." } });
const STATE_CHOICES = (node: Node): Record<string, string> => {
	const choices: Record<string, string> = { none: `It neither reports ${node.id} finished nor changes what happens to it — a partial result, an in-flight update, or a caveat about unfinished work is not a state change.` };
	if (node.state === "active") choices.finished = `The activity reports ${node.id} finished: a statement that its tests or checks pass, that it works, or that it is complete or shipped counts as finished, however brief. An open caveat does not count.`;
	if (node.state === "active") choices.deferred = `The user explicitly sets ${node.id} aside or parks it.`;
	if (node.state === "parked") choices.resumed = `The user picks ${node.id} back up as the thing to work on now.`;
	if (node.state === "settled") choices.reopened = `It rejects ${node.id}'s recorded outcome, or asks for work on ${node.id} the map records as finished.`;
	choices.dropped = `It abandons ${node.id} — not wanted, not shipping, to be scrapped — so it no longer belongs on the map.`;
	return choices;
};
const ATTACH_CHOICES = (node: Node): Record<string, string> => ({
	none: `Nothing attaches to ${node.id}.`,
	child: `The activity asks for work that belongs under ${node.id}, rather than as separate work.`,
	rule: `It sets, changes or lifts a standing rule for ${node.id} — an instruction meant to hold beyond this turn.`,
	note: `It establishes a decision or finding worth keeping about ${node.id} — a choice, a root cause, a measured result, a risk or a blocker — that the map does not record.`,
});
function questions(pair: Pair): Record<string, DeciderQuestion> {
	const q: Record<string, DeciderQuestion> = {
		new_work: { type: "choice", instructions: "What does the user's own message in this activity do?",
			criteria: { new_only: "It approves an offer of work, or names or states a need for work that no item on the map covers yet — a thing to build, add, fix or have (\"I need a way to export the audit trail\" names something to build). A message whose only content is an approval (\"yes, go ahead\", \"do it\", \"please\") is new work: nothing else in it asks about existing work. Saying yes to \"shall I do X\" is new work even when X will live under an item already on the map.",
				existing_only: "It asks only of work already on the map: to work on it, correct it, decide or choose between approaches for it, park, drop, set a rule for it, change what it must cover, or declare one existing item the priority over another. An urgent or imperative instruction about map work, and a request to get to work on an item already on the map, is still existing, not new work — choosing an approach for existing work is not new work, however decisive the phrasing.",
				new_and_existing: "It names new work that no item on the map covers AND also asks something of work already on the map — for instance parking or dropping existing work while requesting the new item. If it names no new item, it is existing, not both.",
				report_only: "It reports, acknowledges or confirms something that happened, or asks for an explanation of it. It asks for no change to the map.",
				nothing: "Nothing in it needs doing or deciding." } },
	};
	for (const node of pair.map.filter(entry => entry.kind === "work")) {
		q[`state__${node.id}`] = { type: "choice", instructions: `Work item "${node.label}" is ${node.state}. What did the new activity do to its state?`, criteria: STATE_CHOICES(node) };
		q[`attach__${node.id}`] = { type: "choice", instructions: `Beyond its state, what does the new activity add to work item "${node.label}"?`, criteria: ATTACH_CHOICES(node) };
	}
	return q;
}
function state(pair: Pair): string {
	const kids = new Map<string, Node[]>();
	for (const node of pair.map) if (node.parent) kids.set(node.parent, [...(kids.get(node.parent) ?? []), node]);
	const lines: string[] = [];
	const visit = (node: Node, depth: number) => {
		lines.push(`${"  ".repeat(depth)}- ${node.kind}${node.state ? ` [${node.state}]` : ""} ${node.id}: ${node.label}${node.id === pair.focus ? "  <-- current" : ""}`);
		for (const child of kids.get(node.id) ?? []) visit(child, depth + 1);
	};
	for (const node of pair.map.filter(entry => !entry.parent)) visit(node, 0);
	if (!lines.length) lines.push("(empty)");
	return `CURRENT WORK MAP\n${lines.join("\n")}\n\nNEW ACTIVITY IN THE SESSION\n${pair.user ? `user: ${pair.user}\n` : ""}${pair.assistant ? `assistant: ${pair.assistant}` : ""}`;
}
/** Focus follows from the ops the spec carries; it is never asked. */
function derivedFocus(pair: Pair, chosen: Map<string, { state: string; attach: string }>, added: boolean): string | undefined {
	const resumed = [...chosen].find(([, op]) => op.state === "resumed");
	if (resumed) return resumed[0];
	const reopened = [...chosen].find(([, op]) => op.state === "reopened");
	if (reopened) return reopened[0];
	if (added) return "new";
	if (pair.focus && chosen.get(pair.focus)?.state === "dropped") return [...chosen].find(([id, op]) => op.state !== "dropped" && id !== pair.focus)?.[0] ?? "new";
	return pair.focus;
}

const pairs = mode === "gap" ? gap : mode === "fresh2" ? fresh2 : mode === "holdout" ? holdout : tuning;
const fitted = mode === "tuning" ? {} : JSON.parse(readFileSync(FITTED_PATH, "utf8"));
// Matches src/mom/spec.ts: pooled over 48 pairs the gap is +0.01 (hardest true 0.56, hardest false
// 0.55), and the never-fitted sets separate by 0.14-0.23. 0.50 keeps 0.06 of slack to the hardest true
// case where 0.55 would score perfectly and sit 0.005 from it — the op only permits an addition, so a
// missed ask is the costly error and a spurious permission is cheap.
const NEW_WORK_MASS = fitted.new_work ?? 0.5;
const byFamily: Record<string, { hit: number; n: number; misses: string[] }> = {};
let hit = 0, total = 0; const failed: string[] = [];
console.log(`\n=== ${mode}: ${pairs.length} pairs, ${MODEL}, new-work mass (work+both) >= ${NEW_WORK_MASS} ===`);
for (const pair of pairs) {
	const qs = questions(pair);
	const { answers } = await decider.ask(state(pair), qs);
	const ranked = (name: string): [string, number][] => {
		const answer: DeciderAnswer | undefined = answers[name as keyof typeof answers];
		if (!answer) return [];
		return answer.type === "noul" ? [["true", answer.noul]] : Object.entries(answer.probabilities).filter(([, v]) => typeof v === "number").sort((a, b) => b[1] - a[1]) as [string, number][];
	};
	const chosen = new Map<string, { state: string; attach: string }>();
	for (const node of pair.map.filter(entry => entry.kind === "work")) {
		const stateList = ranked(`state__${node.id}`), attachList = ranked(`attach__${node.id}`);
		// An attachment needs a clear win over "nothing attaches": a spurious child is a phantom work item.
		const none = attachList.find(([key]) => key === "none")?.[1] ?? 0;
		const top = attachList[0];
		chosen.set(node.id, {
			state: stateList[0] && stateList[0][1] >= FLOOR ? stateList[0][0] : "none",
			attach: top && top[1] >= FLOOR && (top[0] === "none" || top[1] - none >= 0.05) ? top[0] : "none" });
	}
	// New work is read as the probability MASS on the two names that mean it, not as an argmax: a
	// single message that abandons existing work scored `both` 0.46 against `existing` 0.39 and was
	// taken for new work, while genuine new asks sat as low as 0.31 on the winning name.
	const newMass = Object.fromEntries(ranked("new_work"));
	const added = (newMass.new_only ?? 0) + (newMass.new_and_existing ?? 0) >= NEW_WORK_MASS;
	let pairHit = 0; const wrong: string[] = [];
	for (const [name, want] of Object.entries(pair.expect)) {
		const family = name.includes("__") ? name.split("__")[0] : name;
		// Names read `<question>__<nodeId>`.
		const [kind = "", id = ""] = name.split("__");
		let ok: boolean, shown: string;
		if (name === "focus") { const got = derivedFocus(pair, chosen, added) ?? ""; ok = got === String(want); shown = got; }
		else if (name === "new_work") { ok = added === (want === true); shown = ranked("new_work").slice(0, 3).map(([k, v]) => `${k}:${v.toFixed(2)}`).join(", ");
			if (DEBUG_NEW_WORK) console.log(`       new_work [${want}] ${ranked("new_work").map(([k, v]) => `${k}:${v.toFixed(2)}`).join(", ")}`); }
		else { const got = (chosen.get(id) as any)?.[kind] ?? ""; ok = String(want).split("|").includes(got); shown = `${got} — ${ranked(name).slice(0, 3).map(([k, v]) => `${k}:${v.toFixed(2)}`).join(", ")}`; if (DEBUG_ATTACH && kind === "attach") console.log(`       attach ${id.padEnd(11)} [${want}] ${ranked(name).map(([k, v]) => `${k}:${v.toFixed(2)}`).join(", ")}`); }
		byFamily[family] ??= { hit: 0, n: 0, misses: [] }; byFamily[family]!.n++;
		total++; if (ok) { hit++; pairHit++; byFamily[family]!.hit++; } else { wrong.push(name); byFamily[family]!.misses.push(`${pair.name}:${name}`); }
		if (!ok) failed.push(`${pair.name} :: ${name} (want ${want}) — ${shown}`);
	}
	console.log(`  ${wrong.length ? "MISS" : "OK  "}  ${pair.name.padEnd(34)} ${pairHit}/${Object.keys(pair.expect).length}${wrong.length ? `   ${wrong.join(", ")}` : ""}`);
}
console.log(`\n  ${hit}/${total} signals correct`);
for (const [family, row] of Object.entries(byFamily).sort((a, b) => a[1].hit / a[1].n - b[1].hit / b[1].n))
	console.log(`    ${family.padEnd(10)} ${String(row.hit).padStart(3)}/${row.n}`);
console.log("  misses:"); for (const line of failed) console.log(`    ${line}`);
if (mode === "tuning") {
	mkdirSync(FITTED_DIR, { recursive: true });
	writeFileSync(FITTED_PATH, JSON.stringify({ new_work: NEW_WORK_MASS }, null, 1) + "\n");
}
