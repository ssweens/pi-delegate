import assert from "node:assert/strict";
import { test } from "node:test";
import { rmSync } from "node:fs";
import { dealEligible, formatPercent, selectDeals } from "../src/deals.ts";
import { provider, sandbox, harness } from "./fixture.ts";

const now = new Date("2026-10-01T18:00:00Z");
const pricing = (input: number, output: number) => ({ prompt: String(input / 1e6), completion: String(output / 1e6) });
const model = (index: number) => ({
	id: `vendor/model-${index}`, architecture: { output_modalities: ["text"] }, supported_parameters: ["tools"],
	context_length: 262144, pricing: pricing(index === 1 ? 0.4 : index === 0 ? 4 : 1 + index / 10, index === 1 ? 1 : 6),
	benchmarks: { artificial_analysis: { intelligence_index: 70 - index, coding_index: 60 - index } },
});

test("deal rows retain every healthy endpoint and scored model, ordered by the relevant numeric value", () => {
	const catalog = Array.from({ length: 20 }, (_, i) => model(i));
	catalog[0].pricing = { ...pricing(4, 12), overrides: [
		{ utc_start: 0, utc_end: 1600, ...pricing(4, 12) },
		{ utc_start: 1600, utc_end: 0, ...pricing(2, 6) },
	] } as typeof catalog[0]["pricing"];
	const unrated = { ...model(20), id: "vendor/promo", benchmarks: undefined };
	const batch = { ...model(21), id: "vendor/batch:batch" };
	const expired = { ...model(22), id: "vendor/expired", expiration_date: "2025-01-01" };
	const noTools = { ...model(23), id: "vendor/no-tools", supported_parameters: [] };
	const endpoints = new Map<string, { endpoints: any[]; error?: string }>([
		["vendor/promo", { endpoints: [
			{ provider_name: "PromoHost", tag: "fp8", status: 0, uptime_last_30m: 99, pricing: { ...pricing(0.2, 0.4), discount: 0.8 } },
			{ provider_name: "OtherHost", status: 0, uptime_last_30m: 98, pricing: { ...pricing(0.3, 0.5), discount: 0.7 } },
			{ provider_name: "BrokenHost", status: -2, pricing: { ...pricing(0.01, 0.01), discount: 0.99 } },
		] }],
		["vendor/model-2", { endpoints: [], error: "HTTP 429" }],
	]);
	const result = selectDeals([...catalog, unrated, batch, expired, noTools], endpoints, new Set(["vendor/model-1"]), now);
	assert.equal(result.kind, "deals");
	assert.equal(result.eligible, 21);
	assert.equal(result.endpointFailures, 1);
	assert.equal(result.frontierFloor, 68);
	assert.equal(result.lightFloor, 61);
	assert.deepEqual(result.frontier.map((r) => r.id), ["openrouter/vendor/model-1", "openrouter/vendor/model-2", "openrouter/vendor/model-0"]);
	assert.equal(result.frontier[0].configured, true);
	assert.equal(result.light[0].configured, false);
	const timed = result.offPeak.find((r) => r.id === "openrouter/vendor/model-0")!;
	assert.equal(timed.period, "off-peak");
	assert.equal(timed.currentPrice, "$2/6/M");
	assert.equal(timed.currentInput, 2);
	assert.equal(timed.timing?.off.start, "2026-10-01T16:00:00.000Z");
	assert.equal(timed.timing?.off.end, "2026-10-02T00:00:00.000Z");
	assert.equal(timed.timing?.peak.start, "2026-10-02T00:00:00.000Z");
	assert.match(timed.reason, /off-peak at scan.*Thu, Oct 1, 09:00 PDT.*Thu, Oct 1, 17:00 PDT.*\$2\/6\/M vs peak \$4\/12\/M/);
	assert.match(result.discounts[0].reason, /80% endpoint discount at PromoHost \[fp8\] \(already in price\)/);
	assert.equal(result.discounts[0].quality, undefined);
	assert.deepEqual(result.discounts.map((r) => [r.provider, r.discount, r.input, r.output]), [
		["PromoHost [fp8]", 0.8, 0.2, 0.4], ["OtherHost", 0.7, 0.3, 0.5],
	]);
	assert.equal(formatPercent(0.889), "88.9%");
	assert.equal(formatPercent(0.05675), "5.68%");
	assert.ok(![...result.discounts, ...result.offPeak].some((r) => /BrokenHost|:batch/.test(r.reason + r.id)));
});

