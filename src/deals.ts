// Read-only OpenRouter deal discovery. Prices are USD per token in the API;
// the comparison basket is 1M prompt + 250k completion tokens, not a bill forecast.
export interface TimedWindow { start: string; end: string; input: number; output: number; period: "peak" | "off-peak" }
export interface DealTiming { off: TimedWindow; peak: TimedWindow; windows: TimedWindow[] }
export interface DealRow {
	id: string;
	price: string;
	input?: number;
	output?: number;
	basket?: number;
	provider?: string;
	discount?: number;
	saving?: number;
	/** Active pricing window at evaluatedAt, not a claim about the current clock after the scan. */
	period?: "peak" | "off-peak" | "unlisted";
	currentPrice?: string;
	currentInput?: number;
	currentOutput?: number;
	timing?: DealTiming;
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
const pacific = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric",
	hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" });
export const formatPacific = (date: Date): string => Number.isNaN(date.valueOf()) ? "unknown time" : pacific.format(date);
const validClock = (n: number) => Number.isInteger(n) && n >= 0 && n < 2400 && n % 100 < 60;

/** UTC weekday conditions belong to the window's start day, including when it ends on the next day. */
function occurrences(o: any, now: Date): { start: number; end: number }[] {
	const start = Number(o.utc_start ?? 0), end = Number(o.utc_end ?? 0);
	if (!validClock(start) || !validClock(end) || (o.utc_days && (!Array.isArray(o.utc_days) || !o.utc_days.every((d: any) => DAYS.includes(d))))) return [];
	const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	const result: { start: number; end: number }[] = [];
	for (let offset = -1; offset <= 7; offset++) {
		const date = day + offset * 86_400_000;
		if (o.utc_days && !o.utc_days.includes(DAYS[new Date(date).getUTCDay()])) continue;
		const begins = date + (Math.floor(start / 100) * 60 + start % 100) * 60_000;
		const ends = date + (Math.floor(end / 100) * 60 + end % 100) * 60_000 + (end <= start ? 86_400_000 : 0);
		result.push({ start: begins, end: ends });
	}
	return result;
}

const percentFormatter = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 2 });
export const formatPercent = (fraction: number): string => fraction > 0 && fraction < 0.00005 ? "<0.01%" : percentFormatter.format(fraction);

function schedule(pricing: any, now: Date): { saving: number; period: NonNullable<DealRow["period"]>; currentPrice?: string;
	currentInput?: number; currentOutput?: number; timing: DealTiming;
	description: string; price: NonNullable<ReturnType<typeof money>> } | undefined {
	const windows: any[] = (Array.isArray(pricing?.overrides) ? pricing.overrides : []).filter((o: any) => {
		if (!o || typeof o !== "object" || o.min_prompt_tokens !== undefined) return false;
		if (Object.keys(o).some((key) => !PRICE_KEYS.has(key) && !CONDITIONS.has(key))) return false;
		return o.utc_start !== undefined || o.utc_end !== undefined || Array.isArray(o.utc_days);
	});
	const priced = windows.filter((o: any) => Number(o.request ?? pricing.request ?? 0) === 0)
		.map((o: any): { price: ReturnType<typeof money>; times: ReturnType<typeof occurrences> } => ({ price: money({ ...pricing, ...o }), times: occurrences(o, now) }))
		.filter((x) => x.price && x.times.length);
	if (priced.length < 2) return undefined;
	const high = priced.reduce((a, b) => b.price!.basket > a.price!.basket ? b : a);
	const cheaper = priced.filter((x) => x.price!.basket < high.price!.basket);
	if (!cheaper.length) return undefined;
	const at = now.getTime();
	const active = priced.filter((x) => x.times.some((t) => t.start <= at && at < t.end))
		.sort((a, b) => a.price!.basket - b.price!.basket);
	const next = (x: typeof priced[number]) => x.times.find((t) => t.start <= at && at < t.end) ?? x.times.find((t) => t.start > at);
	const discounted = active.find((x) => x.price!.basket < high.price!.basket);
	// For equally cheap windows, show the next one rather than an arbitrary weekend rate.
	const low = discounted ?? cheaper.reduce((a, b) => b.price!.basket < a.price!.basket ||
		(b.price!.basket === a.price!.basket && (next(b)?.start ?? Infinity) < (next(a)?.start ?? Infinity)) ? b : a);
	const slot = next(low);
	const highs = priced.filter((x) => x.price!.basket === high.price!.basket);
	const peak = highs.reduce((a, b) => (next(b)?.start ?? Infinity) < (next(a)?.start ?? Infinity) ? b : a);
	const peakSlot = next(peak);
	if (!slot || !peakSlot) return undefined;
	const period = active.length ? active[0].price!.basket < high.price!.basket ? "off-peak" : "peak" : "unlisted";
	const label = period === "unlisted" ? "no listed rate at scan" : `${period} at scan`;
	const window = (x: typeof priced[number], t: { start: number; end: number }): TimedWindow => ({
		start: new Date(t.start).toISOString(), end: new Date(t.end).toISOString(), input: x.price!.input, output: x.price!.output,
		period: x.price!.basket < high.price!.basket ? "off-peak" : "peak",
	});
	const timing: DealTiming = { off: window(low, slot), peak: window(peak, peakSlot),
		windows: priced.flatMap((x) => { const t = next(x); return t ? [window(x, t)] : []; }).sort((a, b) => a.start.localeCompare(b.start)) };
	return { saving: (high.price!.basket - low.price!.basket) / high.price!.basket, price: low.price!, period,
		currentPrice: active[0]?.price?.text, currentInput: active[0]?.price?.input, currentOutput: active[0]?.price?.output, timing,
		description: `${label}; cheaper window ${formatPacific(new Date(slot.start))}–${formatPacific(new Date(slot.end))}: ${low.price!.text} vs peak ${high.price!.text}` };
}

