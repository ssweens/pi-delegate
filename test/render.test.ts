import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";

// keyHint resolves real keybindings on first use; keep that away from this machine's config.
process.env.HOME = mkdtempSync(join(tmpdir(), "pi-delegate-render-"));
process.env.PI_CODING_AGENT_DIR = join(process.env.HOME, "agent");
// keyHint styles through the real theme singleton, which the app initializes at startup.
const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme();
const { previewLines, resultView, displayDealProvider, displayDealRate, displayDealWindow } = await import("../src/render.ts");
const { DealSheet } = await import("../src/deals-sheet.ts");

const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text, italic: (text: string) => text, bg: (_color: string, text: string) => text };
// Flattened, since assertions about phrases must survive ordinary line wrapping.
const render = (result: any, opts: { expanded?: boolean } = {}, action?: string) =>
	resultView("delegate_ctl", action, "scout", result, opts, theme, 80).join(" ").replace(/\s+/g, " ");

test("a control report previews its head and says how much it withheld", () => {
	const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
	const preview = previewLines(lines, 8);
	assert.deepEqual(preview.shown, lines.slice(0, 8), "the head is what these reports lead with");
	assert.equal(preview.hidden, 12);
	const short = previewLines(lines.slice(0, 5), 8);
	assert.deepEqual(short, { shown: lines.slice(0, 5), hidden: 0 }, "nothing is clipped, and no hint is owed");
	assert.deepEqual(previewLines([], 8), { shown: [], hidden: 0 });
});

// A crash reproduced from a live session: /reload re-renders records written by earlier versions,
// and a renderer that trusts today's details shape takes the whole app down on them.
test("a roles record written before the tools column still renders, from its text", () => {
	const legacy = {
		content: [{ type: "text", text: "scout  [fresh:low]  default: none — needs approval  Read-only recon of code the parent has not seen.  (~/roles/scout.md)" }],
		details: { kind: "roles", rows: [{ name: "scout", mode: "fresh:low", model: "needs approval", description: "Read-only recon of code the parent has not seen.", source: "~/roles/scout.md" }] },
	};
	const collapsed = render(legacy);
	assert.match(collapsed, /Read-only recon of code the parent has not seen/, "the text path is complete by construction");
	assert.match(render(legacy, { expanded: true }), /Read-only recon of code/);

	for (const rows of [[{}], "oops", [null], [{ name: "scout" }], undefined]) {
		const lines = render({ content: [{ type: "text", text: "unchanged text" }], details: { kind: "roles", rows } });
		assert.match(lines, /unchanged text/, `unusable rows (${JSON.stringify(rows)}) fall back to the text`);
	}
});

test("a current roles record renders as a table, with the prose behind the expand", () => {
	const current = {
		content: [{ type: "text", text: "scout  [fresh:low]  no default: needs approval  Read-only recon" }],
		details: { kind: "roles", rows: [
			{ name: "scout", mode: "fresh:low", model: "needs approval", approved: false, writes: false, tools: ["read", "grep", "find", "ls", "bash"], dropped: [], timeoutMs: undefined, description: "Read-only recon of code the parent has not seen.", source: "~/roles/scout.md" },
			{ name: "worker", mode: "fork:medium", model: "needs approval", approved: false, writes: true, tools: ["read", "bash", "edit", "write", "grep", "find", "ls"], dropped: ["playwright"], timeoutMs: 1800000, description: "Implements a bounded change.", source: "~/roles/worker.md" },
		] },
	};
	const collapsed = render(current);
	assert.match(collapsed, /scout\s+fresh:low\s+needs approval\s+read-only · 5 tools/);
	assert.match(collapsed, /worker\s+fork:medium\s+needs approval\s+writes · 7 tools · 30m · 1 unavailable/);
	assert.doesNotMatch(collapsed, /Read-only recon of code/, "no row ends mid-sentence");
	assert.match(collapsed, /what each role is for, and where it comes from/);

	const expanded = render(current, { expanded: true });
	assert.match(expanded, /Read-only recon of code the parent has not seen\./);
	assert.match(expanded, /scout\s+read grep find ls bash/);
	assert.match(expanded, /~\/roles\/scout\.md/);
});

