// Read-only OpenRouter deal discovery. Prices are USD per token in the API;
// the comparison basket is 1M prompt + 250k completion tokens, not a bill forecast.
export interface DealRow {
	id: string;
	price: string;
	quality?: number;
	coding?: number;
	context: number;
	configured: boolean;
	reason: string;
}

export interface DealsDetails {
	kind: "deals";
	evaluatedAt: string;
	eligible: number;
	endpointsChecked: number;
	endpointFailures: number;
	frontierFloor?: number;
	lightFloor?: number;
	discounts: DealRow[];
	offPeak: DealRow[];
	frontier: DealRow[];
	light: DealRow[];
}

export function dealEligible(model: any, now: Date = new Date()): boolean {
	return typeof model?.id === "string" && !model.id.endsWith(":batch")
		&& model.supported_parameters?.includes("tools")
		&& model.architecture?.output_modalities?.includes("text")
		&& (!model.expiration_date || Date.parse(model.expiration_date) > now.getTime());
}

function money(pricing: any): { input: number; output: number; basket: number; text: string } | undefined {
	if (pricing?.prompt == null || pricing.prompt === "" || pricing?.completion == null || pricing.completion === "") return undefined;
	const input = Number(pricing.prompt) * 1e6;
	const output = Number(pricing.completion) * 1e6;
	if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return undefined;
	const request = Number(pricing?.request ?? 0);
	if (!Number.isFinite(request) || request < 0) return undefined;
	const fmt = (n: number) => Number(n.toFixed(4));
	return { input, output, basket: input + output / 4, text: `$${fmt(input)}/${fmt(output)}/M${request ? ` +$${request}/request` : ""}` };
}

const PRICE_KEYS = new Set(["prompt", "completion", "request", "image", "image_output", "web_search", "internal_reasoning", "input_cache_read", "input_cache_write", "input_cache_write_1h", "audio", "audio_output", "input_audio_cache"]);
const CONDITIONS = new Set(["utc_start", "utc_end", "utc_days", "min_prompt_tokens"]);
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const clock = (n: number) => `${String(Math.floor(n / 100)).padStart(2, "0")}:${String(n % 100).padStart(2, "0")}`;

function schedule(pricing: any, now: Date): { saving: number; description: string } | undefined {
	const windows = (Array.isArray(pricing?.overrides) ? pricing.overrides : []).filter((o: any) => {
		if (!o || typeof o !== "object" || o.min_prompt_tokens !== undefined) return false;
		if (Object.keys(o).some((key) => !PRICE_KEYS.has(key) && !CONDITIONS.has(key))) return false;
		return o.utc_start !== undefined || o.utc_end !== undefined || Array.isArray(o.utc_days);
	});
	const priced = windows.map((o: any) => ({ override: o, price: money({ ...pricing, ...o }) }))
		.filter((x: any) => x.price && Number(x.override.request ?? pricing.request ?? 0) === 0);
	if (priced.length < 2) return undefined;
	const high = priced.reduce((a: any, b: any) => b.price.basket > a.price.basket ? b : a);
	const current = now.getUTCHours() * 100 + now.getUTCMinutes();
	const active = (o: any) => {
		if (o.utc_days && !o.utc_days.includes(DAYS[now.getUTCDay()])) return false;
		if (o.utc_start === undefined && o.utc_end === undefined) return true;
		const start = Number(o.utc_start ?? 0), end = Number(o.utc_end ?? 0);
		return end > start ? current >= start && current < end : current >= start || current < end;
	};
	const cheaper = priced.filter((x: any) => x.price.basket < high.price.basket);
	if (!cheaper.length) return undefined;
	// Equal-price weekday and weekend windows are distinct: name the one active now,
	// rather than reporting "later this weekend" while the lower rate already applies.
	const availableNow = cheaper.filter((x: any) => active(x.override));
	const low = (availableNow.length ? availableNow : cheaper).reduce((a: any, b: any) => b.price.basket < a.price.basket ? b : a);
	const o = low.override;
	const days = o.utc_days?.map((d: string) => d.slice(0, 3)).join(",") ?? "daily";
	const start = Number(o.utc_start ?? 0), end = Number(o.utc_end ?? 0);
	if (![start, end].every(Number.isFinite)) return undefined;
	const time = o.utc_start !== undefined || o.utc_end !== undefined ? ` ${clock(start)}–${end === 0 ? "24:00" : clock(end)}Z` : "";
	return { saving: (high.price.basket - low.price.basket) / high.price.basket,
		description: `${availableNow.length ? "off-peak now" : "off-peak later"} ${days}${time}: ${low.price.text} vs peak ${high.price.text}` };
}

