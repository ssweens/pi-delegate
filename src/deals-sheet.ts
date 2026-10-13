import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { DealRow, DealsDetails } from "./deals.js";
import { formatPacific, formatPercent } from "./deals.js";
import { FilterInput, filterBy } from "./ui/filter.ts";
import { hint, joinHints, keyLabel, pageKeys, upDown } from "./ui/hints.ts";
import { navKeys } from "./ui/keys.ts";
import { keepInView, moveIndex, Scroller, stepFor } from "./ui/scroll.ts";
import { fit, fitPad } from "./ui/text.ts";
import { dealRowHeight, dealTableLines, displayDealId, displayDealRate, displayDealWindow, frame, type DealMetric } from "./render.js";

const TABS = ["Provider discounts", "Timed rates", "Frontier value", "Light value"] as const;
const SHORT_TABS = ["Disc", "Time", "Front", "Light"] as const;
type SortKey = "deal" | "basket" | "intel" | "coding" | "model";
const value = (n: number | undefined) => n === undefined ? "—" : String(n);

export class DealSheet implements Component, Focusable {
	private data: DealsDetails;
	private tab = 0;
	private selected = 0;
	private offset = 0;
	private pageRows = 1;
	private sort: SortKey = "deal";
	private descending = true;
	private detail = false;
	private readonly detailScroll = new Scroller();
	private detailPageRows = 1;
	private detailTotal = 0;
	private loading = false;
	private closed = false;
	private notice = "";
	private readonly filter = new FilterInput({ prompt: "Filter: ", placeholder: "model or provider", onChange: () => { this.selected = this.offset = 0; this.sortedRows = undefined; this.tui.requestRender(); }, onToggle: () => this.tui.requestRender() });
	private sortedRows?: DealRow[];
	private isFocused = false;

	get focused() { return this.isFocused; }
	set focused(v: boolean) { this.isFocused = v; this.filter.focused = v; }

	constructor(data: DealsDetails, private scope: string, private theme: Theme, private tui: TUI,
		private done: (result: DealsDetails) => void, private refresh: () => Promise<DealsDetails>) {
		this.data = data;
		this.tab = [data.discounts, data.offPeak, data.frontier, data.light].findIndex((rows) => rows.length);
		if (this.tab < 0) this.tab = 0;
		this.sort = this.tab < 2 ? "deal" : "basket";
		this.descending = this.tab < 2;
	}

	private metric(): DealMetric { return this.tab === 0 ? "discount" : this.tab === 1 ? "saving" : "basket"; }
	private source(): DealRow[] {
		switch (this.tab) {
			case 0: return this.data.discounts;
			case 1: return this.data.offPeak;
			case 2: return this.data.frontier;
			default: return this.data.light;
		}
	}
	private rows(): DealRow[] {
		if (this.sortedRows) return this.sortedRows;
		const rows = filterBy(this.source(), this.filter.query, (r) => `${r.id} ${r.provider ?? ""} ${r.reason}`);
		const number = (r: DealRow): number | undefined => this.sort === "deal" ? this.metric() === "discount" ? r.discount : this.metric() === "saving" ? r.saving : r.basket
			: this.sort === "basket" ? r.basket : this.sort === "intel" ? r.quality : r.coding;
		rows.sort((a, b) => {
			if (this.sort !== "model") {
				const left = number(a), right = number(b);
				if (left === undefined && right !== undefined) return 1;
				if (right === undefined && left !== undefined) return -1;
				if (left !== undefined && right !== undefined && left !== right) return (left - right) * (this.descending ? -1 : 1);
			}
			const order = a.id.localeCompare(b.id) || (a.provider ?? "").localeCompare(b.provider ?? "");
			return this.sort === "model" && this.descending ? -order : order;
		});
		return this.sortedRows = rows;
	}

	private selectTab(tab: number) {
		this.tab = (tab + TABS.length) % TABS.length;
		this.sort = this.tab < 2 ? "deal" : "basket";
		this.descending = this.tab < 2;
		this.selected = this.offset = 0;
		this.sortedRows = undefined;
	}

	private setSort(key: SortKey) {
		if (this.sort === key) this.descending = !this.descending;
		else { this.sort = key; this.descending = key !== "basket" && key !== "model"; }
		this.selected = this.offset = 0;
		this.sortedRows = undefined;
	}

