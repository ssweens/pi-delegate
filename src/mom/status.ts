/** Error summaries and usage text for Path's panel. */
import { oneLine } from "../util/text.ts";
import { formatDuration } from "../util/format.ts";
import type { Usage } from "./checkpoint.ts";


/** User-facing failures that are matched by text elsewhere, so each is written once. */
export const NO_ACCEPTED_TRANSACTION = "Path finished without an accepted background graph transaction.";
export const UNREADABLE_SOURCES = "Path cannot retry a skipped range because its recorded sources are unreadable.";

/** What Path shows before its saved view has loaded. */
export const WAITING_FOR_VIEW = "Waiting for Path's saved view. Existing notes have not been loaded.";

/** A session's model usage as two lines; the input count includes what came from or went to the cache. */
export const formatUsage = (usage: Usage): string => {
	const cached = usage.cacheRead + usage.cacheWrite;
	const cache = cached ? ` (${usage.cacheRead.toLocaleString()} cache read · ${usage.cacheWrite.toLocaleString()} cache write)` : "";
	return `Model calls: ${usage.calls} · ${formatDuration(usage.elapsedMs)} total model/update time\n${(usage.input + cached).toLocaleString()} input tokens${cache} · ${usage.output.toLocaleString()} output tokens · $${usage.nominalCost.toFixed(4)} nominal cost`;
};

/** One operation's timing. */
export const formatTiming = (timing: { totalMs: number; startupMs: number; requestMs: number }): string =>
	`${formatDuration(timing.totalMs)} total · ${formatDuration(timing.startupMs)} startup · ${formatDuration(timing.requestMs)} model requests`;

/** Keep the actionable cause visible; full provider/file diagnostics belong in details. */
export function updateErrorSummary(error: string): string {
	if (/Graph transaction (defects|rejected)/.test(error)) return "The proposed notes did not pass consistency checks.";
	if (error.includes("Path evidence remained unreadable")) return "An update was rejected while some source files were unavailable.";
	if (error.includes("ENOENT")) return "A file Path needs is missing.";
	if (error.includes("Unchanged needs an existing map")) return "Path's no-change reply could not be accepted.";
	if (error.includes(NO_ACCEPTED_TRANSACTION)) return "Path returned no usable update.";
	return oneLine(error.replace(/^Error:\s*/, ""), 200);
}
