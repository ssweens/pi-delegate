import assert from "node:assert/strict";
import { test } from "node:test";
import { rmSync } from "node:fs";
import { dealEligible, selectDeals } from "../src/deals.ts";
import { provider, sandbox, harness } from "./fixture.ts";

const now = new Date("2026-10-01T18:00:00Z");
const pricing = (input: number, output: number) => ({ prompt: String(input / 1e6), completion: String(output / 1e6) });
const model = (index: number) => ({
	id: `vendor/model-${index}`, architecture: { output_modalities: ["text"] }, supported_parameters: ["tools"],
	context_length: 262144, pricing: pricing(index === 1 ? 0.4 : index === 0 ? 4 : 1 + index / 10, index === 1 ? 1 : 6),
	benchmarks: { artificial_analysis: { intelligence_index: 70 - index, coding_index: 60 - index } },
});

test("deal shortlist separates declared savings from model value and preserves availability", () => {
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
	assert.deepEqual(result.frontier.map((r) => r.id), ["openrouter/vendor/model-1", "openrouter/vendor/model-2"]);
	assert.equal(result.frontier[0].configured, true);
	assert.equal(result.light[0].configured, false);
	assert.match(result.offPeak.find((r) => r.id === "openrouter/vendor/model-0")!.reason, /off-peak now.*16:00–24:00Z.*\$2\/6\/M vs peak \$4\/12\/M/);
	assert.match(result.discounts.find((r) => r.id === "openrouter/vendor/promo")!.reason, /80% endpoint discount at PromoHost \[fp8\] \(already in price\)/);
	assert.equal(result.discounts.find((r) => r.id === "openrouter/vendor/promo")!.quality, undefined);
	assert.equal(result.discounts.length, 1, "one discount per model, strongest endpoint wins");
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
	assert.match(result.offPeak[0].reason, /off-peak later/);
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
	assert.match(result.offPeak[0].reason, /off-peak now mon,tue,wed,thu,fri 04:00–24:00Z/);
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
		if (url.endsWith("/vendor/test/endpoints")) return Response.json({ data: { endpoints: [
			{ provider_name: "TestHost", tag: "fp8", status: 0, uptime_last_30m: 99, pricing: { ...pricing(0.5, 1), discount: 0.5 } },
		] } });
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
		assert.ok(!JSON.stringify(h.runtime.session.sessionManager.buildSessionContext().messages).includes("vendor/test"));
		assert.equal(api.requests.length, 0, "no model call from the slash command");
		const fromTool = await h.ctl("deals", undefined, { message: "vendor/test" });
		assert.equal(fromTool.details.discounts[0].id, saved.data.discounts[0].id);
		assert.match(fromTool.content[0].text, /ENDPOINT DISCOUNTS.*OFF-PEAK RATES/s);
		assert.equal(requests.filter((url) => url.endsWith("/endpoints")).length, 1, "successful endpoint response cached for tool use");
	} finally {
		globalThis.fetch = originalFetch;
		await h.runtime.dispose();
		await api.close();
		rmSync(box.root, { recursive: true, force: true });
	}
});