	private async reload() {
		if (this.loading) return;
		this.loading = true;
		const focused = this.detail ? this.rows()[this.selected] : undefined;
		this.notice = "Refreshing OpenRouter catalog and endpoints…";
		this.tui.requestRender();
		try {
			const next = await this.refresh();
			if (this.closed) return;
			this.data = next;
			this.sortedRows = undefined;
			const index = focused ? this.rows().findIndex((r) => r.id === focused.id && r.provider === focused.provider) : -1;
			this.selected = index >= 0 ? index : 0;
			this.offset = this.detailScroll.top = 0;
			if (focused && index < 0) this.detail = false;
			this.notice = `Updated ${formatPacific(new Date(next.evaluatedAt))}${focused && index < 0 ? " · this offer is no longer listed" : ""}${next.endpointFailures ? ` · ${next.endpointFailures} endpoint lookups failed` : ""}`;
		} catch (error) {
			if (!this.closed) this.notice = `Refresh failed: ${String(error)}. Previous results retained.`;
		} finally { this.loading = false; if (!this.closed) this.tui.requestRender(); }
	}

	handleInput(data: string) {
		const nav = navKeys(data);
		if (this.filter.handle(data)) {
			// The filter took the key.
		} else if (this.detail) {
			if (nav === "cancel" || nav === "confirm") this.detail = false;
			else if (data === "r") void this.reload();
			else this.detailScroll.handle(nav, this.detailPageRows, this.detailTotal);
		} else if (nav === "cancel") {
			this.closed = true;
			this.done(this.data);
			return;
		} else if (matchesKey(data, "tab") || nav === "right") this.selectTab(this.tab + 1);
		else if (matchesKey(data, "shift+tab") || nav === "left") this.selectTab(this.tab - 1);
		else if (/^[1-4]$/.test(data)) this.selectTab(Number(data) - 1);
		else if (data === "/") this.filter.start();
		else if (data === "r") void this.reload();
		else if (data === "d" && this.tab < 2) this.setSort("deal");
		else if (data === "p") this.setSort("basket");
		else if (data === "i") this.setSort("intel");
		else if (data === "c") this.setSort("coding");
		else if (data === "n") this.setSort("model");
		else {
			const length = this.rows().length, step = stepFor(nav, this.pageRows);
			if (step !== undefined) this.selected = moveIndex(this.selected, step, length);
			else if (nav === "confirm" && length) { this.detail = true; this.detailScroll.top = 0; }
		}
		this.tui.requestRender();
	}

	private detailView(width: number): string[] {
		const r = this.rows()[this.selected];
		if (!r) { this.detail = false; return []; }
		const metric = this.metric();
		const state = r.period === "off-peak" ? "Off-peak" : r.period === "peak" ? "Peak" : r.period === "unlisted" ? "No listed rate" : "Unknown";
		const rates = (input: number | undefined, output: number | undefined) => `In ${displayDealRate(input)} · Out ${displayDealRate(output)} USD/M`;
		const body = [displayDealId(r.id), `Source: ${r.provider ?? "listed model rate"}`,
			this.notice.startsWith("Updated") ? this.notice : `Checked ${formatPacific(new Date(this.data.evaluatedAt))}`,
			...(this.notice.startsWith("Refresh") ? [this.notice] : []),
			...(metric === "saving" ? [
				`At scan: ${state}${r.currentInput !== undefined ? ` · ${rates(r.currentInput, r.currentOutput)}` : r.currentPrice ? ` · ${r.currentPrice}` : ""}`,
				`Cheaper rate: ${rates(r.input, r.output)} · saves ${r.saving === undefined ? "—" : formatPercent(r.saving)} vs peak`,
				...(r.timing ? [
					`Next off-peak: ${displayDealWindow(r.timing.off.start, r.timing.off.end)}`,
					`Peak: ${displayDealWindow(r.timing.peak.start, r.timing.peak.end)}`,
					...(r.timing.windows.length > 2 ? ["", "All listed windows (next occurrence in Pacific):",
						...r.timing.windows.map((w) => `  ${w.period === "peak" ? "Peak" : "Off"} ${displayDealWindow(w.start, w.end)} · ${displayDealRate(w.input)}/${displayDealRate(w.output)}`)] : []),
				] : [r.reason]),
			] : [rates(r.input, r.output), metric === "discount" ? `Provider discount: ${r.discount === undefined ? "—" : formatPercent(r.discount)} · already in price` : `Basket: ${displayDealRate(r.basket)} USD (1M in + 250k out)`]),
			"", `AA Intelligence ${value(r.quality)} · AA Coding ${value(r.coding)} · context ${Math.round(r.context / 1000)}k`,
			r.configured ? "Configured in Pi" : "Not configured; add to models.json before use",
			`Exact offering: ${r.id}`,
			metric === "saving" ? "Rates above are rounded for display; press r to recheck near a window change." : metric === "discount" ? "A provider discount may require routing to that provider." : "Value uses listed prices, not endpoint promotions."];
		const all = frame("Deal details", body, "borderAccent", this.theme, width);
		const content = all.slice(1, -1);
		this.detailTotal = content.length;
		this.detailPageRows = Math.max(1, this.tui.terminal.rows - 3);
		const top = this.detailScroll.window(content.length, this.detailPageRows);
		const label = joinHints(`${keyLabel("tui.select.cancel")}/${hint.enter("back")}`, "r refresh", `${pageKeys()} ${this.detailScroll.range(content.length, this.detailPageRows)}`);
		const border = this.theme.fg("borderAccent", "│");
		const footer = `${border} ${this.theme.fg("dim", fitPad(label, Math.max(1, width - 4)))} ${border}`;
		return [all[0], ...content.slice(top, top + this.detailPageRows), footer, all.at(-1)!];
	}

