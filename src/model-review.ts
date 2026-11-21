import { matchesSpec, modelKey, parseModelSpec, splitModelRef } from "./model-ref.ts";
import type { ApprovedDefault } from "./settings-file.ts";
import { ageDays } from "./util/format.ts";

type Rates = NonNullable<ApprovedDefault["cost"]>;
interface Offering { provider: string; id: string; cost?: Rates; type?: string; }
export interface CatalogReview { byId: ReadonlyMap<string, any>; error?: string }
const NEW_MODELS_FOR_REVIEW = 5;
const usableForReview = (m: Offering) => m.type !== "classifier" && !m.id.endsWith(":batch");

/** Save the catalog the user reviewed for this role. IDs remain provider-qualified for exact upgrades. */
export const reviewCatalog = (available: readonly Offering[]) => [...new Set(available.filter(usableForReview).map(modelKey))].sort();

export function perM(v: unknown): number | undefined {
	if (typeof v !== "number" && (typeof v !== "string" || !v.trim())) return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? Math.round(n * 1e6 * 1e4) / 1e4 : undefined;
}

const validRate = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const validCost = (cost?: Rates): cost is Rates => validRate(cost?.input) && validRate(cost?.output);
export const ratesText = (cost: Rates | undefined) => cost ? `$${cost.input}/${cost.output}/M` : "price unknown";

function catalogRates(pricing: any): Rates | undefined {
	let input = perM(pricing?.prompt), output = perM(pricing?.completion);
	if (!validRate(input) || !validRate(output)) return undefined;
	// Top-level prices can change at a scheduled boundary. Compare the listed ceiling, not the
	// rate in effect at the moment of approval. Long-context tiers are not the base token price.
	for (const o of Array.isArray(pricing?.overrides) ? pricing.overrides : []) {
		if (!o || typeof o !== "object" || !("utc_start" in o || "utc_end" in o || "utc_days" in o)
			|| Object.keys(o).some((key) => key.startsWith("min_") || key.startsWith("max_"))) continue;
		const prompt = perM(o.prompt), completion = perM(o.completion);
		if (validRate(prompt)) input = Math.max(input, prompt);
		if (validRate(completion)) output = Math.max(output, completion);
	}
	return { input, output };
}

export function modelTerms(model: Offering, live: CatalogReview | undefined): Pick<ApprovedDefault, "cost" | "costSource"> {
	const pricing = model.provider === "openrouter" && live && !live.error ? live.byId.get(model.id)?.pricing : undefined;
	const cost = catalogRates(pricing);
	if (cost) return { cost, costSource: "openrouter" };
	if (validCost(model.cost)) return { cost: { input: model.cost.input, output: model.cost.output }, costSource: "registry" };
	return {};
}

interface Version { family: string; major: number; minor: number }