test("child rows tolerate records missing later fields", () => {
	const runs = {
		content: [{ type: "text", text: "stored text" }],
		details: { kind: "runs", rows: [{ id: "worker-1", status: "complete", task: "Migrate schema", role: "worker" }] },
	};
	assert.match(render(runs), /Migrate schema/, "rows without cost, files or attempt counts still render");

	const outcome = {
		content: [{ type: "text", text: "report text" }],
		details: { id: "worker-2", status: "complete", task: "Fix loader", role: "worker", model: "vendor/x", output: "report text", turns: 2, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: undefined, durationMs: 1000, revision: 1 },
	};
	assert.match(render(outcome), /Fix loader/);
	const expanded = render(outcome, { expanded: true });
	assert.match(expanded, /report text/);
	assert.match(expanded, /worker-2/);
});

const modelRow = (key: string, extra: any = {}) => ({ key, current: false, reasoning: true, contextWindow: 262144, cost: { input: 0.1, output: 0.3 }, ...extra });
const models = (rows: any[], extra: any = {}) => ({
	content: [{ type: "text", text: "DEFAULTS (approved by user)\nOPENROUTER: 454 live\n\nCATALOG: 998 offerings\n\nOFFERINGS model text" }],
	details: {
		kind: "models", filter: "step", total: 998, matched: rows.length, unratedHidden: 0, rows,
		// The catalog from the terminal that crashed at 40 columns.
		providers: Object.entries({ openrouter: 387, "local-llm": 139, huggingface: 76, opencode: 73, vertex: 52, "local-dgx": 31, "opencode-go": 30, clinepass: 25, omlx: 24, "github-copilot": 22, "qwen-token-plan": 20, anthropic: 15, "anthropic-2": 15, "google-vertex": 14, "corral-local": 14, "qwen-token-plan-individual": 9, "openai-codex": 8, zai: 7 }),
		defaults: { approved: [{ role: "scout", spec: "vendor/luna", ageDays: 1, reason: "flat-rate recon" }], drift: ["scout: price changed $1/2 → $2/4/M"] },
		ratings: "none", openrouter: { summary: "454 live, 188 with AA, fetched 0s ago (06:53Z)", error: false },
		liveOnly: { count: 1, rows: [{ id: "stepfun/step-5-preview", price: "$0.3/1.2/M" }] },
		...extra,
	},
});
const modelLines = (result: any, expanded = false, width = 110) => resultView("delegate_ctl", "models", '"step"', result, { expanded }, theme, width);