	render(width: number): string[] {
		if (this.detail) return this.detailView(width);
		const inner = Math.max(1, width - 4);
		const rows = this.rows();
		const compact = inner < 72;
		const tabLabel = TABS.map((name, i) => i === this.tab ? this.theme.fg("accent", `[${i + 1} ${compact ? SHORT_TABS[i] : name} ${[this.data.discounts, this.data.offPeak, this.data.frontier, this.data.light][i].length}]`) : this.theme.fg("muted", `${i + 1} ${compact ? SHORT_TABS[i] : name} ${[this.data.discounts, this.data.offPeak, this.data.frontier, this.data.light][i].length}`)).join(compact ? " " : "  ");
		const sortLabel = `${this.sort === "deal" ? this.tab === 0 ? "discount" : "saving" : this.sort === "basket" ? "cost" : this.sort === "intel" ? "AA Intel" : this.sort === "coding" ? "AA Code" : "model"} ${this.descending ? "↓" : "↑"}`;
		const header = `Deals › ${TABS[this.tab]} · ${rows.length} offer${rows.length === 1 ? "" : "s"}${this.scope ? ` · ${this.scope}` : ""}`;
		const input = this.filter.active ? this.filter.render(inner) : `${this.filter.query ? `Filter ${this.filter.query} · ` : ""}Sort ${sortLabel} · ${rows.length ? `${this.selected + 1}/${rows.length}` : "no matches"}`;
		const descriptions = compact ? ["Discount % included in provider price", "Timed: cheaper In/Out · Off/Peak hours PT", "Frontier: top 15% AA Intel · listed rate", "Light: next 35% AA Intel · listed rate"] : ["Provider discounts · % already included in endpoint price", "Timed rates · In/Out is cheaper rate; next Off/Peak hours in Pacific", "Frontier · AA Intelligence top 15%, listed rate (not a promotion)", "Light · AA Intelligence next 35%, listed rate (not a promotion)"];
		const notice = this.notice || (this.data.endpointFailures ? `${this.data.endpointFailures} endpoint lookups failed · promotions incomplete` : compact ? "AA I/C = Intelligence / Coding indices" : "AA I/C = Artificial Analysis Intelligence / Coding indices");
		const scanned = `Checked ${formatPacific(new Date(this.data.evaluatedAt))} · ${compact ? "USD/M" : "prices USD per M tokens"}`;
		const footers = compact ? [joinHints("1–4 tabs", hint.move("rows"), hint.enter("details")), joinHints("/ filter", "r refresh", hint.cancel("close")), joinHints("Sort d/p/i/c/n", `${pageKeys()} rows`)] : [joinHints("1–4 tabs", `${upDown()}/${pageKeys()} rows`, "/ filter", hint.enter("details"), "r refresh", hint.cancel("close")), "Sort d discount/saving · p cost · i AA Intel · c AA Code · n name (repeat reverses)"];
		const rowHeight = dealRowHeight(inner, this.metric());
		this.pageRows = Math.max(1, Math.floor((this.tui.terminal.rows - (compact ? 13 : 12)) / rowHeight));
		this.selected = moveIndex(this.selected, 0, rows.length);
		this.offset = keepInView(this.offset, this.selected, this.pageRows, rows.length);
		const shown = rows.slice(this.offset, this.offset + this.pageRows);
		const table = dealTableLines(shown, this.metric(), this.theme, inner, rows.length ? this.selected - this.offset : -1);
		const body = [tabLabel, this.theme.fg("dim", fit(descriptions[this.tab], inner)), this.theme.fg("dim", fit(scanned, inner)), this.theme.fg("dim", fit(input, inner)), "", ...table,
			...(rows.length ? [] : [this.theme.fg("muted", "No matching offers here. Try another tab or filter.")]), "", this.theme.fg(this.data.endpointFailures ? "warning" : "dim", notice),
			...footers.map((s) => this.theme.fg("dim", s))];
		return frame(header, body.map((line) => fit(line, inner)), "borderAccent", this.theme, width);
	}

	invalidate() { this.filter.invalidate(); }
	dispose() { this.closed = true; }
}
