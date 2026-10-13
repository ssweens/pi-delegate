/** Display-width fitting for the TUI surfaces, one definition each (pi-tui's `truncateToWidth` underneath). */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** `text` cut to at most `width` columns with `…`; empty when there is no room. */
export const fit = (text: string, width: number): string => width > 0 ? truncateToWidth(text, width, "…") : "";

/** `fit`, then padded with spaces to exactly `width` columns. */
export const fitPad = (text: string, width: number): string => width > 0 ? truncateToWidth(text, width, "…", true) : "";

/** `fit` into a cell of exactly `width` columns, padded on the left when `right` (a number column). */
export function fitAlign(text: string, width: number, right = false): string {
	const cell = fit(text, width);
	return right ? padTo("", width - visibleWidth(cell)) + cell : padTo(cell, width);
}

/** `text` padded with spaces to `width` columns (unchanged when already as wide). */
export const padTo = (text: string, width: number): string => text + " ".repeat(Math.max(0, width - visibleWidth(text)));

/** A fitted, padded row on the selection background. */
export const selectedRow = (theme: Theme, line: string, width: number): string => theme.bg("selectedBg", fitPad(line, width));

/** `text` cut to at most `width` columns with no ellipsis (a post-frame safety cut); empty when there is no room. */
export const cut = (text: string, width: number): string => truncateToWidth(text, Math.max(0, width), "");

/** One level of tree indent per `depth`. */
export const indent = (depth: number): string => "  ".repeat(Math.max(0, depth));

/** Two columns on one row: `left` padded to `leftWidth`, `divider`, then `right` fitted to what remains of `width`. */
export const sideBySide = (left: string, right: string, leftWidth: number, divider: string, width: number): string =>
	fitPad(left, leftWidth) + divider + fit(right, width - leftWidth - visibleWidth(divider));