// Field report: the collapsed report was eight lines of preamble, and not one offering.
test("a models report previews offerings as an aligned table, not the model's text", () => {
	const rows = [
		modelRow("local-llm/stepfun-ai/Step-3.7-Flash-IQ3_XS", { reasoning: false, cost: { input: 0, output: 0 } }),
		modelRow("openrouter/stepfun/step-3.7-flash", { current: true, live: { listed: true, tiered: false, notes: ["live now $0.16/0.92/M (registry differs)"], livePrice: "$0.16/0.92/M", aa: { coding: 39.6 }, endpoints: ["SiliconFlow [siliconflow/fp8]  $0.1/0.3/M  fp8"] } }),
		...Array.from({ length: 6 }, (_, i) => modelRow(`vendor/step-${i}`)),
	];
	const lines = modelLines(models(rows));
	const flat = lines.join("\n");
	assert.match(lines[0], /delegate_ctl models "step"\s+8 of 998 offerings/);
	assert.match(flat, /defaults scout → vendor\/luna · 1 change since approval/);
	assert.doesNotMatch(flat, /DEFAULTS|OPENROUTER|CATALOG/, "the model's text is not the human's view");
	assert.match(flat, /local-llm\/stepfun-ai\/Step-3\.7-Flash-IQ3_XS\s+262k\s+\$0\/0\s+no reasoning/);
	assert.match(flat, /openrouter\/stepfun\/step-3\.7-flash\s+262k\s+\$0\.1\/0\.3\s+39\.6\s+current · live \$0\.16\/0\.92\/M/, "exceptions are named on the row");
	assert.match(flat, /vendor\/step-3/);
	assert.doesNotMatch(flat, /vendor\/step-4/, "six rows in the preview");
	assert.match(flat, /… 2 more · 1 on OpenRouter but not in your registry,/);
	assert.doesNotMatch(flat, /SiliconFlow/, "endpoints wait for the expand");
	const table = lines.filter((l) => /\d+k /.test(l));
	assert.equal(new Set(table.map((l) => l.indexOf("262k"))).size, 1, "columns line up");

	const expanded = modelLines(models(rows), true);
	const all = expanded.join("\n");
	assert.match(all, /vendor\/step-5/);
	assert.match(all, /↳ SiliconFlow \[siliconflow\/fp8\]/);
	assert.match(all, /live now \$0\.16\/0\.92\/M \(registry differs\)/);
	assert.match(all, /drift\s+scout: price changed/);
	assert.match(all, /flat-rate recon/);
	assert.match(all, /stepfun\/step-5-preview\s+\$0\.3\/1\.2\/M/);
	for (const line of expanded.filter((l) => /anthropic|qwen/.test(l))) {
		assert.doesNotMatch(line, /(anthropic|qwen-token-plan-individual)(\s·)?$/, `a provider keeps its count on its line: ${line}`);
	}
	// Pi exits on a line wider than the terminal; the providers list once overflowed at 40.
	for (const width of [110, 54, 40]) {
		for (const view of [modelLines(models(rows), false, width), modelLines(models(rows), true, width)]) {
			for (const line of view) assert.ok(visibleWidth(line) <= width, `overflows ${width} columns: ${JSON.stringify(line)}`);
		}
		// The clamp keeps Pi alive; the list must still fit on its own, breaking only between entries.
		const view = modelLines(models(rows), true, width);
		const providers = view.slice(view.findIndex((l) => /^\s+providers/.test(l)));
		for (const line of providers.slice(0, -1)) assert.match(line, / ·$/, `providers break between entries at ${width}: ${JSON.stringify(line)}`);
	}
});

const dealRow = (id: string, extra: any = {}) => ({ id: `openrouter/vendor/${id}`, price: "$0.1554/0.4884/M", input: 0.1554, output: 0.4884, basket: 0.2775,
	provider: "Baidu [baidu/fp8]", discount: 0.889, quality: 44.8, coding: 40.2, context: 1048576, configured: false,
	reason: "88.9% endpoint discount at Baidu [baidu/fp8] (already in price)", ...extra });
const dealDetails = (discounts: any[] = [dealRow("model")]) => ({ kind: "deals" as const, evaluatedAt: "2026-10-01T18:00:00Z", eligible: 100,
	endpointsChecked: 99, endpointFailures: 1, frontierFloor: 45, lightFloor: 25, discounts, offPeak: [], frontier: [dealRow("model")], light: [] });

test("deals render percentage and both AA columns in aligned rows at every width", () => {
	const result = { content: [{ type: "text", text: "fallback deal text" }], details: dealDetails() };
	for (const width of [110, 54, 40]) {
		for (const expanded of [false, true]) {
			const lines = resultView("OpenRouter", "deals", "", result, { expanded }, theme, width);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `deals overflow ${width}: ${JSON.stringify(line)}`);
			const flat = lines.join(" ");
			assert.match(flat, /provider discounts.*timed rates.*frontier value.*light value/);
			assert.match(flat, /88\.9%/);
			assert.match(flat, /44\.8/);
			assert.match(flat, /40\.2/);
			assert.match(flat, /promotions incomplete/);
		}
	}
});

