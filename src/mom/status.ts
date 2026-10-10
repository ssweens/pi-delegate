/** Elapsed-time formatting and error summaries for Mom's panel. */

export function formatElapsed(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Keep the actionable cause visible; full provider/file diagnostics belong in details. */
export function updateErrorSummary(error: string): string {
	if (/Graph transaction (defects|rejected)/.test(error)) return "The proposed notes did not pass consistency checks.";
	if (error.includes("Mom evidence remained unreadable")) return "An update was rejected while some source files were unavailable.";
	if (error.includes("ENOENT")) return "A file Mom needs is missing.";
	if (error.includes("Unchanged needs an existing map")) return "Mom's no-change reply could not be accepted.";
	if (/finished without an accepted.*graph transaction/.test(error)) return "Mom returned no usable update.";
	const message = error.replace(/^Error:\s*/, "").replace(/\s+/g, " ").trim();
	return message.length > 200 ? `${message.slice(0, 197)}…` : message;
}
