import "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { modelTerms, reviewCatalog, reviewDefault } from "../src/model-review.ts";
import { availableModels } from "../src/registry.ts";
import { harness, provider, sandbox } from "./fixture.ts";

const now = Date.parse("2026-11-21T00:00:00Z");
const catalog = (...rows: any[]) => ({ byId: new Map(rows.map((row) => [row.id, row])) });

test("a new same-provider/family/tier version blocks; keeping the current default acknowledges the reviewed candidates", () => {
	const current = { provider: "fixture", id: "agent-1.9-mini", cost: { input: 1, output: 2 } };
	const candidates = [current, ...["agent-1.10-mini", "agent-9.0", "agent-9.0-mini-preview", "agent-9.0-mini:free", "agent-1.8-mini"].map(id => ({ ...current, id })),
		{ ...current, provider: "other", id: "agent-9.0-mini" }];
	const approval = { spec: "fixture/agent-1.9-mini:off", approvedAt: now - 40 * 86400_000, cost: { input: 1, output: 2 } };
	const reviewed = reviewDefault(approval, candidates.toReversed(), undefined, now);
	assert.match(reviewed.blockers[0], /new upgrade candidate: fixture\/agent-1\.10-mini/);
	assert.match(reviewed.notices[0], /40d old/);
	assert.equal(reviewed.upgrade?.offering.id, "agent-1.10-mini");
	const keep = { ...approval, catalogAtApproval: reviewCatalog(candidates) };
	assert.deepEqual(reviewDefault(keep, candidates, undefined, now).blockers, []);
	assert.match(reviewDefault(keep, [...candidates, { ...current, id: "agent-2.0-mini" }], undefined, now).blockers[0], /agent-2\.0-mini/);
	assert.equal(reviewDefault(approval, candidates.filter(m => m.id !== "agent-1.10-mini"), undefined, now).upgrade, undefined);
});

