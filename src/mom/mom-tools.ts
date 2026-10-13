/**
 * Path's tools, as the Durable extension oven installs by name: `mom` (its operation, evidence and
 * finalizers). Each message its slice gets starts
 * an operation: `mom_begin` (engine.ts) prepares it and keeps its header in a Durable document; its
 * other tools rebuild the evidence from the lead's session file and its `.mom` file, and keep
 * per-operation progress (pages read, rejections) in a Durable document. Acceptance writes the map record
 * `${job}:map` to the `.mom` file, once; in trail mode the waypoints go to `session.trail` first and that
 * record carries only the coverage cursor. Child steps (audits, checks) carry their header in their first
 * message instead. Only these tools write the `.mom` and `.trail` files on the Oven side.
 *
 * oven calls the default export with its own `@earendil-works/pi-durable`.
 */
import { existsSync } from "node:fs";
import type * as Durable from "@earendil-works/pi-durable";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { graphChange, isCheckpoint, loadState, noticeKey, type Checkpoint } from "./checkpoint.ts";
import { acceptGraph, decodeJsonList, decodeLists, momTools, validateSearchQuery } from "./contract.ts";
import { V2_MODE, modeFor } from "./modes.ts";
import { commitV2Tool } from "./v2.ts";
import { branchIds, isUserDirection, LiveFeed, type FeedEvent } from "./feed.ts";
import { editGraph, emptyGraph, isEndeavor, sourceSuggestion, Unfinished, type GraphNode } from "./graph.ts";
import { Beverly, type LabelVerdict } from "./classify.ts";
import { decodeOperation, decodeStart, OPERATION_FAILED, type OperationHeader } from "./operation.ts";
import { accepted, begin, docsFor, failed, GIVE_UP, readOperation, readInstructionSettings, rejected, type Engine } from "./engine.ts";
import { sessionFromFile } from "./session-file.ts";
import { SidecarStore } from "./sidecar.ts";
import { recordWaypointsTool } from "../trail/prompt.ts";
import { TrailStore, trailFor } from "../trail/store.ts";
import { sortTiers, STEP_KINDS, trailEntries, validateWaypointInputs, type Revision, type Waypoint } from "../trail/types.ts";
import { planRepair } from "../trail/repair.ts";
import { clipText, errorMessage, isRecord, textOf } from "../util/text.ts";
import { parseRef } from "../util/ref.ts";
import { UNREADABLE_SOURCES } from "./status.ts";

const FINALIZERS = new Set(["commit_graph", "commit_v2", "commit_labels", "record_thread_map", "record_waypoints"]);
const BEGIN = "mom_begin";
const SOLE = "Path finalization requires a sole direct tool call, never a batch or nested call.";

const item = Type.Object({ text: Type.String({ minLength: 1 }), sources: Type.Array(Type.String(), { minItems: 1 }) }, { additionalProperties: false });
const items = Type.Array(item);
const chapterState = Type.Object({ chapter: Type.String(), goal: items, decisions: items, artifacts: items, deadEnds: items, openQuestions: items }, { additionalProperties: false });
const threadMap = Type.Object({ states: Type.Array(chapterState, { minItems: 1 }) }, { additionalProperties: false });
const ITEM_FIELDS = ["goal", "decisions", "artifacts", "deadEnds", "openQuestions"] as const;

type World = { store: SidecarStore; state: Awaited<ReturnType<typeof loadState>>; feed: LiveFeed; known: Map<string, FeedEvent>; newRefs: Set<string>;
	/** Worker transcripts in the cut that are gone: their sources read as missing files. */
	missing: Map<string, string> };
/** Rebuilt evidence per operation; a cache, not authority: a restart rebuilds it from the files. */
const worlds = new Map<string, Promise<World>>();

async function rebuild(op: OperationHeader): Promise<World> {
	const reader = sessionFromFile(op.session.file, op.session.leaf);
	const store = new SidecarStore(() => op.session.file, op.session.id);
	const state = await loadState(store, reader, { mode: op.mapMode });
	let feed = new LiveFeed(reader);
	const cut = op.cut ?? state.coverageCut ?? state.checkpoint?.cut;
	// A worker transcript that disappeared stays unreviewed; readable evidence is still reconciled.
	const missing = new Map<string, string>();
	try { await feed.restore(cut); }
	catch (error) {
		if (!cut?.workers.length) throw error;
		for (const worker of cut.workers) if (!existsSync(worker.file)) missing.set(worker.sessionId, worker.file);
		feed = new LiveFeed(reader);
		await feed.restore({ ...cut, workers: cut.workers.filter(worker => !missing.has(worker.sessionId)) });
	}
	for (const observation of state.observations) feed.observe(observation);
	const known = new Map(feed.byRef), newRefs = new Set(op.refs);
	if (op.trigger) { known.set(op.trigger.ref, op.trigger); newRefs.add(op.trigger.ref); }
	for (const ref of feed.byRef.keys()) if (ref.startsWith(`mom-${op.job}:`)) newRefs.add(ref);
	return { store, state, feed, known, newRefs, missing };
}
function world(op: OperationHeader): Promise<World> {
	const key = `${op.job}:${op.step}`;
	let found = worlds.get(key);
	if (!found) {
		found = rebuild(op);
		worlds.set(key, found);
		found.catch(() => worlds.delete(key));
		while (worlds.size > 8) worlds.delete(worlds.keys().next().value!);
	}
	return found;
}

/** Its results are evidence it must read whole: Durable's 50 KB default would cut a digest (a JSON document) mid-string. */
const WHOLE = { maxBytes: 16 * 1024 * 1024, maxLines: 1_000_000 };
const text = (value: string) => [{ type: "text" as const, text: value }];