function qualityOf(model: any): { intel?: number; coding?: number } {
	const q = model.benchmarks?.artificial_analysis;
	return { intel: Number.isFinite(q?.intelligence_index) ? q.intelligence_index : undefined,
		coding: Number.isFinite(q?.coding_index) ? q.coding_index : undefined };
}

/** Endpoint discounts are already included in the endpoint's listed price. Never infer them from the model's top-provider price. */
export function selectDeals(models: any[], endpoints: Map<string, { endpoints: any[]; error?: string }>, configured: Set<string>, now: Date, universe = models): DealsDetails {
	const eligible = models.filter((model) => dealEligible(model, now));
	const discounts: DealRow[] = [];
	const offPeak: DealRow[] = [];
	const scored: { row: DealRow; basket: number; intel: number }[] = [];
	let endpointFailures = 0, endpointsChecked = 0;
	for (const model of eligible) {
		const quality = qualityOf(model);
		const base = money(model.pricing);
		const common = { id: `openrouter/${model.id}`, quality: quality.intel, coding: quality.coding,
			context: model.context_length ?? 0, configured: configured.has(model.id) };
		if (base && base.basket > 0 && Number(model.pricing?.request ?? 0) === 0 && quality.intel !== undefined) {
			scored.push({ row: { ...common, price: base.text, input: base.input, output: base.output, basket: base.basket, reason: "listed model price" }, basket: base.basket, intel: quality.intel });
		}
		const timed = schedule(model.pricing, now);
		if (timed) offPeak.push({ ...common, price: timed.price.text, input: timed.price.input, output: timed.price.output, basket: timed.price.basket, saving: timed.saving, period: timed.period, currentPrice: timed.currentPrice, currentInput: timed.currentInput, currentOutput: timed.currentOutput, timing: timed.timing, reason: timed.description });
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
				discounts.push({ ...common, price: price.text, input: price.input, output: price.output, basket: price.basket, provider: label, discount, reason: `${formatPercent(discount)} endpoint discount at ${label} (already in price)${provider.quantization && provider.quantization !== "unknown" ? ` · ${provider.quantization}` : ""}` });
			}
			const providerTime = schedule(provider.pricing, now);
			if (providerTime) offPeak.push({ ...common, price: providerTime.price.text, input: providerTime.price.input, output: providerTime.price.output, basket: providerTime.price.basket, provider: label, saving: providerTime.saving, period: providerTime.period, currentPrice: providerTime.currentPrice, currentInput: providerTime.currentInput, currentOutput: providerTime.currentOutput, timing: providerTime.timing, reason: `${label}: ${providerTime.description}` });
		}
	}
	const bySaving = (field: "discount" | "saving") => (a: DealRow, b: DealRow) =>
		(b[field] ?? 0) - (a[field] ?? 0) || (b.quality ?? -1) - (a.quality ?? -1) || a.id.localeCompare(b.id) || (a.provider ?? "").localeCompare(b.provider ?? "");
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
	const frontier = scored.filter((x) => frontierFloor !== undefined && x.intel >= frontierFloor && x.row.context >= 128_000).sort(byPrice);
	const light = scored.filter((x) => lightFloor !== undefined && frontierFloor !== undefined && x.intel >= lightFloor && x.intel < frontierFloor && x.row.context >= 32_000).sort(byPrice);
	return { kind: "deals", evaluatedAt: now.toISOString(), eligible: eligible.length, endpointsChecked, endpointFailures,
		frontierFloor, lightFloor, discounts: discounts.sort(bySaving("discount")), offPeak: offPeak.sort(bySaving("saving")),
		frontier: frontier.map((x) => x.row), light: light.map((x) => x.row) };
}