test("timed sheet opens the populated group and keeps both Pacific windows visible", () => {
	const off = { start: "2026-10-01T16:00:00Z", end: "2026-10-02T00:00:00Z", input: 2, output: 4, period: "off-peak" };
	const peak = { start: "2026-10-01T00:00:00Z", end: "2026-10-01T16:00:00Z", input: 4, output: 8, period: "peak" };
	const offPeak = dealRow("scheduled", { saving: 0.5, period: "peak", currentPrice: "$4/8/M", currentInput: 4, currentOutput: 8, input: 2, output: 4,
		timing: { off, peak, windows: [peak, off] }, reason: "peak at scan; cheaper window Thu, Oct 1, 09:00 PDT–Thu, Oct 1, 17:00 PDT" });
	const data = { ...dealDetails([]), evaluatedAt: "2026-10-01T15:00:00Z", offPeak: [offPeak] };
	const tui: any = { terminal: { rows: 22 }, requestRender: () => {} };
	const sheet = new DealSheet(data, "", theme, tui, () => {}, async () => data);
	for (const width of [110, 54, 40]) {
		const lines = sheet.render(width);
		assert.ok(lines.length <= tui.terminal.rows);
		for (const line of lines) assert.ok(visibleWidth(line) <= width);
		const view = lines.join(" ");
		assert.match(view, /Timed rates.*Peak(?: at scan)?.*Off Thu 1 09–17 PDT.*Peak Wed 30 17–Thu 1 09 PDT/s);
		assert.doesNotMatch(view, /openrouter\/vendor\/scheduled|\$2\.0000/);
	}
	sheet.handleInput("\r");
	assert.match(sheet.render(110).join(" "), /At scan: Peak · In 4\.00 · Out 8\.00 USD\/M.*Next off-peak: Thu 1 09–17 PDT.*Exact offering: openrouter\/vendor\/scheduled/s);
	sheet.handleInput("\x1b");
	const report = { content: [{ type: "text", text: "fallback deal text" }], details: data };
	assert.match(resultView("OpenRouter", "deals", "", report, { expanded: true }, theme, 110).join(" "), /Peak.*Off Thu 1 09–17 PDT.*Peak Wed 30 17–Thu 1 09 PDT/s);
});

test("medium-width provider offers keep their provider identity", () => {
	const data = dealDetails([dealRow("same", { provider: "Baidu [baidu/fp8]" }), dealRow("same", { provider: "SiliconFlow [siliconflow/fp8]" })]);
	const sheet = new DealSheet(data, "", theme, { terminal: { rows: 24 }, requestRender: () => {} } as any, () => {}, async () => data);
	const view = sheet.render(80).join(" ");
	assert.match(view, /Baidu.*SiliconFlow/s);
	for (const line of sheet.render(80)) assert.ok(visibleWidth(line) <= 80);
});

test("refresh from details keeps the same provider selected and shows its new rate", async () => {
	const original = dealDetails([dealRow("same", { provider: "Baidu" }), dealRow("same", { provider: "SiliconFlow", input: 0.7, output: 2.2, discount: 0.5 })]);
	const updated = dealDetails([dealRow("same", { provider: "Baidu" }), dealRow("same", { provider: "SiliconFlow", input: 0.4, output: 1.1, discount: 0.6 })]);
	let refreshes = 0;
	const sheet = new DealSheet(original, "", theme, { terminal: { rows: 24 }, requestRender: () => {} } as any, () => {}, async () => { refreshes++; return updated; });
	sheet.render(110);
	sheet.handleInput("\x1b[B"); sheet.handleInput("\r");
	assert.match(sheet.render(110).join(" "), /SiliconFlow.*In 0\.70 · Out 2\.20 USD\/M/s);
	sheet.handleInput("r");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(refreshes, 1);
	assert.match(sheet.render(110).join(" "), /SiliconFlow.*Updated Thu, Oct 1, 11:00 PDT.*In 0\.40 · Out 1\.10 USD\/M/s);
});

test("a disappeared offer exits details instead of showing another provider", async () => {
	const initial = dealDetails([dealRow("same", { provider: "Baidu" }), dealRow("same", { provider: "SiliconFlow", discount: 0.5 })]);
	const updated = dealDetails([dealRow("same", { provider: "Baidu" })]);
	const sheet = new DealSheet(initial, "", theme, { terminal: { rows: 24 }, requestRender: () => {} } as any, () => {}, async () => updated);
	sheet.render(110); sheet.handleInput("\x1b[B"); sheet.handleInput("\r"); sheet.handleInput("r");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.match(sheet.render(110).join(" "), /Deals › Provider discounts.*this offer is no longer listed/s);
	assert.doesNotMatch(sheet.render(110).join(" "), /Deal details/);
});

