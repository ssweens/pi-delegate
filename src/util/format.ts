/** Time formatting with one definition each, so a duration reads the same in every panel. */

/** How long something ran: `45s`, `4m05s`, `1h05m`. Floors; never negative. */
export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** How long ago, coarsely, for the far right of a row: `now`, `4m`, `1h`, `2d`. */
export function formatAge(at: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.round((now - at) / 1000));
	if (seconds < 60) return "now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

/** Wall-clock `HH:MM` in local time. */
export function clockTime(at: number): string {
	const date = new Date(at);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** A token count: `842`, `12.4k`. */
export const formatTokens = (count: number): string => count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);

/** Whole days since `at`: the unit for how stale an approval or a rating is. */
export const ageDays = (at: number, now = Date.now()): number => Math.floor((now - at) / 86_400_000);
