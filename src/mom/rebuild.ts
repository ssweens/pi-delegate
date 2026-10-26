import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { graphChange, isCheckpoint, loadState, type Checkpoint } from "./checkpoint.ts";
import { STATUS_DOC, type MomStatus } from "./engine.ts";
import { extractEvents } from "./feed.ts";
import { readGraph } from "./mother.ts";
import { encodeRequest } from "./operation.ts";
import { OVEN_EXPIRES, oven, ovenSliceUrl, requireExpiry } from "./oven.ts";
import { formatDuration } from "../util/format.ts";
import { sessionFromFile } from "./session-file.ts";
import { completeLines } from "../util/jsonl.ts";
import { SidecarStore } from "./sidecar.ts";
import { identityOf, momConfiguration, type SessionIdentity } from "./slice.ts";
import { presentGraph, type WorkView } from "../ui/presentation.ts";

/** A reconstruction is kept in memory until the user accepts it; the original sidecar is never an input. */
export interface RebuiltMap {
	checkpoint: Checkpoint;
	view: WorkView;
	baseId?: string;
	session: SessionIdentity;
	branchIds: string[];
	sourceSize: number;
	batches: number;
}

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, index) => id === b[index]);

function sameBranch(context: ExtensionContext, candidate: RebuiltMap): boolean {
	return identityOf(context.sessionManager, context.cwd).sessionFile === candidate.session.sessionFile &&
		context.sessionManager.getSessionId() === candidate.session.sessionId &&
		sameIds(context.sessionManager.getBranch().map(entry => entry.id), candidate.branchIds);
}

/** Reuse Path's cold thread-map catch-up, but in an unfollowed Oven slice (it expires like a delegate run's) with its own session copy and sidecar. */
export async function rebuildMap(context: ExtensionContext, identity: SessionIdentity, flags: Record<string, string | boolean | undefined>,
	progress: (message: string, sliceUrl?: string) => void, signal: AbortSignal): Promise<RebuiltMap> {
	const branch = context.sessionManager.getBranch();
	const branchIds = branch.map(entry => entry.id);
	const leaf = context.sessionManager.getLeafId();
	if (!leaf || !branch.length) throw new Error("This session has no saved branch to rebuild.");
	const original = new SidecarStore(() => identity.sessionFile, identity.sessionId);
	const baseId = (await loadState(original, context.sessionManager)).checkpointId;
	const folder = await mkdtemp(join(tmpdir(), "pi-mom-rebuild-"));
	const file = join(folder, "session.jsonl");
	let slice: string | undefined;
	try {
		const bytes = await readFile(identity.sessionFile);
		const lines = completeLines(bytes);
		if (!lines.length) throw new Error("The session transcript has no complete entries.");
		await writeFile(file, bytes.subarray(0, bytes.lastIndexOf(0x0a) + 1), { mode: 0o600 });
		// Validate the selected branch against saved bytes before adding anything to the copy.
		const reader = sessionFromFile(file, leaf);
		if (!sameIds(reader.getBranch().map(entry => entry.id), branchIds))
			throw new Error("The selected branch is not fully recorded in the transcript yet.");
		// Pi can select a branch other than the file's last leaf. Put its recorded leaf last
		// in the private copy so Oven's current-session reader follows that same branch.
		if (JSON.parse(lines[lines.length - 1]!.line).id !== leaf) await appendFile(file, JSON.stringify(reader.getEntry(leaf)) + "\n");
		if (signal.aborted) throw signal.reason;
		const config = momConfiguration({ ...identity, sessionFile: file },
			{ ...flags, "mom-bootstrap": "1" }, context.modelRegistry);
		const created = await oven<{ id: string; expires?: unknown; expiryAction?: string; missingTools?: string[] }>("create", {
			owner: { client: "pi-delegate", session: identity.sessionId }, key: `mom-rebuild-${randomUUID()}`, cwd: identity.cwd, copy: "none", expires: OVEN_EXPIRES, expiryAction: "archive",
			config: { ...config, follow: undefined, retry: [] },
		});
		// Refuse providers whose lease could destroy the saved history.
		await requireExpiry(created, oven);
		slice = created.id;
		if (created.missingTools?.includes("mom_begin") || created.missingTools?.includes("commit_graph"))
			throw new Error("Oven's Path extension is stale; restart Oven before rebuilding.");
		const store = new SidecarStore(() => file, identity.sessionId);
		let previousCut = "";
		const sliceUrl = ovenSliceUrl(slice);
		for (let batch = 1; ; batch++) {
			if (signal.aborted) throw signal.reason;
			const started = Date.now();
			let activity = "starting", streamed = 0, shown = "";
			const report = () => {
				const message = `Rebuilding · pass ${batch} · ${activity}${streamed ? ` · ${streamed.toLocaleString()} chars streamed` : ""} · ${formatDuration(Date.now() - started)}`;
				if (message !== shown) { shown = message; progress(message, sliceUrl); }
			};
			const observe = (event: any) => {
				const previous = activity;
				const status = event.type === "snapshot" ? event.docs?.[STATUS_DOC] : event.type === "doc" && event.name === STATUS_DOC ? event.value : undefined;
				if (status?.op?.activity) activity = status.op.activity;
				const message = event.type === "snapshot" ? event.partial : event.type === "partial" ? event.message : undefined;
				if (message) {
					streamed = 0; activity = "waiting for model";
					for (const block of message.content ?? []) {
						if (block.type === "thinking") { activity = "reasoning"; streamed += block.thinking?.length ?? 0; }
						else if (block.type === "text") { activity = "responding"; streamed += block.text?.length ?? 0; }
						else if (block.type === "toolCall") activity = `preparing ${block.name}`;
					}
				}
				if (event.type === "tool") {
					streamed = 0;
					activity = `${event.tool.name} ${event.tool.status === "running" ? "running" : "finished"}`;
				}
				if (activity !== previous) report();
			};
			report();
			await oven("send", { slice, text: encodeRequest(file, { kind: "rebuild" }), requestId: `${slice}:pass:${batch}` }, { signal });
			const timer = setInterval(report, 1000); timer.unref();
			let settled: { type: string; slice: { state: string; detail?: string } };
			try {
				settled = await oven("watch", { slice, untilSettled: true },
					{ signal: AbortSignal.any([signal, AbortSignal.timeout(600_000)]), onEvent: observe });
			} finally { clearInterval(timer); }
			if (settled?.type !== "settled" || settled.slice.state !== "idle")
				throw new Error(`Rebuild stopped (${settled?.slice?.state ?? "unknown"}): ${settled?.slice?.detail ?? "Oven did not finish its pass."}`);
			const result = await oven<{ docs: Record<string, MomStatus> }>("state", { slice, names: [STATUS_DOC] }, { signal });
			store.invalidate();
			const state = await loadState(store, reader);
			const status = result.docs[STATUS_DOC];
			if (status?.lastError || state.error || state.failure) throw new Error(status?.lastError ?? state.error ?? state.failure?.error);
			if (state.skipped?.length || state.gaps.length || status?.unavailable?.length)
				throw new Error("Some transcript or worker evidence was unavailable; the incomplete map cannot replace the saved one.");
			const cut = state.coverageCut ?? state.checkpoint?.cut;
			if (!cut || !state.checkpoint) throw new Error("Path did not produce a map from the selected branch.");
			if (status?.more) {
				const key = JSON.stringify(cut);
				if (key === previousCut) throw new Error("Rebuild made no progress; the saved map is unchanged.");
				previousCut = key;
				continue;
			}
			const checkpoint = { ...state.checkpoint, cut };
			if (!isCheckpoint(checkpoint)) throw new Error("Path produced an invalid rebuilt map.");
			const events = branch.flatMap(entry => extractEvents({ key: identity.sessionId, actor: "lead" }, entry));
			return { checkpoint, view: presentGraph(readGraph([], checkpoint, state.checkpointId, events)), baseId,
				session: identity, branchIds, sourceSize: bytes.length, batches: batch };
		}
	} finally {
		// Stop the private writer before deleting its transcript and sidecar. An interrupted run
		// cannot write to the original .mom file, even when the modal closes mid-pass.
		if (slice) {
			const released = await oven("archive", { slice });
			if (!released?.archived || released.state === "running") throw new Error(`Rebuild execution release unconfirmed for ${slice}`);
		}
		await rm(folder, { recursive: true, force: true });
	}
}