test("a model filter preserves full-catalog quality bands and missing prices cannot rank", () => {
	const universe = Array.from({ length: 20 }, (_, i) => model(i));
	const filtered = selectDeals([universe[10]], new Map(), new Set(), now, universe);
	assert.equal(filtered.frontierFloor, 68);
	assert.equal(filtered.lightFloor, 61);
	assert.deepEqual(filtered.frontier, []);
	assert.deepEqual(filtered.light, []);
	const missing = { ...model(0), pricing: { prompt: null, completion: "0.000001" } };
	const unknown = selectDeals([missing], new Map(), new Set(), now);
	assert.deepEqual(unknown.frontier, []);
	assert.deepEqual(unknown.light, []);
});

test("later UTC windows and unknown conditions do not become invented current deals", () => {
	const later = { ...model(0), pricing: { ...pricing(4, 8), overrides: [
		{ utc_start: 0, utc_end: 1600, ...pricing(4, 8) },
		{ utc_start: 1600, utc_end: 0, ...pricing(2, 4) },
	] } };
	const unknown = { ...model(1), pricing: { ...pricing(4, 8), overrides: [
		{ utc_start: 0, utc_end: 1600, ...pricing(4, 8) },
		{ utc_start: 1600, utc_end: 0, ...pricing(1, 2), country: "US" },
	] } };
	const result = selectDeals([later, unknown], new Map(), new Set(), new Date("2026-10-01T12:00:00Z"));
	assert.equal(result.offPeak[0].period, "peak");
	assert.equal(result.offPeak[0].currentPrice, "$4/8/M");
	assert.equal(result.offPeak[0].currentOutput, 8);
	assert.equal(result.offPeak[0].timing?.off.start, "2026-10-01T16:00:00.000Z");
	assert.equal(result.offPeak[0].timing?.peak.start, "2026-10-01T00:00:00.000Z");
	assert.match(result.offPeak[0].reason, /peak at scan.*Thu, Oct 1, 09:00 PDT.*Thu, Oct 1, 17:00 PDT/);
	assert.equal(result.offPeak.length, 1);
	assert.equal(dealEligible({ ...model(2), id: "vendor/no-tools", supported_parameters: [] }, now), false);
});

test("weekly off-peak report chooses today's cheaper window rather than a same-price weekend", () => {
	const weekly = { ...model(0), pricing: { ...pricing(2, 6), overrides: [
		{ utc_days: ["saturday", "sunday"], ...pricing(2, 6) },
		{ utc_days: ["monday", "tuesday", "wednesday", "thursday", "friday"], utc_start: 0, utc_end: 100, ...pricing(2, 6) },
		{ utc_days: ["monday", "tuesday", "wednesday", "thursday", "friday"], utc_start: 100, utc_end: 400, ...pricing(4, 12) },
		{ utc_days: ["monday", "tuesday", "wednesday", "thursday", "friday"], utc_start: 400, utc_end: 0, ...pricing(2, 6) },
	] } };
	const result = selectDeals([weekly], new Map(), new Set(), now);
	assert.equal(result.offPeak[0].period, "off-peak");
	assert.match(result.offPeak[0].reason, /off-peak at scan.*Wed, Sep 30, 21:00 PDT.*Thu, Oct 1, 17:00 PDT/);
	const peak = selectDeals([weekly], new Map(), new Set(), new Date("2026-10-01T02:00:00Z"));
	assert.equal(peak.offPeak[0].period, "peak");
	assert.equal(peak.offPeak[0].timing?.off.start, "2026-10-01T04:00:00.000Z", "next weekday discount, not the equally cheap weekend window");
});

test("overnight UTC day restrictions select the active prior-day window and Pacific day", () => {
	const overnight = { ...model(0), pricing: { ...pricing(4, 8), overrides: [
		{ utc_days: ["monday"], utc_start: 2300, utc_end: 200, ...pricing(2, 4) },
		{ utc_days: ["tuesday"], utc_start: 200, utc_end: 2300, ...pricing(4, 8) },
	] } };
	const result = selectDeals([overnight], new Map(), new Set(), new Date("2026-07-07T01:00:00Z"));
	assert.equal(result.offPeak[0].period, "off-peak");
	assert.match(result.offPeak[0].reason, /Mon, Jul 6, 16:00 PDT.*Mon, Jul 6, 19:00 PDT/);
});