test("display prices are rounded, truthful below a cent, and windows survive Pacific DST", () => {
	assert.equal(displayDealRate(0.1554), "0.16");
	assert.equal(displayDealRate(0.001), "<0.01");
	assert.equal(displayDealRate(0), "0");
	assert.equal(displayDealProvider("DeepSeek [deepseek]"), "DeepSeek");
	assert.equal(displayDealProvider("Baidu [baidu/fp8]"), "Baidu · fp8");
	assert.equal(displayDealWindow("2026-03-08T09:00:00Z", "2026-03-08T11:00:00Z"), "Sun 8 01–04 PST→PDT");
});

test("interactive deal sheet pages all offers, sorts, filters, shows details and retains refreshed data", async () => {
	const discounts = [dealRow("low", { discount: 0.1, coding: undefined, reason: "10% endpoint discount at Baidu [baidu/fp8] (already in price)" }), dealRow("high"), ...Array.from({ length: 24 }, (_, n) => dealRow(`extra-${n}`, { discount: 0.2 }))];
	const data = dealDetails(discounts);
	const updated = dealDetails([dealRow("refreshed", { discount: 0.05675 })]);
	let saved: any, renders = 0, refreshes = 0;
	const tui: any = { terminal: { rows: 22 }, requestRender: () => { renders++; } };
	const sheet = new DealSheet(data, "", theme, tui, (v) => { saved = v; }, async () => { refreshes++; return updated; });
	const screen = (width = 110) => sheet.render(width).join("\n");
	assert.match(screen(), /Provider discounts 26.*vendor\/high.*0\.16.*0\.49.*88\.9%.*44\.8.*40\.2/s);
	assert.match(screen(), /AA I.*AA C/);
	assert.doesNotMatch(screen(), /openrouter\/vendor\/high|\$0\.1554/, "no repeated provider prefix, dollar sign or four decimals in the sheet");
	assert.doesNotMatch(screen(), /extra-23/, "later rows wait for scrolling");
	sheet.handleInput("\x1b[F");
	assert.match(screen(), /extra-23/);
	sheet.handleInput("c");
	assert.match(screen(), /AA Code ↓/);
	sheet.handleInput("/"); sheet.handleInput("low"); sheet.handleInput("\r");
	assert.match(screen(), /Provider discounts · 1 offer.*Filter low.*vendor\/low/s);
	assert.match(screen(), /AA I.*AA C.*—/s);
	sheet.handleInput("\r");
	assert.match(screen(), /Deal details.*Provider discount: 10% · already in price/s);
	tui.terminal.rows = 20;
	const narrowDetail = sheet.render(40);
	assert.ok(narrowDetail.length <= tui.terminal.rows);
	assert.match(narrowDetail.join(" "), /Esc\/Enter back/);
	assert.match(narrowDetail.join(" "), /In 0\.16 · Out 0\.49 USD\/M/);
	sheet.handleInput("\x1b[6~");
	assert.match(sheet.render(40).join(" "), /routing to that provider/);
	sheet.handleInput("\x1b");
	sheet.handleInput("r");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(refreshes, 1);
	sheet.handleInput("/"); sheet.handleInput("\x15"); sheet.handleInput("\r");
	assert.match(screen(), /refreshed/);
	assert.match(screen(), /5\.68%/);
	for (const line of sheet.render(40)) assert.ok(visibleWidth(line) <= 40, `sheet overflows 40: ${JSON.stringify(line)}`);
	sheet.handleInput("\x1b");
	assert.equal(saved, updated);
	assert.ok(renders > 0);
});

test("a models record without usable details renders its text", () => {
	const text = { content: [{ type: "text", text: "OFFERINGS legacy text" }] };
	for (const details of [undefined, { kind: "models" }, { kind: "models", rows: [{}] }, models([modelRow("a/b", { live: { listed: true, notes: "oops" } })]).details]) {
		assert.match(modelLines({ ...text, details }).join(" "), /OFFERINGS legacy text/, `falls back for ${JSON.stringify(details)?.slice(0, 60)}`);
	}
	assert.match(modelLines(models([])).join(" "), /no registry offering matches "step"/);
});