export default function mom(durable: typeof Durable): Durable.Extension {
	type Progress = { inspected: string[]; auditReads: string[]; rejections: number; repaired: boolean };
	const Progress = durable.defineDocFamily<Progress, null>({
		kind: "pi-tether.mom-operation", version: 1, family: true, scope: "conversation", history: "latest", fork: "initial",
		initial: () => ({ inspected: [], auditReads: [], rejections: 0, repaired: false }) });

	const engine: Engine = { durable, docs: docsFor(durable) };
	/**
	 * The operation this call belongs to and its tool calls: its slice's open operation (from its document,
	 * calls since it started), or a child step's (the header of its context's first message).
	 */
	type Call = { id: string; name: string; arguments: unknown; round: string };
	async function operationContext(api: Durable.ToolExecutionApi, ctx: any): Promise<{ header: OperationHeader; calls: Call[]; slice: boolean }> {
		const op = await readOperation(engine, api, ctx);
		const own = op.status === "open" && op.header && op.startEntry !== undefined ? op : undefined;
		const found = await api.commit(async tx => {
			const marker = own ? undefined : await tx.latestHeadMarker(api.conversationId);
			const min = own ? own.startEntry : marker?.head;
			let oldest: string | undefined, cursor: any;
			const calls: Call[] = [];
			do {
				const page = await tx.scanEntries({ conversationId: api.conversationId, ...(min !== undefined ? { minEntryId: min as any } : {}) }, 200, cursor);
				for (const entry of page.items) for (const message of entry.model ?? []) {
					if (message.role === "user") oldest = textOf(message.content, "");
					if (message.role === "assistant") for (const block of [...message.content].reverse()) if (block.type === "toolCall") calls.unshift({ id: block.id, name: block.name, arguments: block.arguments, round: String(entry.id) });
				}
				cursor = page.next;
			} while (cursor);
			return { oldest, calls };
		}, ctx);
		const header = own?.header ?? (found.oldest ? decodeOperation(found.oldest).header : undefined);
		if (!header) throw new Error("No Path operation is open: call mom_begin first.");
		return { header, calls: found.calls, slice: Boolean(own) };
	}
	const operation = async (api: Durable.ToolExecutionApi, ctx: any) => (await operationContext(api, ctx)).header;
	/** A finalizer must be a sole direct call: batched with others, every call of that round refuses and the operation ends. */
	const batched = (calls: Call[], callId: string) => {
		const round = calls.find(call => call.id === callId)?.round;
		const together = calls.filter(call => call.round === round);
		return together.length > 1 && together.some(call => FINALIZERS.has(call.name));
	};
	const progress = (api: Durable.ToolExecutionApi, ctx: any, job: string) => api.snapshot(Progress, api.conversationId, job, ctx).then(doc => doc ?? { inspected: [], auditReads: [], rejections: 0, repaired: false });
	const update = (api: Durable.ToolExecutionApi, ctx: any, job: string, change: (doc: Progress) => void) =>
		api.commit(async tx => { change(await tx.doc(Progress, api.conversationId, job, null)); }, ctx);

	/** A private tool: errors of Path's own tooling end the operation with a marked result the lead reads. */
	const tool = (definition: { name: string; description: string; parameters: any; constrainedSampling?: any },
		run: (args: any, op: OperationHeader, api: Durable.ToolExecutionApi, ctx: any) => Promise<Durable.ToolExecutionResult>) => durable.defineTool({
		...definition, replay: "safe", executionMode: "sequential", outputLimits: WHOLE,
		async execute(args: any, api: Durable.ToolExecutionApi, ctx: any) {
			try {
				if (FINALIZERS.has(definition.name) && api.callId.includes(":")) throw new Error(SOLE);
				const { header, calls } = await operationContext(api, ctx);
				if (batched(calls, api.callId)) throw new Error(SOLE);
				return await run(args, header, api, ctx);
			} catch (error) {
				const message = errorMessage(error);
				await failed(engine, api, ctx, message).catch(() => {});
				return { content: text(`${OPERATION_FAILED}${message}`), isError: true, control: { terminate: true } };
			}
		},
	});

	const read = async (feed: LiveFeed, ref: string, offset: number, limit: number, strict: boolean) => {
		try { return await feed.lookup(ref, offset, limit); }
		catch (error) {
			if (strict && !(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			return { ref, error: String(error), instruction: "Continue with available evidence; this read did not verify the source." };
		}
	};

	const definitions = momTools();
	const definition = (name: string) => { const found = definitions.find(d => d.name === name)!; return { name, description: found.description, parameters: found.parameters, constrainedSampling: found.constrainedSampling }; };

	/**
	 * Finalizers check their own arguments, so a malformed call counts as an attempt: Durable would answer it
	 * without running the tool. After one repair (a second failed finalization) the operation ends.
	 */
const clip = (text: string, max: number): string => clipText(text, max, { ellipsis: "" });
/** Newest evidence a node cites, so focus lands on the work the user asked for most recently. */
const sourceAt = (node: GraphNode, known: ReadonlyMap<string, FeedEvent>): number => Math.max(...node.sources.map(ref => {
	const at = known.get(ref)?.at;
	return at ? Date.parse(at) : Number.NEGATIVE_INFINITY;
}));
const labelsDefinition = { name: "commit_labels", description: "Repair saved work labels and retire work that is not durable, multi-turn tracking. Supply every saved work ID: a label to keep it, or retired with a reason to drop it. The host preserves sources and evidence.",
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		parameters: Type.Object({ labels: Type.Array(Type.Object({ id: Type.String({ minLength: 1 }), label: Type.String({ minLength: 1, maxLength: 160 }),
			state: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("parked")])) }, { additionalProperties: false }), { maxItems: 64 }),
			retired: Type.Optional(Type.Array(Type.Object({ id: Type.String({ minLength: 1 }), reason: Type.String({ minLength: 1, maxLength: 240 }) }, { additionalProperties: false }), { maxItems: 64 })) }, { additionalProperties: false }) };
	/** Normalize transport-only JSON strings before Pi validates any finalizer's arguments. The trail's
	 *  lists are decoded here because decodeLists belongs to the graph contract. */
	const listArgs = (args: unknown) => {
		if (!isRecord(args)) return args ?? {};
		const out = decodeLists(args);
		for (const field of ["waypoints", "titles", "revise"]) out[field] = decodeJsonList(out[field], { allowNull: false });
		return out;
	};
	/** The tool definition pi-ai validates a finalizer's arguments against. */
	const finalizerDefinition = (name: string) => name === "commit_labels" ? labelsDefinition : name === "commit_v2" ? commitV2Tool() : name === "record_waypoints" ? recordWaypointsTool() : definition(name);
	/** Arguments as Durable checks and coerces them (pi-ai's validation); throws its "Validation failed" error. */
	const check = (name: string, args: unknown) => validateToolArguments({ ...finalizerDefinition(name) } as any,
		{ type: "toolCall", id: "check", name, arguments: JSON.parse(JSON.stringify(listArgs(args))) });
	/** A retried skipped range: what its map record says about the gap once this finalizer accepts. Shared
	 *  by every form so the trail's coverage cursor resolves gaps exactly as the graph forms do. */
	const gapChange = (op: OperationHeader, state: World["state"], feed: LiveFeed): Record<string, unknown> => {
		if (!op.retryGap) return {};
		const retried = state.gaps.find(gap => gap.id === op.retryGap!.id);
		const range = (refs: string[]) => {
			const events = refs.map(ref => feed.byRef.get(ref));
			if (!events.length || events.some(event => !event)) throw new Error(UNREADABLE_SOURCES);
			return { firstRef: events[0]!.ref, lastRef: events.at(-1)!.ref, count: events.length };
		};
		return op.retryGap.remaining.length && retried ? { gap: { action: "open", ...retried, ...range(op.retryGap.remaining) } } : { gap: { action: "resolved", id: op.retryGap.id } };
	};
	type Form = "transaction" | "v2" | "labels" | "trail";
	const FORM_FINALIZER: Record<Form, string> = { transaction: "commit_graph", v2: "commit_v2", labels: "commit_labels", trail: "record_waypoints" };
	// Transaction commits a model-authored graph; acts derives work from model-written labels;
	// relabels apply model-written display labels. All three use the same single-writer commit tail.
	// Trail appends waypoints to `session.trail` and only its coverage cursor to `.mom`.
	const finalize = (form: Form = "transaction") => ({ ...tool(finalizerDefinition(FORM_FINALIZER[form]), async (_args, op, api, ctx) => {
		const { calls } = await operationContext(api, ctx);
		const call = calls.find(each => each.id === api.callId);
		const attempts = calls.filter(each => FINALIZERS.has(each.name)).length;
		const reject = async (reason: string) => {
			if (attempts >= 2) await rejected(engine, api, ctx, op, `Path could not finalize after one repair. ${reason}`);
			return { content: text(attempts >= 2 ? `Path could not finalize after one repair. ${reason} No map was accepted.` : `${reason} Correct all reported defects and resubmit once.`),
				isError: true, ...(attempts >= 2 ? { control: { terminate: true as const } } : {}) };
		};
		const { store, state, known, newRefs, feed } = await world(op);
		// A mode is in force or loudly refused (docs/map-modes.md, M2). Every finalizer is always
		// registered because the extension is built statically, so each one must refuse work the
		// active mode did not ask it to do — otherwise a small model can reach for commit_graph in v2
		// and author edits the host is supposed to check against the minimal schema.
		const active = modeFor(op.mapMode ?? state.mode);
		// A trail relabel is a titling pass: it finishes with record_waypoints like any trail operation.
		const labels = op.relabel && active.name !== "trail";
		if (labels ? form !== "labels" : active.finalizer !== FORM_FINALIZER[form])
			return await reject(`This operation requires ${labels ? "commit_labels" : active.finalizer}.`);
		// The decider every semantic gate asks, from the same settings line `begin` read.
		const agent = await api.agent(ctx);
		const settings = readInstructionSettings(agent.instructions);
		const classifier = settings.classifier ? new Beverly(settings.classifier) : undefined;
		const records = await new SidecarStore(() => op.session.file, op.session.id).load();
		if (records.some(record => record.id === `${op.job}:map`)) return { content: text(form === "trail" ? "Trail saved." : "Map saved."), control: { terminate: true } };
		if (form === "trail") {
			// The trail keeps no graph: waypoints are appended to `session.trail`, and the `.mom` record
			// is the coverage-without-a-map cursor, marked `trail: true` by the store. The trail is its own
			// coverage track: loadState ignores graph checkpoints in trail mode, so there is never one here
			// (base null) and a session switched from a graph mode indexes its whole history into the trail.
			const value = listArgs(call?.arguments ?? _args) as Record<string, unknown>;
			const repairs: string[] = [];
			// Near-miss refs are canonicalized before validation, as the graph forms do; a ref that matches
			// nothing is left for validation to name.
			if (Array.isArray(value.waypoints)) value.waypoints = value.waypoints.map(item => !item || typeof item !== "object" || !Array.isArray((item as any).refs) ? item
				: { ...item, refs: (item as { refs: unknown[] }).refs.map(ref => {
					if (typeof ref !== "string" || known.has(ref)) return ref;
					const to = sourceSuggestion(ref, known.keys());
					if (to) repairs.push(`${ref}→${to}`);
					return to ?? ref;
				}) });
			const trailStore = new TrailStore(() => op.session.file, op.session.id);
			const branch = branchIds(sessionFromFile(op.session.file, op.session.leaf));
			const existing = trailFor(await trailStore.load(), branch);
			const idFor = (index: number) => `${op.job}:w${index}`;
			const { inputs, titles, defects } = validateWaypointInputs(value, trailEntries(existing), new Set(known.keys()), idFor);
			// A repair pass revises the trail it was shown (src/trail/repair.ts); no other operation may.
			const revisions = Array.isArray(value.revise) ? value.revise as Revision[] : [];
			if (revisions.length && !op.repair) defects.push("revise is only for a repair pass; leave it out.");
			const repair = op.repair ? planRepair(existing, revisions, index => `${op.job}:r${index}`) : undefined;
			if (repair) defects.push(...repair.defects);
			if (defects.length) {
				await update(api, ctx, op.job, doc => { doc.rejections++; });
				return await reject(`Waypoints rejected; nothing was saved. ${defects.join(" ")}`);
			}
			// Waypoints are where the user steered; the rest are steps for the detail page (sortTiers). Ids keep the
			// call index so a retry writes the same ones.
			const isUserTurn = (ref: string) => { const event = known.get(ref); return Boolean(event && isUserDirection(event)); };
			const tiers = sortTiers(inputs, idFor, isUserTurn);
			// Re-indexing the same history (a retried backfill, a session switched between modes) never writes a moment
			// twice: an item of the same kind citing a source the trail already holds is that entry. Links to it follow.
			const held = trailEntries(existing), alias = new Map<string, string>();
			inputs.forEach((input, index) => {
				const same = held.find(entry => entry.kind === input.kind && entry.refs.some(ref => input.refs.includes(ref)));
				if (same) alias.set(idFor(index), same.id);
			});
			const relink = (id: string | null | undefined) => id == null ? undefined : alias.get(id) ?? id;
			// Where it sits in the transcript: the user turn it cites, else its first lead source, else the batch's.
			const leadEntry = (ref: string) => { const parsed = parseRef(ref); return parsed?.stream === op.session.id ? parsed.entryId : undefined; };
			const anchorOf = (refs: readonly string[]) => {
				const ref = refs.find(isUserTurn) ?? refs.find(r => leadEntry(r)) ?? op.refs.find(r => leadEntry(r));
				return ref ? leadEntry(ref) : undefined;
			};
			// When it happened, not when it was indexed: backfilled history keeps its own times.
			const recorded = Date.now(), atOf = (refs: readonly string[]) => {
				const time = Date.parse(known.get(refs.find(isUserTurn) ?? refs[0]!)?.at ?? "");
				return Number.isFinite(time) ? time : recorded;
			};
			const all = [...tiers.waypoints.map(item => ({ ...item, step: false })), ...tiers.steps.map(item => ({ ...item, step: true }))]
				.filter(item => !alias.has(idFor(item.index))).sort((a, b) => a.index - b.index);
			for (const { index, input, step } of all) {
				const closes = relink(input.closes), supersedes = relink(input.supersedes), from = relink(input.from), anchor = anchorOf(input.refs);
				const waypoint: Waypoint = { id: idFor(index), sessionId: op.session.id, at: atOf(input.refs), kind: input.kind, line: input.line, refs: input.refs, caption: input.caption,
					...(input.title ? { title: input.title } : {}), ...(from ? { from } : {}),
					...(closes ? { closes } : {}), ...(supersedes ? { supersedes } : {}), ...(anchor ? { anchor } : {}), parent: op.session.leaf, by: "mom",
					...(step && !STEP_KINDS.has(input.kind) ? { step: true as const } : {}) };
				await trailStore.appendWaypoint(waypoint);
			}
			// Titles for waypoints recorded before titles existed; ids keep the call index, so a retry writes them once.
			for (const [index, item] of [...titles, ...(repair?.titles ?? [])].entries())
				await trailStore.appendTitle({ id: `${op.job}:t${index}`, sessionId: op.session.id, at: recorded, target: item.id, title: item.title, parent: op.session.leaf });
			// A repair's revised copies first, then the strikes of what they replace: a crash between leaves both, never neither.
			for (const copy of repair?.copies ?? []) await trailStore.appendWaypoint({ ...copy, parent: copy.parent ?? op.session.leaf });
			for (const [index, item] of (repair?.strikes ?? []).entries())
				await trailStore.appendStrike({ id: `${op.job}:s${index}`, sessionId: op.session.id, at: recorded, target: item.target, reason: item.reason, parent: op.session.leaf });
			// Written after the waypoints: a crash between the two leaves the batch uncovered and retried, and
			// the retry's ids are the same `${job}:w<n>`, so a reader sees the waypoints once.
			try { await store.append("map", { base: state.checkpointId ?? null, cut: op.cut!, failure: null, ...gapChange(op, state, feed), ...(op.backfill !== undefined ? { backfill: op.backfill } : {}) }, `${op.job}:map`); }
			catch (error) { throw new Error(`Path could not advance its trail coverage beside the session: ${String(error)}`); }
			worlds.delete(`${op.job}:${op.step}`);
			await accepted(engine, api, ctx, op);
			const demoted = tiers.steps.filter(item => !STEP_KINDS.has(item.input.kind)).length;
			return { content: text(`Trail saved.${alias.size ? ` ${alias.size} already on the trail, not repeated.` : ""}${demoted ? ` Filed ${demoted} as step${demoted === 1 ? "" : "s"}: a waypoint must cite the user turn that made it.` : ""}${repairs.length ? ` Repaired refs: ${repairs.join(", ")}.` : ""}`), control: { terminate: true } };
		}
		const done = await progress(api, ctx, op.job);
		const inspected = new Set([...done.inspected, ...[...feed.byRef.keys()].filter(ref => ref.startsWith(`mom-${op.job}:`))]);
		const graph = state.checkpoint?.graph ?? emptyGraph();
		const unresolved = new Set(state.unresolvedNotices);
		if (state.checkpoint?.note) unresolved.add(noticeKey(state.checkpoint.note));
		let next;
		let unmet: string[] | undefined;
		try {
			if (form === "labels") {
				const payload = check("commit_labels", call?.arguments ?? _args) as { labels: { id: string; label: string; state?: "active" | "parked" }[]; retired?: { id: string; reason: string }[] };
				const work = graph.nodes.filter(isEndeavor), byId = new Map(payload.labels.map(item => [item.id, { label: item.label.trim(), state: item.state }]));
				const retired = new Map((payload.retired ?? []).map(item => [item.id, item.reason.trim()]));
				const decided = new Set([...byId.keys(), ...retired.keys()]);
				const unknown = [...decided].filter(id => !work.some(node => node.id === id));
				if (unknown.length || decided.size !== byId.size + retired.size)
					throw new Error(`Unknown or repeated work ID: ${unknown.join(", ") || [...decided].join(", ")}. Supply each work ID at most once, either with a label or as retired.`);
				const dropped = new Set(retired.keys());
				// A repair fixes labels that describe the conversation, never labels that describe the work:
				// a model rewriting good history is how "Review pi-delegate and pi-tether…" became "Check
				// compilation". The decider judges both the saved label (a conversational wrapper?) and the
				// proposed one (does it name this work at all?) — the old guards were word lists.
				const settled = work.filter(node => dropped.has(node.id) && node.state === "settled").map(node => node.id);
				if (settled.length) throw new Error(`Finished records are not retirable: ${settled.join(", ")}. Give each a label instead.`);
				if (!classifier && work.some(node => { const wanted = byId.get(node.id); return wanted && wanted.label !== node.label; }))
					throw new Error("The Path decider (decision model) is not configured; labels cannot be repaired without it.");
				for (const node of work) {
					const wanted = byId.get(node.id);
					if (!wanted || wanted.label === node.label) continue;
					const verdict = await classifier!.work({ state: node.state, label: node.label, intent: node.intent, observed: node.observed, proposed: wanted.label });
					if (!verdict.wrapper_label) throw new Error(`${node.id} keeps its saved label ${JSON.stringify(node.label)}: it describes the work, not the conversation.`);
					if (node.intent?.trim() && !verdict.names_work)
						throw new Error(`${node.id}: label ${JSON.stringify(wanted.label)} names nothing in this work's intent. Write a label that describes it.`);
				}
				// Retiring is structural too: never a node whose unfinished work would be orphaned, and the
					// retired node's own quote survives as evidence on its surviving parent.
				for (const node of work) if (dropped.has(node.id)) {
					const orphan = graph.nodes.find(child => child.parent === node.id && isEndeavor(child) && child.state !== "settled" && !dropped.has(child.id));
					if (orphan) throw new Error(`${node.id} still holds unfinished work ${orphan.id}; finish or reparent it first.`);
				}
				const landing = new Map<string, string | null>();
				for (const node of work) if (dropped.has(node.id)) landing.set(node.id, node.parent);
				const nodes: GraphNode[] = [];
				for (const node of graph.nodes) {
					if (dropped.has(node.id)) {
						const quote = clip(node.intent || node.label, 1200);
						if (quote) nodes.push({ ...node, parent: landing.get(node.id) ?? null, kind: "observation", state: "active",
							label: clip(quote, 160), observed: clip(quote, 2400) });
						continue;
					}
					const parent = node.parent && dropped.has(node.parent) ? landing.get(node.parent) ?? null : node.parent;
					const wanted = byId.get(node.id);
					nodes.push({ ...node, parent, ...(isEndeavor(node) && wanted ? { label: wanted.label } : {}),
						...(isEndeavor(node) && wanted?.state && wanted.state !== node.state ? { state: wanted.state } : {}) });
				}
				// A retired node must not leave focus on nothing: hand it to the latest-sourced unfinished
					// work, which is the work the user actually asked for, and unpark it — a junk node that
					// stole focus had parked the real one. No other node's state changes: the retired node
					// displaced nothing, so parking a sibling would be a fresh error.
				let focus = graph.focus;
				if (focus && dropped.has(focus)) {
					const latest = [...nodes].filter(node => isEndeavor(node) && ["active", "parked"].includes(node.state))
						.sort((a, b) => sourceAt(b, known) - sourceAt(a, known) || a.id.localeCompare(b.id))[0];
					focus = latest?.id ?? landing.get(focus) ?? graph.purpose ?? null;
					const target = focus ? nodes.find(node => node.id === focus) : undefined;
					if (target && isEndeavor(target) && target.state === "parked") nodes[nodes.indexOf(target)] = { ...target, state: "active" };
				}
				// You cannot be working on a child of deferred work: whatever holds the current focus is in
					// progress. Structure, not a model judgment — a parked umbrella above active work is a map error.
				for (let ancestor = focus ? nodes.find(node => node.id === focus)?.parent ?? null : null; ancestor;) {
					const node = nodes.find(each => each.id === ancestor);
					if (!node) break;
					if (isEndeavor(node) && node.state === "parked") nodes[nodes.indexOf(node)] = { ...node, state: "active" };
					ancestor = node.parent;
				}
				const updated = editGraph(graph, graph.revision, nodes.map(node => ({ op: "put_node" as const, node })),
					graph.purpose, focus, new Set(known.keys()), state.checkpointId);
				const labels = new Map(updated.nodes.map(node => [node.id, node.label]));
				next = { graph: updated, note: null, resolutions: [], repairs: [], unfinished: (state.checkpoint?.unfinished ?? [])
					.filter(item => !dropped.has(item.node)).map(item => ({ ...item, label: labels.get(item.node) ?? item.label })) };
			} else if (form === "v2") {
				// The model edited the minimal map directly; the mode's apply checks structure and stores it.
				const derived = await V2_MODE.apply!({ prior: graph, committed: call?.arguments ?? _args, known, ...(op.spec ? { spec: op.spec } : {}) });
				if (derived.declined.length) throw new Error(derived.declined.join(" "));
				unmet = derived.unmet;
				next = { graph: derived.graph, note: null, resolutions: [], repairs: [], unfinished: [] };
			} else {
				const args = check("commit_graph", call?.arguments ?? _args);
				// acceptGraph rejects an empty commit on a cold graph.
				next = acceptGraph(args, graph, state.checkpointId, known, newRefs, inspected, Boolean(op.trigger), unresolved);
			}
			// A graph-identical commit closes nothing: it keeps the saved unfinished declarations rather than clearing them.
			if (state.checkpoint && JSON.stringify(next.graph) === JSON.stringify(graph)) {
				next = { ...next, unfinished: state.checkpoint.unfinished ?? [] };
				if (op.leadUnreadable && !next.note && !next.resolutions.length) throw new Error("A commit that changes nothing cannot certify unreadable lead evidence.");
			}
		} catch (error) {
			await update(api, ctx, op.job, doc => { doc.rejections++; });
			return await reject(`Graph transaction rejected; last checkpoint unchanged. ${String(error)}`);
		}
		// A graph-identical acceptance still advances durable evidence coverage: a cursor record over the latest full checkpoint.
		const resolutionKeys = new Set(next.resolutions.map(item => `${item.riskClass}:${item.target}`));
		const pendingNotice = state.checkpoint?.note && !resolutionKeys.has(noticeKey(state.checkpoint.note)) ? state.checkpoint.note : null;
		// Advice stays on Path's surface. Delivery never adds it to lead context.
		const effectiveNote = next.note ? { ...next.note, nextRequest: true } : pendingNotice;
		const material = !state.checkpoint || JSON.stringify(next.graph) !== JSON.stringify(graph)
			|| JSON.stringify(effectiveNote) !== JSON.stringify(state.checkpoint.note ?? null)
			|| JSON.stringify(next.unfinished) !== JSON.stringify(state.checkpoint.unfinished ?? []);
		const gapUpdate = gapChange(op, state, feed);
		const resolutionUpdate = { ...(resolutionKeys.size ? { resolvedNotices: [...resolutionKeys] } : {}), ...(op.auditedGaps?.length ? { resolvedGaps: op.auditedGaps } : {}) };
		const cut = op.cut!, at = Date.now();
		const write = async (data: Record<string, unknown>, failure: string) => {
			try { await store.append("map", data, `${op.job}:map`); } catch (error) { throw new Error(`${failure}: ${String(error)}`); }
		};
		{
			if (material) {
				const checkpoint: Checkpoint = { sessionId: op.session.id, graph: next.graph, change: graphChange(state.checkpoint?.graph ?? emptyGraph(), next.graph),
					note: effectiveNote, unfinished: next.unfinished, cut, at, model: agent.model ? `${agent.model.provider}/${agent.model.modelId}` : "" };
				if (!isCheckpoint(checkpoint)) return await reject("Host-derived checkpoint is invalid; last checkpoint unchanged.");
				// Another finalizer may have saved a map since this one began. Re-read just before appending: a map built
				// from an older checkpoint would otherwise replace the newer one without a trace. The operation fails and retries.
				store.invalidate?.();
				const current = await loadState(store, sessionFromFile(op.session.file, op.session.leaf), { mode: op.mapMode });
				if ((current.checkpointId ?? null) !== (state.checkpointId ?? null)) throw new Error("Its saved map changed while it worked on this update, so it was not saved; the update is retried from the current map.");
				await write({ snapshot: checkpoint, base: state.checkpointId ?? null, failure: null, ...gapUpdate, ...resolutionUpdate, ...(op.screen ? { screen: op.screen } : {}) }, "Path could not write its state beside the session");
			} else {
				if (!state.checkpointId) throw new Error("Path cannot advance evidence coverage without a saved sidecar checkpoint.");
				await write({ base: state.checkpointId, cut, failure: null, ...gapUpdate, ...resolutionUpdate, ...(op.screen ? { screen: op.screen } : {}) }, "Path could not advance its state beside the session");
			}
		}
		worlds.delete(`${op.job}:${op.step}`);
		await accepted(engine, api, ctx, op, unmet?.length ? { unmet } : undefined);
		return { content: text("Map saved."), control: { terminate: true } };
	}), prepareArguments: (args: unknown) => { try { return check(FORM_FINALIZER[form], args) as any; } catch { return {} as any; } } });

	const inspect = tool({ ...definition("inspect_evidence") }, async (args, op, api, ctx) => {
		const { feed, known, missing, state } = await world(op);
		if (typeof args.ref !== "string" || !Number.isSafeInteger(args.offset) || args.offset < 0 || !Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 24000) throw new Error("Invalid evidence request.");
		// A trail waypoint id (bare, or written node:<id> as the graph's references are) is Path's own saved note.
		if (op.mapMode === "trail" && !known.has(args.ref)) {
			const id = args.ref.startsWith("node:") ? args.ref.slice(5) : args.ref;
			const waypoint = (await new TrailStore(() => op.session.file, op.session.id).load()).find(record => record.type === "waypoint" && record.id === id);
			if (waypoint || args.ref.startsWith("node:")) return { content: text(JSON.stringify(waypoint
				? { ref: args.ref, authority: "Saved trail entry, not original evidence. Cite its refs, never this id.", waypoint }
				: { ref: args.ref, error: `No trail entry ${id}.`, instruction: "Trail entries are linked through closes and supersedes by id; they are not evidence. Inspect [src:…] ids only." })),
				...(waypoint ? {} : { isError: true }) };
		}
		if (args.ref.startsWith("node:") && op.mode !== "audit") {
			const node = state.checkpoint?.graph.nodes.find(node => node.id === args.ref.slice(5));
			// A wrong reference is the model's to correct, not a reason to fail the whole operation.
			if (!node) return { content: text(JSON.stringify({ ref: args.ref, error: `Unknown saved node: ${args.ref}`, instruction: "Inspect a node id from the map you were shown, or an [src:…] evidence id." })), isError: true };
			const value = JSON.stringify(node);
			return { content: text(JSON.stringify({ ref: args.ref, authority: "Saved interpretation, not original evidence. Cite its sources, not this node reference.",
				offset: args.offset, totalChars: value.length, nextOffset: args.offset + args.limit < value.length ? args.offset + args.limit : null,
				text: value.slice(args.offset, args.offset + args.limit) })) };
		}
		if (op.section?.sources?.[args.ref]) args = { ...args, ref: op.section.sources[args.ref] };
		const gone = typeof args.ref === "string" && !known.has(args.ref) ? missing.get(parseRef(args.ref)?.stream ?? "") : undefined;
		if (gone) return { content: text(JSON.stringify({ ref: args.ref, error: `Error: ENOENT: no such file or directory, open '${gone}'`,
			instruction: "The original file is unavailable. Continue with supplied evidence; do not infer unseen contents or repeat this read." })), isError: op.mode === "audit" };
		const done = await progress(api, ctx, op.job);
		if (op.mode === "audit") {
			const ref = known.has(args.ref) ? args.ref : sourceSuggestion(args.ref, known.keys()) ?? args.ref;
			if (!known.has(ref)) {
				const error = `Unknown source: ${args.ref}. Copy an exact source pointer from the supplied evidence (session-id:entry-id, with any block suffix). A session ID alone is not a source. Do not invent an entry ID.`;
				if (done.repaired) throw new Error(error);
				await update(api, ctx, op.job, doc => { doc.repaired = true; });
				return { content: text(error), isError: true };
			}
			const key = JSON.stringify([ref, args.offset, args.limit]);
			if (done.auditReads.includes(key)) throw new Error("Thread-map audit repeated an evidence page.");
			await update(api, ctx, op.job, doc => { doc.auditReads.push(key); });
			try { return { content: text(JSON.stringify({ ...await feed.lookup(ref, args.offset, args.limit), pairedRef: feed.pairedSource(ref) })) }; }
			catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
				return { content: text(JSON.stringify({ ref, error: String(error), instruction: "The original file is unavailable. Continue with supplied evidence; do not infer unseen contents or repeat this read." })), isError: true };
			}
		}
		const strict = Boolean(op.trigger);
		let ref = args.ref;
		if (strict) {
			ref = feed.byRef.has(ref) ? ref : sourceSuggestion(ref, feed.byRef.keys()) ?? ref;
			const key = JSON.stringify([ref, args.offset, args.limit]);
			if (done.auditReads.includes(key)) throw new Error("Thread-map reconciliation repeated an evidence page.");
			await update(api, ctx, op.job, doc => { doc.auditReads.push(key); });
		}
		const paired = feed.pairedSource(ref);
		// Either entry point supplies the pair within one page's character budget.
		const companion = paired && !done.inspected.includes(paired) && args.limit > 1 ? await read(feed, paired, 0, Math.floor(args.limit / 2), strict) : undefined;
		const available = args.limit - (companion && "text" in companion ? companion.text.length : 0);
		const results = [await read(feed, ref, args.offset, available, strict)];
		if (companion) results.push(companion);
		const read_ = results.filter(result => !("error" in result)).map(result => result.ref);
		await update(api, ctx, op.job, doc => { for (const r of read_) if (!doc.inspected.includes(r)) doc.inspected.push(r); });
		return { content: text(JSON.stringify({ results })) };
	});

	const search = tool(definition("search_history"), async (args, op, _api, ctx) => {
		const { feed } = await world(op);
		const query = validateSearchQuery(args.query);
		return { content: text(JSON.stringify({ ...await feed.search(query, AbortSignal.any([AbortSignal.timeout(120000), ...(ctx?.abortSignal ? [ctx.abortSignal] : [])])), limit: 5 })) };
	});

	const recordDefinition = { name: "record_thread_map", description: "Return exactly one source-backed chapter state for this section of the independent thread map.",
		constrainedSampling: { type: "json_schema", strict: "prefer" }, parameters: Type.Object({ states: Type.Array(chapterState) }, { additionalProperties: false }) };
	const placeholder = { states: [{ chapter: "", goal: [], decisions: [], artifacts: [], deadEnds: [], openQuestions: [] }] };
	const record = { ...tool(recordDefinition, async (_args, op, api, ctx) => {
		if (op.mode !== "audit" || !op.section) throw new Error("record_thread_map belongs to a thread-map audit step.");
		const { calls } = await operationContext(api, ctx);
		let args: any;
		try { args = validateToolArguments(recordDefinition as any, { type: "toolCall", id: "check", name: "record_thread_map", arguments: JSON.parse(JSON.stringify(listArgs(calls.find(call => call.id === api.callId)?.arguments ?? _args))) }); }
		catch (error) {
			if (calls.filter(call => FINALIZERS.has(call.name)).length >= 2) throw new Error(`Path could not finalize after one repair. ${errorMessage(error)}`);
			return { content: text(`${errorMessage(error)} Correct all reported defects and resubmit once.`), isError: true };
		}
		const { known, feed } = await world(op);
		const canonical = (ref: string) => {
			ref = op.section?.sources?.[ref] ?? ref;
			const observed = feed.byRef.get(ref);
			if (observed?.actor === "mom") known.set(ref, observed);
			return known.has(ref) ? ref : sourceSuggestion(ref, known.keys()) ?? ref;
		};
		const map = args as Static<typeof threadMap>;
		const sourceMetadata: Record<string, Pick<FeedEvent, "at" | "actor" | "kind">> = {};
		const errors: string[] = [];
		if (!Check(threadMap, map)) errors.push("Invalid thread-map chapter state.");
		else {
			const ids = op.section.chapterIds;
			if (map.states.length !== ids.length || ids.some(id => !map.states.some(s => s.chapter === id))) errors.push("Thread-map audit omitted or duplicated a chapter.");
			for (const state of map.states) for (const field of ITEM_FIELDS) for (const entry of state[field]) {
				entry.sources = entry.sources.map(canonical);
				for (const ref of entry.sources) {
					const event = known.get(ref);
					if (!event) errors.push(`Unknown source: ${ref}.`);
					else sourceMetadata[ref] = { at: event.at, actor: event.actor, kind: event.kind };
				}
				if (entry.sources.length && entry.sources.every(ref => known.get(ref)?.kind === "compaction")) errors.push(`Summary-only claim on ${entry.sources.join(", ")}: ${entry.text}`);
			}
		}
		const done = await progress(api, ctx, op.job);
		if (errors.length && !done.repaired) {
			await update(api, ctx, op.job, doc => { doc.repaired = true; });
			return { content: text(`${errors.join("\n")} Inspect original evidence if needed, then resubmit once. Copy source IDs exactly. Every item needs a non-summary source; omit unsupported assertions rather than treating summary claims as facts.`), isError: true };
		}
		if (errors.length) {
			if (errors.some(error => /^(Invalid thread-map|Thread-map audit omitted)/.test(error))) throw new Error(`Thread-map audit rejected; saved map retained. ${errors.join("\n")}`);
			for (const state of map.states) for (const field of ITEM_FIELDS) state[field] = state[field]
				.map(entry => ({ ...entry, sources: entry.sources.filter(ref => known.has(ref)) }))
				.filter(entry => entry.sources.some(ref => known.get(ref)?.kind !== "compaction"));
		}
		return { content: text(`Chapter state recorded.\n${JSON.stringify({ actor: op.section.actor, sourceMetadata, ...map })}`), control: { terminate: true } };
	}), prepareArguments: (args: unknown) => { try { return validateToolArguments(recordDefinition as any,
		{ type: "toolCall", id: "check", name: "record_thread_map", arguments: JSON.parse(JSON.stringify(listArgs(args))) }) as any; } catch { return placeholder as any; } } };

	/** `mom_begin`: every operation starts here, as a sole call. */
	const beginTool = durable.defineTool({ name: BEGIN, replay: "safe", executionMode: "sequential", outputLimits: WHOLE,
		description: "Start the operation this message asks for: it reads the new lead activity or the request, settles your previous operation, and returns the evidence to review (or says there is nothing to do). Call it first, alone, once per message.",
		parameters: Type.Object({}, { additionalProperties: false }) as any,
		execute: (_args: unknown, api: Durable.ToolExecutionApi, ctx: any) => begin(engine, api, ctx) });

	/**
	 * The model sees only the current operation: messages from its start (its slice keeps earlier ones in
	 * storage), with a delivery or request shown as a short prompt and a step's header removed.
	 */
	const prompt = (text: string) => {
		const start = decodeStart(text);
		if (start?.kind === "delivery") return "The lead's session recorded new activity. Call mom_begin.";
		if (start?.kind === "request") return start.request.kind === "relabel" ? "The user requested a repair of saved work labels. Call mom_begin." : "The user's session sent a request. Call mom_begin.";
		return decodeOperation(text).text;
	};
	const REPAIR_PREFIX = "No finalizer was executed.";
	const repair = (header: OperationHeader) => `${REPAIR_PREFIX} Review the supplied evidence and finish with ${header.relabel && modeFor(header.mapMode).name !== "trail" ? "commit_labels" : modeFor(header.mapMode).finalizer} as a sole direct call. Your previous text did not save any changes.`;