function qualityOf(model: any): { intel?: number; coding?: number } {
	const q = model.benchmarks?.artificial_analysis;
	return { intel: Number.isFinite(q?.intelligence_index) ? q.intelligence_index : undefined,
		coding: Number.isFinite(q?.coding_index) ? q.coding_index : undefined };
}

/** Endpoint discounts are already included in the endpoint's listed price. Never infer them from the model's top-provider price. */
export function selectDeals(models: any[], endpoints: Map<string, { endpoints: any[]; error?: string }>, configured: Set<string>, now: Date, universe = models): DealsDetails {
	const eligible = models.filter((model) => dealEligible(model, now));
	const discounts: { row: DealRow; saving: number }[] = [];
	const offPeak: { row: DealRow; saving: number }[] = [];
	const scored: { row: DealRow; basket: number; intel: number }[] = [];
	let endpointFailures = 0, endpointsChecked = 0;
	for (const model of eligible) {
		const quality = qualityOf(model);
		const base = money(model.pricing);
		const common = { id: `openrouter/${model.id}`, quality: quality.intel, coding: quality.coding,
			context: model.context_length ?? 0, configured: configured.has(model.id) };
		if (base && base.basket > 0 && Number(model.pricing?.request ?? 0) === 0 && quality.intel !== undefined) {
			scored.push({ row: { ...common, price: base.text, reason: "listed model price" }, basket: base.basket, intel: quality.intel });
		}
		const timed = schedule(model.pricing, now);
		if (base && timed) offPeak.push({ row: { ...common, price: base.text, reason: timed.description }, saving: timed.saving });
		const ep = endpoints.get(model.id);
		if (!ep) continue;
		if (ep.error) endpointFailures++;
		else endpointsChecked++;
		for (const provider of ep.error ? [] : ep.endpoints) {
			if (provider.status !== 0 || (provider.uptime_last_30m != null && provider.uptime_last_30m < 95)) continue;
			const price = money(provider.pricing);
			if (!price) continue;
			const label = `${provider.provider_name ?? "provider"}${provider.tag ? ` [${provider.tag}]` : ""}`;
			const discount = Number(provider.pricing?.discount);
			if (Number.isFinite(discount) && discount > 0 && discount <= 1) {
				discounts.push({ row: { ...common, price: price.text, reason: `${Math.round(discount * 100)}% endpoint discount at ${label} (already in price)${provider.quantization && provider.quantization !== "unknown" ? ` · ${provider.quantization}` : ""}` }, saving: discount });
			}
			const providerTime = schedule(provider.pricing, now);
			if (providerTime) offPeak.push({ row: { ...common, price: price.text, reason: `${label}: ${providerTime.description}` }, saving: providerTime.saving });
		}
	}
	const bestPerModel = (offers: { row: DealRow; saving: number }[], cap: number) => {
		offers.sort((a, b) => b.saving - a.saving || (b.row.quality ?? -1) - (a.row.quality ?? -1) || a.row.id.localeCompare(b.row.id));
		const seen = new Set<string>(), rows: DealRow[] = [];
		for (const offer of offers) {
			if (seen.has(offer.row.id)) continue;
			seen.add(offer.row.id);
			rows.push(offer.row);
			if (rows.length === cap) break;
		}
		return rows;
	};
	// A tier is relative to today's scored tool-capable catalog, not a claim of frontier parity.
	const scores = universe === models ? scored.map((x) => x.intel) : [] as number[];
	if (universe !== models) for (const m of universe) {
		if (!dealEligible(m, now)) continue;
		const price = money(m.pricing);
		const quality = qualityOf(m).intel;
		if (price && price.basket > 0 && Number(m.pricing?.request ?? 0) === 0 && quality !== undefined) scores.push(quality);
	}
	scores.sort((a, b) => b - a);
	const frontierFloor = scores.length ? scores[Math.floor((scores.length - 1) * 0.15)] : undefined;
	const lightFloor = scores.length ? scores[Math.floor((scores.length - 1) * 0.5)] : undefined;
	const byPrice = (a: typeof scored[number], b: typeof scored[number]) => a.basket - b.basket || b.intel - a.intel || a.row.id.localeCompare(b.row.id);
	const frontier = scored.filter((x) => frontierFloor !== undefined && x.intel >= frontierFloor && x.row.context >= 128_000).sort(byPrice).slice(0, 2);
	const light = scored.filter((x) => lightFloor !== undefined && frontierFloor !== undefined && x.intel >= lightFloor && x.intel < frontierFloor && x.row.context >= 32_000).sort(byPrice).slice(0, 2);
	return { kind: "deals", evaluatedAt: now.toISOString(), eligible: eligible.length, endpointsChecked, endpointFailures,
		frontierFloor, lightFloor, discounts: bestPerModel(discounts, 4), offPeak: bestPerModel(offPeak, 3),
		frontier: frontier.map((x) => x.row), light: light.map((x) => x.row) };
}
