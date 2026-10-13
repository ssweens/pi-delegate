/**
 * Joining runs: the one wait loop behind delegate_ctl wait, for runs of either backend, one or several. Each
 * backend holds its runs for the wait through a Join; this loop decides when the wait ends. A wait never cancels
 * a run: a timeout, an abort or queued parent messages end the wait only.
 */

/** How often a wait rechecks queued parent messages, a stranded run and its deadline. */
export const WAIT_POLL_MS = 1000;

/** A wait the caller aborted: it only detaches, whatever it joined keeps running. */
export function waitCancelled(subject: "child" | "runs"): DOMException {
	return new DOMException(`Wait cancelled; the ${subject === "child" ? "child is" : "runs are"} unaffected.`, "AbortError");
}

/** One joined run as the wait sees it now. */
export interface JoinedRun<V> { id: string; settled: boolean; view: V }

/**
 * One backend's hold on some runs for one wait. While held, a run that settles reports to the wait instead of
 * waking its parent; what the wait reports is delivered by it.
 */
export interface Join<V> {
	views(): JoinedRun<V>[];
	/**
	 * Resolve when a pending run may have settled, or after `ms`. False when nothing can report the pending runs any
	 * more (the wait is lost); a rejection fails the wait.
	 */
	next(pending: readonly V[], ms: number): Promise<boolean>;
	/** The ID of a run that stopped without reporting completion: the wait cannot return its result. */
	stranded?(): string | undefined;
	/** The wait reports these settled runs: they wake no one. Returns them as reported (read once more, if it must). */
	claim(settled: readonly V[]): Promise<V[]> | V[];
	/** End the hold. Aborted: nothing was reported, so a run that settled during the wait wakes its parent as usual. */
	release(aborted: boolean): void;
}

export interface JoinOptions {
	signal?: AbortSignal;
	/** Queued parent messages: the wait returns so the parent reads them, and the runs keep going. */
	interrupted?: () => boolean;
	timeoutMs?: number;
	/** What a join that can no longer report its runs lost, for the lost outcome. */
	lost: string;
}

export interface JoinOutcome<V> {
	/** settled: the mode is satisfied. timeout: runs keep going. interrupted: queued parent messages. lost: a run cannot report. */
	reason: "settled" | "timeout" | "interrupted" | "lost";
	settled: V[];
	pending: V[];
	/** A lost wait: what can no longer report (JoinOptions.lost), or the run that stopped without reporting (`stranded`). */
	lost?: string;
	stranded?: string;
}

/** Join `ids`, held by `joins`, until `mode` is satisfied or the wait ends otherwise. Views come back in `ids` order. */
export async function joinRuns<V>(joins: readonly Join<V>[], ids: readonly string[], mode: "any" | "all", options: JoinOptions): Promise<JoinOutcome<V>> {
	const { signal } = options;
	if (signal?.aborted) {
		for (const join of joins) join.release(true);
		throw waitCancelled(ids.length === 1 ? "child" : "runs");
	}
	const deadline = options.timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + options.timeoutMs;
	// At most one next() per join at a time: a pass woken by another join reuses the one still outstanding.
	const outstanding = new Map<Join<V>, Promise<void>>();
	let lost: string | undefined;
	let failure: { error: unknown } | undefined;
	let aborted = false;
	try {
		for (;;) {
			const byId = new Map(joins.flatMap((join) => join.views().map((row) => [row.id, { ...row, join }] as const)));
			const rows = ids.map((id) => byId.get(id)!);
			const settled = rows.filter((row) => row.settled), pending = rows.filter((row) => !row.settled);
			const end = async (reason: JoinOutcome<V>["reason"], lostWhat?: Pick<JoinOutcome<V>, "lost" | "stranded">): Promise<JoinOutcome<V>> => {
				const reported = new Map<string, V>();
				for (const join of joins) {
					const mine = settled.filter((row) => row.join === join);
					if (!mine.length) continue;
					(await join.claim(mine.map((row) => row.view))).forEach((view, index) => reported.set(mine[index]!.id, view));
				}
				return { reason, settled: settled.map((row) => reported.get(row.id) ?? row.view), pending: pending.map((row) => row.view), ...lostWhat };
			};
			if (mode === "any" ? settled.length > 0 : pending.length === 0) return await end("settled");
			if (failure) throw failure.error;
			if (signal?.aborted) { aborted = true; throw waitCancelled(ids.length === 1 ? "child" : "runs"); }
			if (options.interrupted?.()) return await end("interrupted");
			if (lost) return await end("lost", { lost });
			for (const join of joins) { const stranded = join.stranded?.(); if (stranded) return await end("lost", { stranded }); }
			const left = deadline - Date.now();
			if (left <= 0) return await end("timeout");
			const slice = Math.min(WAIT_POLL_MS, left);
			await new Promise<void>((resolve) => {
				let done = false;
				const finish = () => {
					if (done) return;
					done = true;
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					resolve();
				};
				const onAbort = () => finish();
				const timer = setTimeout(() => finish(), slice);
				signal?.addEventListener("abort", onAbort, { once: true });
				for (const join of joins) {
					const waiting = pending.filter((row) => row.join === join).map((row) => row.view);
					if (!waiting.length) continue;
					let next = outstanding.get(join);
					if (!next) {
						next = join.next(waiting, slice).then((reported) => { if (!reported) lost ??= options.lost; }, (error: unknown) => { failure ??= { error }; })
							.finally(() => { outstanding.delete(join); });
						outstanding.set(join, next);
					}
					void next.then(finish);
				}
			});
		}
	} finally {
		for (const join of joins) join.release(aborted);
	}
}
