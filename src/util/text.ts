/**
 * Plain-text helpers with one definition each, shared by the delegate, Path, the trail, ACP and the UI.
 * Display-width fitting (ANSI, wide characters) is not here: that is pi-tui's `truncateToWidth`.
 */

/** An error's message, or the thrown value as text. */
export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** A plain object (not null, not an array). */
export const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
/** A finite number in [0, 1]. */
export const isProbability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
/** A safe integer ≥ 0. */
export const isNonNegativeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Every whitespace run as one space, trimmed. */
export const flatten = (text: string): string => text.replace(/\s+/g, " ").trim();

export interface ClipOptions {
	/** Cut back to a word boundary when one falls in the last half of the kept text. */
	words?: boolean;
	/** Appended when text is cut; counted in `max`. Empty for a hard cut. Default "…". */
	ellipsis?: string;
}

/** `text` in at most `max` characters, the ellipsis included; unchanged when it fits. */
export function clipText(text: string, max: number, options: ClipOptions = {}): string {
	if (text.length <= max) return text;
	const ellipsis = options.ellipsis ?? "…";
	const room = Math.max(0, max - ellipsis.length);
	let head = text.slice(0, room);
	if (options.words) { const space = head.lastIndexOf(" "); if (space > room / 2) head = head.slice(0, space); }
	return `${head.trimEnd()}${ellipsis}`;
}

/** Flattened to one line and clipped: the usual form of a caption, intent or excerpt. */
export const oneLine = (text: string, max: number, options?: ClipOptions): string => clipText(flatten(text), max, options);

/** A message's or result's text blocks joined by `separator` (a string content is returned as is). */
export function textOf(content: unknown, separator = "\n"): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text as string).join(separator);
}