test("five newly usable model IDs force review; duplicate routes, classifiers, and batch models do not inflate the count", () => {
	const current = { provider: "fixture", id: "approved", cost: { input: 1, output: 2 } };
	const approval = { spec: "fixture/approved", approvedAt: now, catalogAtApproval: ["fixture/approved", "another/known"] };
	const unrelated = Array.from({ length: 5 }, (_, i) => ({ ...current, id: `unrelated-${i}` }));
	const available = [current, { provider: "fixture", id: "known" }, { provider: "another", id: "unrelated-0" },
		{ provider: "fixture", id: "classifier", type: "classifier" }, { provider: "fixture", id: "scheduled:batch" }, ...unrelated.slice(0, 4)];
	assert.deepEqual(reviewDefault(approval, available, undefined, now).blockers, []);
	assert.match(reviewDefault(approval, [...available, unrelated[4]!], undefined, now).blockers[0], /5 new models since this role's last review/);
});

test("OpenRouter price verification ignores window transitions, rejects material increases and never treats failed data as current", () => {
	const model = { provider: "openrouter", id: "vendor/agent-1.2", cost: { input: 100, output: 200 } };
	const overrides = [{ utc_start: 100, utc_end: 200, prompt: "0.000001", completion: "0.000002" },
		{ min_prompt_tokens: 262144, prompt: "0.1", completion: "0.1" }];
	const rates = (prompt: string, completion: string, expiration_date?: string) => catalog({ id: model.id, pricing: { prompt, completion, overrides }, expiration_date });
	const approval = { spec: "openrouter/vendor/agent-1.2", approvedAt: now, ...modelTerms(model, rates("0.0000005", "0.000001")) };
	assert.deepEqual(approval.cost, { input: 1, output: 2 });
	assert.equal(approval.costSource, "openrouter");
	const verify = (live: ReturnType<typeof catalog> & { error?: string }) => reviewDefault(approval, [model], live, now);
	assert.deepEqual(verify(rates("0.000001", "0.000002")).blockers, []);
	assert.deepEqual(verify(rates("0.000001", "0.00000219")).blockers, []);
	assert.match(verify(rates("0.000001", "0.0000022")).blockers[0], /price increased/);
	assert.deepEqual(verify(rates("0.000001", "0.000002", "2026-11-20")).blockers, [], "retirement does not trigger model review");
	assert.deepEqual(verify(catalog()).blockers, [], "an absent live listing is not catalog growth or a price rise");
	const failed = verify({ ...rates("0.000002", "0.000003"), error: "offline" });
	assert.deepEqual(failed.blockers, []);
	assert.match(failed.notices[0], /unverified/);
});

test("real Pi tools block new candidates, price drift, and catalog growth; reapproval applies only to the chosen role", { timeout: 30_000 }, async (t) => {
	const api = await provider(), box = sandbox(api.url);
	const modelFile = join(box.agentDir, "models.json"), settings = join(box.agentDir, "pi-delegate.json");
	const config = JSON.parse(readFileSync(modelFile, "utf8"));
	const model = config.providers.fixture.models[0];
	const oldId = "fixture/agent-1.9-mini", nextId = "fixture/agent-1.10-mini";
	config.providers.openrouter = { ...config.providers.fixture, models: [oldId, nextId].map(id => ({ ...model, id, name: id })) };
	const growthIds = ["catalog-a", "catalog-b", "catalog-c", "catalog-d", "catalog-e"];
	config.providers.fixture.models.push(...growthIds.map(id => ({ ...model, id, name: id })));
	writeFileSync(modelFile, JSON.stringify(config));
	const details = { spec: `openrouter/${oldId}:off`, cost: { input: 0, output: 0 }, approvedAt: now };
	// Old approvals share a baseline until they are reapproved. It must survive another role's approval.
	const approved = { scout: details, reviewer: { ...details, spec: "fixture/fixture:off" } };
	const payload = { data: [oldId, nextId, "fixture/agent-2.0-mini"].map((id, i) => ({ id, pricing: { prompt: i ? "0.000002" : "0.000001", completion: "0.000003" },
		benchmarks: { artificial_analysis: { intelligence_index: 45 + i } } })) };
	const nativeFetch = globalThis.fetch;
	const catalogFetch: typeof globalThis.fetch = (input, init) => String(input) === "https://openrouter.ai/api/v1/models" ? Promise.resolve(Response.json(payload)) : nativeFetch(input, init);
	const fetch = t.mock.method(globalThis, "fetch", catalogFetch);
	const h = await harness(box);
	try {
		delete process.env.PI_OFFLINE; // The fixture still routes model work to loopback; the public catalog is intercepted.
		const added = new Set([`openrouter/${nextId}`, ...growthIds.map(id => `fixture/${id}`)]);
		const catalogAtApproval = reviewCatalog(availableModels(h.ctx())).filter(key => !added.has(key));
		writeFileSync(settings, JSON.stringify({ defaults: { approved, catalogAtApproval } }));
		const refused = await h.launch("Do not start on changed terms", { model: undefined });
		assert.match(refused.content[0].text, /MODEL_REVIEW_REQUIRED.*new upgrade candidate.*new models.*price increased.*Nothing started/);
		const broad = await h.launch("Review the wider catalog", { model: undefined, role: "reviewer" });
		assert.match(broad.content[0].text, /MODEL_REVIEW_REQUIRED.*6 new models.*catalog-e/);
		assert.doesNotMatch(broad.content[0].text, /new upgrade candidate|price increased/);
		assert.equal(h.state().runs.size, 0);
		assert.equal(fetch.mock.calls.filter(c => String(c.arguments[0]).endsWith("/api/v1/models")).length, 1, "launch checked the catalog without a prior models call");

		const report = await h.ctl("models");
		assert.match(report.content[0].text, /scout: .*price increased/);
		assert.match(report.content[0].text, /reviewer: 6 new models/);
		assert.deepEqual(report.details.defaults.newModelIds.reviewer, [...growthIds, nextId]);
		assert.match(report.details.defaults.upgrades[0], /scout: openrouter\/fixture\/agent-1\.10-mini.*candidate \$2\/3\/M.*AA.*46/);
		assert.doesNotMatch(report.details.defaults.upgrades.join(" "), /agent-2\.0|irrelevant/);

		api.script("Try the successor once", { text: "TRIED" });
		assert.equal((await h.waitLaunch("Try the successor once", { model: `openrouter/${nextId}:off` })).details.model, `openrouter/${nextId}`);
		assert.equal(JSON.parse(readFileSync(settings, "utf8")).defaults.approved.scout.spec, `openrouter/${oldId}:off`);

		const other = await h.ctl("approve", undefined, { role: "reviewer", model: "fixture/fixture", message: "Separate role" });
		assert.match(other.content[0].text, /saved as default/);
		const afterOther = (await h.ctl("models")).details.defaults;
		assert.deepEqual(afterOther.upgrades, report.details.defaults.upgrades, "another role's approval cannot erase the candidate");
		assert.ok(afterOther.drift.some((d: string) => d.startsWith("scout: 6 new models")), "another role's approval cannot erase catalog drift");
		assert.ok(afterOther.drift.every((d: string) => !d.startsWith("reviewer:")));
		const agreed = await h.ctl("approve", undefined, { role: "scout", model: `openrouter/${oldId}:off`, message: "Keep current after reviewing candidates and new rates" });
		assert.match(agreed.content[0].text, /saved as default/);
		const saved = JSON.parse(readFileSync(settings, "utf8")).defaults.approved.scout;
		assert.equal(saved.costSource, "openrouter");
		assert.deepEqual(saved.cost, { input: 1, output: 3 });
		assert.ok(saved.catalogAtApproval.includes(`openrouter/${nextId}`));
		assert.deepEqual((await h.ctl("models")).details.defaults.drift, []);
		api.script("Launch after reapproval", { text: "LAUNCHED" });
		const launched = await h.waitLaunch("Launch after reapproval", { model: undefined });
		assert.equal(launched.details.status, "complete", launched.content[0].text);
		assert.equal(launched.details.model, `openrouter/${oldId}`, "the visible upgrade did not replace the default");
	} finally {
		process.env.PI_OFFLINE = "1";
		await h.runtime.dispose();
		await api.close();
		rmSync(box.root, { recursive: true, force: true });
	}
});
