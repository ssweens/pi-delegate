/** Scrolling and selection movement, one definition for every list and text page. */
import type { Component } from "@earendil-works/pi-tui";
import { navKeys, type Nav } from "./keys.ts";
import { fit } from "./text.ts";

/** The first visible row that keeps `selected` in a window of `height` rows over `total`. */
export const keepInView = (scroll: number, selected: number, height: number, total: number): number =>
	Math.min(Math.max(scroll, selected - height + 1, 0), selected, Math.max(0, total - height));

/** `index` moved by `step` and held inside `total` rows (empty: 0). A step may be ±Infinity to reach an end. */
export const moveIndex = (index: number, step: number, total: number): number =>
	Math.max(0, Math.min(total - 1, index + step));

/** How far a navigation key moves a position; the page keys count only when `page` rows are given. Undefined for any other key. */
export function stepFor(nav: Nav | undefined, page?: number): number | undefined {
	switch (nav) {
		case "up": return -1;
		case "down": return 1;
		case "pageUp": return page === undefined ? undefined : -page;
		case "pageDown": return page;
		case "home": return -Infinity;
		case "end": return Infinity;
		default: return undefined;
	}
}

/** The scroll position of a text page. */
export class Scroller {
	top = 0;

	/** The top row for `total` lines shown `rows` at a time, held in range. */
	window(total: number, rows: number): number {
		return this.top = Math.max(0, Math.min(this.top, total - rows));
	}

	/** Scroll for a navigation key; false when the key is not a scroll key. */
	handle(nav: Nav | undefined, rows: number, total: number): boolean {
		const step = stepFor(nav, rows);
		if (step === undefined) return false;
		this.top = Math.max(0, Math.min(this.top + step, Math.max(0, total - rows)));
		return true;
	}

	/** `1–20/45`, or empty when everything fits. */
	range(total: number, rows: number): string {
		return total > rows ? `${this.top + 1}–${Math.min(total, this.top + rows)}/${total}` : "";
	}
}

export interface PagedTextOptions {
	/** The page's lines at `width`. */
	lines(width: number): string[];
	/** Rows of lines shown at once. */
	rows(): number;
	/** Rows above and below the lines; `range` is the scroll range, empty when all fits. */
	chrome?(width: number, range: string, scrollable: boolean): { head?: string[]; foot?: string[] };
	/** Keys beyond scrolling; true when consumed. */
	onKey?(data: string): boolean;
}

/** A read-only page of text scrolled by the navigation keys. */
export class PagedText implements Component {
	private readonly scroller = new Scroller();
	private total = 0;

	constructor(private readonly options: PagedTextOptions) {}

	handleInput(data: string): void {
		if (this.options.onKey?.(data)) return;
		this.scroller.handle(navKeys(data), this.options.rows(), this.total);
	}

	render(width: number): string[] {
		const rows = this.options.rows(), lines = this.options.lines(width);
		this.total = lines.length;
		const top = this.scroller.window(this.total, rows);
		const { head = [], foot = [] } = this.options.chrome?.(width, this.scroller.range(this.total, rows), this.total > rows) ?? {};
		return [...head, ...lines.slice(top, top + rows).map(line => fit(line, width)), ...foot];
	}

	invalidate(): void {}
}
