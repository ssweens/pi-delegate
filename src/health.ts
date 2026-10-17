/**
 * What a running child looks like from outside: how much budget is left and whether it is moving. Pure, so the
 * status board, the watchdog alerts and the timeout messages all read one verdict.
 */
import type { Run } from "./pi-backend.js";
import { WRITE_TOOLS } from "./roles.js";

/** No tool call or message for this long: the child is silent. */
export const SILENT_MS = 6 * 60_000;
/** One assistant turn open this long: the child is slow (a long think, or a stuck provider). */
export const SLOW_TURN_MS = 3 * 60_000;
/** The wrap-up notice goes out this long before the hard timeout, or at 15% of the budget when that is larger. */
export const WRAP_UP_MIN_MS = 3 * 60_000;
/** The same call (tool and arguments) this many times among the last LOOP_WINDOW calls of the segment: looping. */
export const LOOP_REPEATS = 4;
export const LOOP_WINDOW = 8;
/** A writer's first deliverable is due this long into a segment, or at FIRST_DELIVERABLE_SHARE of its budget when that is sooner. */
export const FIRST_DELIVERABLE_MS = 15 * 60_000;
export const FIRST_DELIVERABLE_SHARE = 0.25;
/** ...but never sooner than this (a short budget still needs time to read), nor later than half the budget. */
export const FIRST_DELIVERABLE_FLOOR_MS = 6 * 60_000;
/** A writer's last this many calls of the segment without an edit or write, once it owes a deliverable: browsing. */
export const BROWSE_CALLS = 25;

export type Verdict = "moving" | "slow" | "silent" | "retrying" | "looping" | "no-artifact" | "browsing" | "settled";

export interface Health {
	verdict: Verdict;
	/** ms since the last tool start/end or message end; undefined before the first one. */
	sinceProgressMs?: number;
	/** ms the current assistant turn has been open; 0 between turns. */
	turnMs: number;
	/** ms until the hard timeout of the current segment; undefined once settled. */
	budgetLeftMs?: number;
	/** Wall-clock end of the current segment's budget. */
	endsAt?: number;
	/** looping: the repeated call's tool and how many times it appears in the window. */
	loop?: { name: string; count: number };
	/** When the first deliverable is due, while the run has a deadline and has written nothing yet. */
	dueAt?: number;
}

/** What runHealth reads; the looping, no-artifact and browsing facts are optional, so a caller without them gets the other verdicts. */
export type HealthInput = Pick<Run, "status" | "segmentStartedAt" | "timeoutMs" | "providerRetry"> & {
	lastProgressAt?: number; turnStartedAt?: number;
	toolCalls?: Run["toolCalls"]; changedFiles?: string[]; writer?: boolean; runtime?: "oven"; tools?: string[]; firstDeliverableMin?: number;
};

/**
 * When the current segment's first deliverable is due: `firstDeliverableMin` from the segment's start when the call set
 * it, else for a writer FIRST_DELIVERABLE_SHARE of the budget (at least FIRST_DELIVERABLE_FLOOR_MS, at most FIRST_DELIVERABLE_MS and half the budget). A
 * non-writer has no deadline unless the call set one.
 */
export function firstDeliverableAt(run: Pick<HealthInput, "segmentStartedAt" | "timeoutMs" | "writer" | "runtime" | "tools" | "firstDeliverableMin">): number | undefined {
	if (run.firstDeliverableMin !== undefined) return run.segmentStartedAt + run.firstDeliverableMin * 60_000;
	if (!owesFiles(run)) return undefined;
	return run.segmentStartedAt + Math.min(run.timeoutMs / 2, FIRST_DELIVERABLE_MS, Math.max(FIRST_DELIVERABLE_FLOOR_MS, run.timeoutMs * FIRST_DELIVERABLE_SHARE));
}