/** Path's own tool surface. A stale or foreign slice configuration must never hand it native
 *  filesystem, shell or editor tools: a small model given those leaves the operation and wanders.
 *  The extension enforces its own boundary rather than trusting the allowlist it was given. */
const MOM_TOOL_NAMES = new Set([BEGIN, "commit_graph", "commit_v2", "commit_labels", "record_thread_map", "record_waypoints", "inspect_evidence", "search_history"]);
	const RELABEL_PROMPT = "You are Path repairing its saved work map, not processing new activity or answering the recorded conversation. First call mom_begin alone. Then read its work list and call commit_labels once. Give a decision only for the work that needs one: a concise, meaningful label to keep it, or retired with a short reason. An ID you leave out keeps its saved label.\n\n\n\nMom tracks only durable, multi-turn things. Retire work that is not: a status or progress question (\"where are we?\", \"is it in place now?\", \"were those labels from act mode or commit mode\"), a one-off meta question, or an instruction the next turn fully satisfied. Keep genuine multi-turn work even when it is phrased as a question (\"What else is fucking idiotic in this stack?\" is a real audit request). Never retire settled work, or work that still holds unfinished work — give those a label instead.\n\n\n\nA kept work item may also carry state: active when it is being worked on now, parked when it is deliberately deferred. Set active for work in progress, including an umbrella initiative whose child is current. Never mark work settled here — a completion needs its own evidence. Base every label on that work's intent and observed outcome; do not copy terminal markup or invent new work. Never call other tools, and never alter IDs, sources, or notes.";

	const hooks = [durable.hook(durable.GenerationTask, {
		async beforeRequest(request, api, ctx) {
			const startAt = request.messages.findLastIndex(message => message.role === "user" && decodeStart(textOf(message.content, "")) !== undefined);
			// System entries (the prompt and the tool list) are positional: keep every one, drop earlier operations.
			const messages = request.messages.filter((message, index) => index >= startAt || !["user", "assistant", "toolResult"].includes(message.role));
			// Whether this operation already had its repair prompt: onYield, in this same generation, reads it.
			await api.memo("mom-repaired", messages.some(message => message.role === "user" && textOf(message.content, "").startsWith(REPAIR_PREFIX)), ctx);
			await api.memo("mom-gave-up", messages.some(message => message.role === "user" && textOf(message.content, "").startsWith(GIVE_UP)), ctx);
			const start = startAt >= 0 ? decodeStart(textOf(request.messages[startAt]!.content, "")) : undefined;
			const operation = await readOperation(engine, api as any, ctx);
			const begun = messages.some(message => message.role === "toolResult" && message.toolName === BEGIN && !message.isError);
			const header = start?.kind === "step" ? start.header : begun && operation.status === "open" ? operation.header : undefined;
			const settings = readInstructionSettings(messages.filter(message => message.role === "system").map(message => textOf(message.content, "")).join("\n"));
			const operationMode = modeFor(header?.mapMode ?? settings.mapMode);
			const givingUp = messages.some(message => message.role === "user" && textOf(message.content, "").startsWith(GIVE_UP));
			const allowed = new Set(!header || givingUp ? [BEGIN] : header.mode === "audit" ? ["record_thread_map", ...(header.section?.needsInspection ? ["inspect_evidence"] : [])]
				// A trail relabel is a titling pass: it finishes with record_waypoints like every trail operation.
				: header.relabel && operationMode.name !== "trail" ? ["commit_labels"]
				// v2 owns every write, catch-up digests included; commit_graph owns its own digest.
				: operationMode.name === "v2" ? ["commit_v2", "inspect_evidence", "search_history"]
				// The trail has no graph: its one finalizer appends waypoints, digests included. It indexes the batch in
				// front of its and never reconciles older history, so it gets no history search: a small model given
				// one fishes with it (dozens of one-word queries per catch-up) instead of reading the evidence.
				: operationMode.name === "trail" ? ["record_waypoints", "inspect_evidence"]
				: ["commit_graph", "inspect_evidence", "search_history"]);
			return { messages: messages.map(message => {
				if (message.role === "system") return { ...message,
					// A graph relabel gets its own instructions; a trail relabel keeps the trail's (it finishes with record_waypoints).
					...(header?.relabel && operationMode.name !== "trail" && message.sections?.instructions ? { sections: { ...message.sections, instructions: RELABEL_PROMPT } } : {}),
					// Path's tools only. A stale slice configuration that carried native read/bash/codemode
					// is corrected here, at the one place every request passes through.
					...(message.toolsAdded ? { toolsAdded: message.toolsAdded.filter(tool => allowed.has(tool.name) && MOM_TOOL_NAMES.has(tool.name)) } : {}) };
				if (message.role !== "user") return message;
				if (typeof message.content === "string") return { ...message, content: prompt(message.content) };
				return { ...message, content: message.content.map((part: any) => part.type === "text" ? { ...part, text: prompt(part.text) } : part) };
			}) };
		},
		/**
		 * An operation that ends without a finalizer gets one repair prompt; an update that ends again without
		 * one is a failed turn, which oven retries.
		 */
		async onYield(_answer, api, ctx) {
			const op = await readOperation(engine, api as any, ctx);
			if (op.status !== "open" || op.header?.mode !== "update") return undefined;
			if (!await api.memo<boolean>("mom-repaired", ctx)) return { continue: repair(op.header) };
			// Ended again without a finalizer: a hook cannot fail the turn, a tool result can. mom_begin fails the operation.
			return await api.memo<boolean>("mom-gave-up", ctx) ? undefined : { continue: GIVE_UP };
		},
		/** An operation its tools ended as failed (a rejection after repair, or its own tooling) fails the turn. */
		async afterTools(_assistant, _results, api, ctx) {
			const op = await readOperation(engine, api as any, ctx);
			if (op.fault) throw new Error(op.fault);
		},
	})];

	// Its operations each start a fresh context (the hook above): summarizing the stored history would only spend model calls.
	hooks.push(durable.hook(durable.CompactionTask, { beforeCompact: () => ({ decline: true as const }) }));

	return durable.defineExtension({
		name: "mom",
		tools: [beginTool, finalize(), finalize("v2"), finalize("labels"), finalize("trail"), inspect, search, record],
		hooks,
	});
}