function namedVersion(id: string): Version | undefined {
	// Claude has used both claude-3-7-sonnet and claude-sonnet-4-6; dates are snapshots, not releases.
	const claude = /^(anthropic\/)?claude-(haiku|sonnet|opus)-(\d{1,2})(?:[.-](\d{1,2}))?(?:-\d{8})?(?::(free))?$/.exec(id);
	if (claude) return { family: `${claude[1] ?? ""}claude-${claude[2]}:${claude[5] ?? ""}`, major: Number(claude[3]), minor: Number(claude[4] ?? 0) };
	const old = /^(anthropic\/)?claude-(\d{1,2})(?:[.-](\d{1,2}))?-(haiku|sonnet|opus)(?:-\d{8})?(?::(free))?$/.exec(id);
	if (old) return { family: `${old[1] ?? ""}claude-${old[4]}:${old[5] ?? ""}`, major: Number(old[2]), minor: Number(old[3] ?? 0) };
	// Strictly one major/minor version, exact namespace and suffix (mini, codex, preview, free, etc.).
	const m = /^((?:[\w.-]+\/)?[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*)-(\d{1,2})(?:\.(\d{1,2}))?((?:-[a-z][a-z0-9]*)*(?::free)?)$/.exec(id);
	if (m) return { family: `${m[1]}:${m[4]}`, major: Number(m[2]), minor: Number(m[3] ?? 0) };
	return undefined;
}

const compareVersion = (a: Version, b: Version) => a.major - b.major || a.minor - b.minor;
function newestUpgrade(ref: ReturnType<typeof parseModelSpec>, available: readonly Offering[], known: ReadonlySet<string>, live: CatalogReview | undefined, now: number) {
	const version = namedVersion(ref.id);
	if (!ref.provider || !version) return undefined;
	let best: { offering: Offering; version: Version } | undefined;
	for (const offering of available) {
		if (offering.provider !== ref.provider || offering.id === ref.id || !usableForReview(offering) || known.has(modelKey(offering))) continue;
		const next = namedVersion(offering.id);
		if (!next || next.family !== version.family || compareVersion(next, version) <= 0) continue;
		if (offering.provider === "openrouter") {
			const row = live?.byId.get(offering.id);
			if (!live || live.error || !row || Date.parse(row.expiration_date) <= now || (Array.isArray(row.supported_parameters) && !row.supported_parameters.includes("tools"))) continue;
		}
		const order = best ? compareVersion(next, best.version) : 1;
		if (!best || order > 0 || (order === 0 && offering.id < best.offering.id)) best = { offering, version: next };
	}
	return best ? { offering: best.offering, cost: modelTerms(best.offering, live).cost } : undefined;
}

function newModelIds(available: readonly Offering[], known: ReadonlySet<string>): string[] {
	// A new route for the same registered model ID isn't a new model for the broad threshold.
	const ids = new Set([...known].map(key => splitModelRef(key)?.id));
	const added = new Set<string>();
	for (const offering of available) if (usableForReview(offering) && !ids.has(offering.id)) added.add(offering.id);
	return [...added].sort();
}

const material = (before: number, after: number) => after > before && (before === 0 || (after - before) / before >= 0.1 - 1e-10);

/** The same rules gate launch and explain what needs review. Missing live data is not drift. */
export function reviewDefault(approval: ApprovedDefault, available: readonly Offering[], live: CatalogReview | undefined, now: number) {
	const parsed = parseModelSpec(approval.spec);
	const offering = available.find(m => matchesSpec(m, parsed));
	const ref = offering ? { ...parsed, provider: offering.provider } : parsed;
	const key = ref.provider ? modelKey({ provider: ref.provider, id: ref.id }) : ref.id;
	const blockers: string[] = [], notices: string[] = [];
	const age = ageDays(approval.approvedAt, now);
	const known = new Set(approval.catalogAtApproval);
	const upgrade = newestUpgrade(ref, available, known, live, now);
	if (upgrade) blockers.push(`new upgrade candidate: ${modelKey(upgrade.offering)} for ${key}`);
	const added = approval.catalogAtApproval ? newModelIds(available, known) : [];
	if (added.length >= NEW_MODELS_FOR_REVIEW) {
		const shown = added.slice(0, 8).join(", ");
		blockers.push(`${added.length} new models since this role's last review: ${shown}${added.length > 8 ? ", … (full list in models details.defaults.newModelIds)" : ""}`);
	}
	if (!offering) notices.push(`${key} unavailable (not in the catalog or no credentials)`);
	if (ref.provider === "openrouter") {
		if (!live || live.error) notices.push(`OpenRouter live terms unverified${live?.error ? ` (${live.error})` : ""}`);
		else if (!catalogRates(live.byId.get(ref.id)?.pricing)) notices.push("OpenRouter live token prices unverified");
	}
	const terms = offering ? modelTerms(offering, live) : {};
	const cost = terms.cost, previous = approval.cost;
	if (cost && validCost(previous) && (approval.costSource !== "openrouter" || terms.costSource === "openrouter")) {
		const change = `${ratesText(previous)} → ${ratesText(cost)}`;
		if (material(previous.input, cost.input) || material(previous.output, cost.output)) blockers.push(`${key} token price increased: ${change}`);
		else if (cost.input !== previous.input || cost.output !== previous.output) notices.push(`${key} token price changed: ${change}`);
	} else if (cost && !validCost(previous)) notices.push("no approved token price to compare");
	if (age > 30) notices.push(`approval is ${age}d old; review when convenient`);
	return { spec: approval.spec, ageDays: age, reason: approval.reason, available: Boolean(offering), blockers, notices, cost, upgrade, added };
}