test("Pacific winter time and DST transition are converted using dated instants", () => {
	const winter = { ...model(0), pricing: { ...pricing(4, 8), overrides: [
		{ utc_start: 0, utc_end: 1600, ...pricing(4, 8) },
		{ utc_start: 1600, utc_end: 0, ...pricing(2, 4) },
	] } };
	const jan = selectDeals([winter], new Map(), new Set(), new Date("2026-01-05T12:00:00Z"));
	assert.equal(jan.offPeak[0].period, "peak");
	assert.match(jan.offPeak[0].reason, /Mon, Jan 5, 08:00 PST.*Mon, Jan 5, 16:00 PST/);
	const dst = { ...model(0), pricing: { ...pricing(4, 8), overrides: [
		{ utc_days: ["sunday"], utc_start: 900, utc_end: 1100, ...pricing(2, 4) },
		{ utc_start: 1100, utc_end: 900, ...pricing(4, 8) },
	] } };
	const mar = selectDeals([dst], new Map(), new Set(), new Date("2026-03-08T08:00:00Z"));
	assert.equal(mar.offPeak[0].period, "peak");
	assert.match(mar.offPeak[0].reason, /Sun, Mar 8, 01:00 PST.*Sun, Mar 8, 04:00 PDT/);
});

test("missing active windows are not misreported as peak, and endpoint windows retain their own state", () => {
	const target = { ...model(0), pricing: { ...pricing(4, 8), overrides: [
		{ utc_days: ["monday"], utc_start: 900, utc_end: 1200, ...pricing(2, 4) },
		{ utc_days: ["tuesday"], utc_start: 900, utc_end: 1200, ...pricing(4, 8) },
	] } };
	const providerPricing = { ...pricing(4, 8), overrides: [
		{ utc_start: 0, utc_end: 1600, ...pricing(4, 8) },
		{ utc_start: 1600, utc_end: 0, ...pricing(2, 4) },
	] };
	const endpoints = new Map([[target.id, { endpoints: [{ provider_name: "TestHost", status: 0, pricing: providerPricing }] }]]);
	const result = selectDeals([target], endpoints, new Set(), new Date("2026-10-01T18:00:00Z"));
	const absent = result.offPeak.find((r) => !r.provider)!;
	assert.equal(absent.period, "unlisted");
	assert.equal(absent.currentPrice, undefined);
	assert.match(absent.reason, /no listed rate at scan; cheaper window Mon, Oct 5, 02:00 PDT/);
	const endpoint = result.offPeak.find((r) => r.provider === "TestHost")!;
	assert.equal(endpoint.period, "off-peak");
	assert.equal(endpoint.currentPrice, "$2/4/M");
	assert.equal(endpoint.timing?.windows.length, 2);
});

test("/deals and delegate_ctl deals share the scan; slash command leaves no LLM-context message", { timeout: 30000 }, async () => {
	const api = await provider();
	const box = sandbox(api.url);
	const h = await harness(box);
	const originalFetch = globalThis.fetch;
	const requests: string[] = [];
	globalThis.fetch = async (input: RequestInfo | URL) => {
		const url = String(input); requests.push(url);
		if (url === "https://openrouter.ai/api/v1/models") return Response.json({ data: [{ ...model(0), id: "vendor/test" }] });
		if (url.endsWith("/vendor/test/endpoints")) return Response.json({ data: { endpoints: Array.from({ length: 6 }, (_, i) => ({
			provider_name: `TestHost${i}`, tag: "fp8", status: 0, uptime_last_30m: 99,
			pricing: { ...pricing(0.5 + i / 10, 1), discount: 0.5 - i / 100 },
		})) } });
		throw new Error(`Unexpected request: ${url}`);
	};
	try {
		assert.equal(typeof h.commands.get("deals")?.handler, "function");
		await h.commands.get("deals").handler("vendor/test", h.ctx());
		const entries = h.runtime.session.sessionManager.getBranch();
		const saved = entries.findLast((entry: any) => entry.type === "custom" && entry.customType === "pi-delegate.deals") as any;
		assert(saved?.data, "direct command saves a rendered, non-context entry");
		assert.equal(saved.data.discounts[0].id, "openrouter/vendor/test");
		assert.equal(saved.data.discounts[0].configured, false);
		assert.equal(saved.data.discounts.length, 6, "all endpoint offers are retained, not a four-row shortlist");
		assert.ok(!JSON.stringify(h.runtime.session.sessionManager.buildSessionContext().messages).includes("vendor/test"));
		assert.equal(api.requests.length, 0, "no model call from the slash command");
		const fromTool = await h.ctl("deals", undefined, { message: "vendor/test" });
		assert.equal(fromTool.details.discounts[0].id, saved.data.discounts[0].id);
		assert.match(fromTool.content[0].text, /ENDPOINT DISCOUNTS \(6 offers\).*2 more; \/deals opens the sortable sheet.*OFF-PEAK RATES/s);
		assert.equal(requests.filter((url) => url.endsWith("/endpoints")).length, 1, "successful endpoint response cached for tool use");
	} finally {
		globalThis.fetch = originalFetch;
		await h.runtime.dispose();
		await api.close();
		rmSync(box.root, { recursive: true, force: true });
	}
});