/** Owes files: a writer, or an oven slice whose tools can write (oven runs in its own copy, so it is not a `writer` for the one-writer-per-tree lock). */
const owesFiles = (run: Pick<HealthInput, "writer" | "runtime" | "tools">) =>
	Boolean(run.writer || (run.runtime === "oven" && run.tools?.some((t) => t === "*" || WRITE_TOOLS.includes(t))));

/** Local wall-clock HH:MM. */
export const clock = (at: number) => new Date(at).toTimeString().slice(0, 5);

const writes = (name: string) => WRITE_TOOLS.includes(name);
const callKey = (call: { name: string; args: unknown }) => `${call.name}\0${stable(call.args)}`;
/** JSON with object keys sorted, so the same arguments in another order are the same call. */
function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable((value as any)[k])}`).join(",")}}`;
	return JSON.stringify(value) ?? "null";
}

/**
 * The repeated call among the segment's last LOOP_WINDOW calls, when one appears LOOP_REPEATS times and no other edit or
 * write in the window grew the work. An in-process run's changedFiles is only read at settle, so a write call in the
 * window stands for growth.
 */
export function findLoop(calls: Run["toolCalls"], since: number): Health["loop"] {
	const window = calls.filter((c) => c.at >= since).slice(-LOOP_WINDOW);
	const counts = new Map<string, { name: string; count: number }>();
	for (const call of window) {
		const entry = counts.get(callKey(call)) ?? { name: call.name, count: 0 };
		entry.count++;
		counts.set(callKey(call), entry);
	}
	const top = [...counts.entries()].sort((a, b) => b[1].count - a[1].count)[0];
	if (!top || top[1].count < LOOP_REPEATS) return undefined;
	if (window.some((c) => writes(c.name) && callKey(c) !== top[0])) return undefined;
	return top[1];
}

export function runHealth(run: HealthInput, now = Date.now()): Health {
	if (run.status !== "running") return { verdict: "settled", turnMs: 0 };
	const endsAt = run.segmentStartedAt + run.timeoutMs;
	const since = run.lastProgressAt === undefined ? undefined : now - run.lastProgressAt;
	const turnMs = run.turnStartedAt === undefined ? 0 : now - run.turnStartedAt;
	const calls = (run.toolCalls ?? []).filter((c) => c.at >= run.segmentStartedAt);
	const edited = calls.some((c) => writes(c.name));
	const deadline = firstDeliverableAt(run);
	const dueAt = edited || run.changedFiles?.length ? undefined : deadline;
	const base = { sinceProgressMs: since, turnMs, budgetLeftMs: endsAt - now, endsAt, ...(dueAt !== undefined ? { dueAt } : {}) };
	if (run.providerRetry) return { verdict: "retrying", ...base };
	const loop = findLoop(calls, run.segmentStartedAt);
	if (loop) return { verdict: "looping", ...base, loop };
	if ((since ?? now - run.segmentStartedAt) > SILENT_MS) return { verdict: "silent", ...base };
	if (owesFiles(run) && dueAt !== undefined && now >= dueAt) return { verdict: "no-artifact", ...base };
	// Before its first edit of the segment and its deadline a writer is expected to read; after either, BROWSE_CALLS
	// calls in a row without an edit is browsing.
	if (owesFiles(run) && (edited || (deadline !== undefined && now >= deadline)) && calls.length >= BROWSE_CALLS
		&& !calls.slice(-BROWSE_CALLS).some((c) => writes(c.name))) return { verdict: "browsing", ...base };
	if (turnMs > SLOW_TURN_MS) return { verdict: "slow", ...base };
	return { verdict: "moving", ...base };
}

/** "ends 18:51 (7 min left)" for a running segment; empty once settled. */
export function budgetText(h: Health): string {
	if (h.endsAt === undefined || h.budgetLeftMs === undefined) return "";
	return `ends ${clock(h.endsAt)} (${Math.max(0, Math.round(h.budgetLeftMs / 60_000))} min left)`;
}