/** One explicit replacement; keep the old checkpoints and controls in the append-only sidecar. */
export async function acceptRebuiltMap(context: ExtensionContext, candidate: RebuiltMap): Promise<void> {
	const { session, checkpoint, baseId } = candidate;
	const store = new SidecarStore(() => session.sessionFile, session.sessionId);
	const verify = async () => {
		if ((await stat(session.sessionFile)).size !== candidate.sourceSize)
			throw new Error("The session transcript changed while Path rebuilt it; rebuild again before replacing its map.");
		if (!sameBranch(context, candidate)) throw new Error("The session branch changed; rebuild again before replacing Path's map.");
		const fresh = new SidecarStore(() => session.sessionFile, session.sessionId);
		const state = await loadState(fresh, context.sessionManager);
		if (state.checkpointId !== baseId) throw new Error("Path's saved map changed while you inspected the rebuild; rebuild again before replacing it.");
		return state;
	};
	const state = await verify();
	const snapshot: Checkpoint = { ...checkpoint, sessionId: session.sessionId, at: Date.now(),
		graph: { ...checkpoint.graph, revision: Math.max(checkpoint.graph.revision, (state.checkpoint?.graph.revision ?? -1) + 1) },
		change: graphChange(state.checkpoint?.graph ?? null, checkpoint.graph) };
	if (!isCheckpoint(snapshot)) throw new Error("The rebuilt checkpoint is invalid; the saved map is unchanged.");
	await store.append("map", { snapshot, base: baseId ?? null, failure: null, resolvedGaps: state.gaps.map(gap => gap.id) },
		randomUUID(), async () => { await verify(); });
}
