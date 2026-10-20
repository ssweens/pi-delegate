import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { scheduler } from "node:timers/promises";
import { makeRef, parseRef } from "../util/ref.ts";
import { oneLine, textOf } from "../util/text.ts";
export interface SessionReader {
	getSessionId(): string;
	getSessionFile(): string | undefined;
	getCwd(): string;
	getLeafId(): string | null;
	getEntry(id: string): Entry | undefined;
	getBranch(): (Entry & { id: string })[];
}
/** The ids on the session's current branch. */
export const branchIds = (reader: Pick<SessionReader, "getBranch">): Set<string> => new Set(reader.getBranch().map(entry => entry.id));

// Raw transcript records are the compatibility boundary (Pi session versions 2 and 3).
export type Entry = Record<string, any>;
export interface FeedEvent {
	ref: string;
	at: string;
	actor: string;
	kind: string;
	text?: string;
	/** Provider-authored compaction summary; labelled as a claim only by bootstrap rendering. */
	claim?: string;
	name?: string;
	callId?: string;
	isError?: boolean;
	status?: string;
	/** A delegate receipt's run segment: a resumed run reports again under a new segment. */
	segment?: number;
	parentRef?: string | null;
	fromRef?: string;
	/** A user-command correction; it is explicit direction and bypasses pre-wake screening. */
	correction?: true;
}
export interface Stream {
	key: string;
	file: string;
	sessionId: string;
	actor: string;
	parent?: string;
	forkedMessages: number;
}
export interface WorkerCursor extends Stream {
	runId: string;
	cwd: string;
	offset: number;
	messages: number;
	lastId: string | null;
	hash: string;
	device: number | null;
	inode: number | null;
}
export interface Cut {
	parent: string | null;
	workers: WorkerCursor[];
}
/** Original Pi tool records observed by Path, scoped to the lead branch that requested them. */
export interface Observation { key: string; parent: string | null; entries: Entry[] }

/** A raw transcript entry with its immutable identity. Path reads these; it never writes them. */
export interface SourceEntryObservation {
	ref: string;
	stream: string;
	actor: string;
	entry: Entry;
}

interface Source {
	entryId: string;
	entry?: Entry;
	stream?: string;
	actor?: string;
	hash: string;
	file?: string;
	offset?: number;
	bytes?: number;
}
interface Reader { cursor: WorkerCursor; hash: Hash; headerSeen: boolean }
export const EMPTY_HASH = createHash("sha256").digest("hex");
export const CORRECTION = "pi-tether.user-correction";
const isCorrection = (e: Entry) => e.type === "custom_message" && e.customType === CORRECTION && e.details?.origin === "user-command";
export const isMomEntry = (e: Entry) => !isCorrection(e) && (e.customType ?? e.message?.customType ?? "").startsWith("pi-tether.");
/** A tool call's key within its stream. Not an evidence ref. */
export const callKey = (stream: string, callId: string | undefined): string => `${stream}:${callId}`;
/** The source (entry) ref a block ref belongs to; an entry ref is its own. */
export function entryRefOf(ref: string): string {
	const parsed = parseRef(ref);
	return parsed ? makeRef(parsed.stream, parsed.entryId) : ref;
}
const dialogs = new Set(["ask_user", "gather_input"]);
const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const TOOL_EXCERPT_CHARS = 6000;

function evidenceExcerpt(value: string, ref: string): string | undefined {
	if (!value) return undefined;
	if (value.length <= TOOL_EXCERPT_CHARS) return value;
	const notice = `\n\n[Incomplete excerpt: ${value.length} total chars; inspect evidence ${ref} for the exact source.]\n\n`;
	const available = TOOL_EXCERPT_CHARS - notice.length;
	const head = Math.ceil(available / 2), tail = Math.floor(available / 2);
	return `${value.slice(0, head)}${notice}${value.slice(-tail)}`;
}

const NARRATIVE_EXCERPT_CHARS = 8000;
const SKILL_BLOCK = /<skill\b[^>]*>[\s\S]*?<\/skill>/g;

/** A skill Pi expanded inline is not the user's words: name it, keep the surrounding request, point at the source. */
function collapseSkills(value: string, ref: string): string {
	return value.replace(SKILL_BLOCK, (block) => {
		const name = /\bname="([^"]*)"/.exec(block.slice(0, block.indexOf(">") + 1))?.[1];
		return `[skill${name ? ` ${name}` : ""} loaded (${block.length} chars); its instructions are not shown here; inspect_evidence ${ref} returns the original]`;
	});
}

/** Narrative text is kept whole until one event could crowd out the batch; then a head stays and the clip is announced. */
function narrativeExcerpt(value: string, ref: string, collapse: boolean): string {
	const text = collapse ? collapseSkills(value, ref) : value;
	if (text.length <= NARRATIVE_EXCERPT_CHARS) return text;
	const notice = (left: number) => `\n\n[Clipped: ${left} of ${text.length} chars left out; inspect_evidence ${ref} returns the full original text.]`;
	const keep = NARRATIVE_EXCERPT_CHARS - notice(text.length).length;
	return `${text.slice(0, keep)}${notice(text.length - keep)}`;
}

/** pi-delegate's todo snapshots (and pi-omp's older ones): phase, status, content, and any blocker. */
export const TODO_TYPES = new Set(["pi_delegate.todo", "pi_omp.todo"]);
export const isTodoEntry = (entry: Entry): boolean => entry.type === "custom" && typeof entry.customType === "string" && TODO_TYPES.has(entry.customType);
function todoText(phases: unknown): string {
	if (!Array.isArray(phases)) return "";
	const clean = (value: unknown, max: number) => oneLine(String(value ?? ""), max, { ellipsis: "" });
	return phases.flatMap((phase: any) => (Array.isArray(phase?.tasks) ? phase.tasks : []).map((task: any) => {
		const content = clean(task?.content, 110);
		if (!content) return "";
		const blocker = task?.blocker ? ` (blocked: ${clean(task.blocker, 80)})` : "";
		const where = phase?.name ? `${clean(phase.name, 40)} / ` : "";
		return `${typeof task?.status === "string" ? task.status.slice(0, 4) : "?"}: ${where}${content}${blocker}`;
	})).filter(Boolean).join(" | ");
}

function dialogPrompt(args: any): string | undefined {
	const option = (o: any) => [`- ${o?.title ?? o?.label ?? String(o)}`,
		...(typeof o?.description === "string" ? [o.description] : []), ...(typeof o?.markdown === "string" ? [o.markdown] : [])].join("\n");
	const render = (q: any) => typeof q?.question !== "string" ? [] : [q.question,
		...(Array.isArray(q.options) ? q.options.map(option) : [])];
	const lines = Array.isArray(args?.questions) ? args.questions.flatMap(render) : render(args);
	if (typeof args?.context === "string") lines.unshift(args.context);
	return lines.length ? lines.join("\n") : undefined;
}

/** Exact narrative + recorded metadata. No summary, task classification, or tool-success inference. */
export function extractEvents(stream: Pick<Stream, "key" | "actor">, e: Entry): FeedEvent[] {
	if (isMomEntry(e) || typeof e.id !== "string") return [];
	const ref = makeRef(stream.key, e.id);
	const events: FeedEvent[] = [];
	const emit = (value: Omit<FeedEvent, "ref" | "at" | "actor">, block?: number) => {
		events.push({ ref: makeRef(stream.key, e.id, block), at: e.timestamp, actor: stream.actor, ...value });
	};
	if (isCorrection(e)) { emit({ kind: "user", text: textOf(e.content), correction: true }); return events; }
	if (["compaction", "context_edit", "branch_summary"].includes(e.type)) {
		emit({ kind: e.type, fromRef: e.fromId ? makeRef(stream.key, e.fromId) : undefined,
			...(e.type === "compaction" && typeof e.summary === "string" && e.summary ? { claim: e.summary } : {}) });
		return events; // Original history remains available; never substitute a generated summary.
	}
	if (e.type === "custom" && e.customType === "file_op" && typeof e.data?.path === "string" && e.data.path) {
		emit({ kind: "file_op", name: typeof e.data.op === "string" ? e.data.op : undefined, text: e.data.path });
		return events;
	}
	if (e.type === "custom" && TODO_TYPES.has(e.customType)) {
		emit({ kind: "todo", text: todoText(e.data?.phases) });
		return events;
	}
	const m = e.type === "message" ? e.message : e.type === "custom_message" ? { ...e, role: "custom" } : undefined;
	if (!m) return events;
	if (m.role === "toolResult") {
		// A joined delegate call reports its worker's terminal outcome in the result itself: that is a receipt too.
		const joined = m.toolName === "delegate" && typeof m.details?.id === "string" && ["complete", "failed", "error", "stopped", "cancelled", "interrupted", "expired"].includes(m.details?.status);
		if (joined) emit({ kind: "delegate_receipt", name: m.details.id, status: m.details.status, ...(m.details.segment !== undefined ? { segment: m.details.segment } : {}) }, 1);
		const answer = dialogs.has(m.toolName) && !m.isError ? textOf(m.content) : "";
		emit({ kind: answer ? "user_answer" : "tool_result", name: m.toolName, callId: m.toolCallId,
			isError: m.isError, ...(answer ? { text: answer } : { text: evidenceExcerpt(textOf(m.content), ref) }) });
		return events;
	}
	if (m.role === "bashExecution") {
		const command = typeof m.command === "string" ? m.command : "";
		const output = typeof m.output === "string" ? m.output : "";
		const evidence = [command && `command:\n${command}`, output && `output:\n${output}`].filter(Boolean).join("\n");
		emit({ kind: "shell_result", name: "bash", status: m.cancelled ? "cancelled" : `exit:${m.exitCode ?? "unknown"}`,
			text: evidenceExcerpt(evidence, ref) });
		return events;
	}
	if (!["user", "assistant", "custom", "hookMessage"].includes(m.role)) return events;
	if (m.role === "custom" && m.customType === "delegate" && m.details?.id) {
		emit({ kind: "delegate_receipt", name: m.details.id, status: m.details.status, ...(m.details.segment !== undefined ? { segment: m.details.segment } : {}) });
		return events;
	}
	const text = narrativeExcerpt(textOf(m.content), ref, m.role !== "assistant");
	if (text) emit({ kind: m.role === "custom" || m.role === "hookMessage" ? "extension" : m.role,
		text, name: m.customType, status: m.role === "assistant" ? m.stopReason : undefined });
	if (Array.isArray(m.content)) m.content.forEach((block: any, i: number) => {
		if (block.type === "toolCall") {
			const blockRef = makeRef(stream.key, e.id, i);
			emit({ kind: "tool_call", name: block.namespace ? `${block.namespace}.${block.name}` : block.name,
				callId: block.id, text: dialogs.has(block.name) ? dialogPrompt(block.arguments)
					: evidenceExcerpt(JSON.stringify(block.arguments), blockRef) }, i);
		}
		else if (block.type !== "text" && block.type !== "thinking") emit({ kind: "attachment_not_interpreted", name: block.type }, i);
	});
	return events;
}

/** Walk only the appended suffix. A missing ancestor is a branch change, not an empty batch. */
export function suffix(manager: SessionReader, leaf: string | null, after: string | null): Entry[] {
	const entries: Entry[] = [];
	for (let id = leaf; id !== after;) {
		if (id === null) throw new Error("Path's consumed cursor is not on the selected branch.");
		const entry = manager.getEntry(id);
		if (!entry) throw new Error(`Missing session entry: ${id}`);
		entries.push(entry);
		id = entry.parentId;
	}
	return entries.reverse();
}

/** Complete lines only. A concurrently written tail remains pending at its original offset. */
async function* records(file: string, start: number, end: number) {
	if (end <= start) return;
	let offset = start;
	let pieces: Buffer[] = [];
	for await (const chunk of createReadStream(file, { start, end: end - 1 })) {
		const data = chunk as Buffer;
		let pos = 0;
		for (let newline = data.indexOf(10); newline !== -1; newline = data.indexOf(10, pos)) {
			const part = data.subarray(pos, newline + 1);
			const bytes = pieces.length ? Buffer.concat([...pieces, part]) : part;
			pieces = [];
			let entry: Entry;
			try { entry = JSON.parse(bytes.toString("utf8")); }
			catch { throw new Error(`Invalid transcript JSON at ${file}:${offset}; cursor retained.`); }
			yield { entry, bytes, offset };
			offset += bytes.length;
			pos = newline + 1;
		}
		if (pos < data.length) pieces.push(data.subarray(pos));
	}
}

/** One active parent branch, plus workers whose launch results occur on that branch. */
export class LiveFeed {
	readonly events: FeedEvent[] = [];
	readonly byRef = new Map<string, FeedEvent>();
	readonly gaps = new Map<string, string>();
	private readonly sources = new Map<string, Source>();
	private readonly calls = new Map<string, string>();
	private readonly runs = new Map<string, string | undefined>();
	private readonly workers = new Map<string, Reader>();
	private readonly runningWorkers = new Set<string>();
	private parentCursor: string | null = null;
	private readonly sessionId: string;
	private readonly parentStream: Stream;
	private readonly invocations = new Map<string, string>();
	private readonly returns = new Map<string, string>();
	private remaining = Infinity;
	private full = false;
	private admit?: (events: readonly FeedEvent[]) => boolean;

	constructor(private readonly manager: SessionReader) {
		this.sessionId = manager.getSessionId();
		this.parentStream = { key: this.sessionId, sessionId: this.sessionId, actor: "lead", file: manager.getSessionFile() ?? "", forkedMessages: 0 };
	}

	/** Register Path's own observed tool records without making them new lead activity or moving a cursor. */
	observe(observation: Observation): void {
		const stream = { key: observation.key, actor: "mom" };
		for (const entry of observation.entries) {
			const base = makeRef(stream.key, entry.id);
			if (this.sources.has(base)) throw new Error(`Duplicate source identity: ${base}`);
			this.sources.set(base, { entryId: entry.id, entry, stream: stream.key, actor: stream.actor, hash: digest(JSON.stringify(entry)) });
			for (const event of extractEvents(stream, entry)) {
				this.byRef.set(event.ref, event);
				const key = callKey(stream.key, event.callId);
				if (event.kind === "tool_call" && event.callId) this.invocations.set(key, event.ref);
				if (["tool_result", "user_answer"].includes(event.kind) && event.callId) this.returns.set(key, event.ref);
			}
		}
	}

	/** Original Path intents without recorded outcomes; never evidence of success or safe replay. */
	uncertainEffects(): Array<{ ref: string; name?: string }> {
		const uncertain = [];
		for (const [key, ref] of this.invocations) {
			const event = this.byRef.get(ref);
			if (event?.actor === "mom" && !this.returns.has(key)) uncertain.push({ ref, name: event.name });
		}
		return uncertain;
	}

	async restore(cut?: Cut): Promise<void> {
		if (!cut) return;
		// A fork gets a fresh feed. The checkpoint loader refuses a different session identity.
		suffix(this.manager, this.manager.getLeafId(), cut.parent);
		for (const entry of suffix(this.manager, cut.parent, null)) this.addParent(entry);
		this.parentCursor = cut.parent;
		for (const saved of cut.workers) {
			if (!this.runs.has(saved.runId)) throw new Error(`Worker ${saved.runId} has no launch on the checkpoint's branch.`);
			const reader = this.reader(saved);
			this.workers.set(saved.runId, reader);
			try {
				if (saved.offset) await this.readWorker(reader, saved.offset);
				if (reader.cursor.offset !== saved.offset || reader.hash.copy().digest("hex") !== saved.hash || reader.cursor.lastId !== saved.lastId) {
					throw new Error(`Worker history changed: ${saved.runId}`);
				}
			} catch (error) {
				// Do not reinterpret old citations against replacement data or silently skip missing history.
				throw new Error(`Cannot restore Path's sources: ${String(error)}`);
			}
		}
	}

	private addParent(entry: Entry): boolean {
		if (isMomEntry(entry)) return true;
		const events = extractEvents(this.parentStream, entry);
		if (!this.fits(events)) return false;
		this.add(this.parentStream, entry, { entryId: entry.id, entry, hash: digest(JSON.stringify(entry)) }, events);
		const m = entry.type === "message" ? entry.message : undefined;
		if (m?.role === "assistant" && Array.isArray(m.content)) {
			for (const b of m.content) if (b.type === "toolCall") this.calls.set(b.id, b.name);
		} else if (m?.role === "toolResult" && m.toolName === "delegate" && this.calls.get(m.toolCallId) === "delegate" && typeof m.details?.id === "string") {
			// ACP has its own storage, not native Pi owner pointers or transcripts.
			// Its reported outcomes remain in the lead's tool-result evidence above.
			if (m.details.backend !== "acp") this.runs.set(m.details.id, typeof m.details.sessionFile === "string" ? resolve(m.details.sessionFile) : undefined);
		}
		return true;
	}

	private fits(events: FeedEvent[]): boolean {
		const size = renderUpdateEvents(events).length;
		if (size > 24000 && Number.isFinite(this.remaining)) throw new Error("One entry's rendered events exceed Path's 24,000-character batch limit even after per-event clipping (many events in one entry); inspect that entry's ref with inspect_evidence and split or shorten the source entry. Nothing was truncated.");
		if (size > this.remaining) { this.full = true; return false; }
		if (this.admit && !this.admit(events)) { this.full = true; return false; }
		this.remaining -= size;
		return true;
	}

	private add(stream: Stream, entry: Entry, source: Source, emitted = extractEvents(stream, entry)): void {
		if (!emitted.length) return;
		const base = makeRef(stream.key, entry.id);
		if (this.sources.has(base)) throw new Error(`Duplicate source identity: ${base}`);
		this.sources.set(base, { ...source, stream: stream.key, actor: stream.actor });
		for (const event of emitted) {
			this.events.push(event);
			this.byRef.set(event.ref, event);
			const key = callKey(stream.key, event.callId);
			if (event.kind === "tool_call" && event.callId) this.invocations.set(key, event.ref);
			if (["tool_result", "user_answer"].includes(event.kind) && event.callId) this.returns.set(key, event.ref);
		}
	}

	private reader(saved: WorkerCursor): Reader {
		return { cursor: { ...saved, offset: 0, messages: 0, lastId: null, hash: EMPTY_HASH }, hash: createHash("sha256"), headerSeen: false };
	}

	private async discover(): Promise<void> {
		let owner: string | undefined;
		for (const [id, announcedFile] of this.runs) {
			try {
				// Match pi-delegate's canonical storage root without calling its directory-creating helper.
				owner ??= join(await realpath(this.manager.getCwd()), ".agents/pi/subsessions/owners", `${this.sessionId}.json`);
				const pointer = JSON.parse(await readFile(join(owner.slice(0, -5), `${encodeURIComponent(id)}.json`), "utf8"));
				if (pointer.version !== 1 || typeof pointer.recordPath !== "string") throw new Error("Invalid owner pointer");
				const run = JSON.parse(await readFile(pointer.recordPath, "utf8"));
				if (run.version !== 1 || run.id !== id || resolve(run.ownerKey ?? "") !== resolve(owner) ||
					typeof run.sessionId !== "string" || typeof run.sessionFile !== "string" || typeof run.cwd !== "string" || typeof run.role !== "string" ||
					!["fresh", "fork"].includes(run.context) || typeof run.status !== "string") throw new Error("Invalid delegate identity");
				if (run.status === "running") this.runningWorkers.add(id); else this.runningWorkers.delete(id);
				if (this.workers.has(id)) { this.gaps.delete(id); continue; }
				const file = resolve(run.sessionFile);
				if (announcedFile && announcedFile !== file) throw new Error("Delegate transcript differs from its launch result");
				const prefix = run.context === "fresh" ? 0 : run.forkedMessages;
				if (!Number.isSafeInteger(prefix) || prefix < 0) throw new Error("Missing immutable fork boundary");
				if (run.sessionId === this.sessionId || [...this.workers.values()].some((r) => r.cursor.sessionId === run.sessionId)) throw new Error("Repeated worker identity");
				const cursor: WorkerCursor = { key: run.sessionId, sessionId: run.sessionId, file, runId: id, cwd: resolve(run.cwd),
					actor: `${run.role} ${id}`, parent: this.sessionId, forkedMessages: prefix,
					offset: 0, messages: 0, lastId: null, hash: EMPTY_HASH, device: null, inode: null };
				this.workers.set(id, this.reader(cursor));
				this.gaps.delete(id);
			} catch (error) {
				// Unknown status is not permission to inspect a possibly live worker mid-run.
				this.runningWorkers.add(id);
				this.gaps.set(id, `${id}: ${String(error)}`);
			}
		}
	}

	get hasRunningWorkers(): boolean { return this.runningWorkers.size > 0; }

	private async readWorker(reader: Reader, through?: number): Promise<void> {
		const c = reader.cursor;
		const info = await stat(c.file);
		if (!info.isFile() || info.size < c.offset || (c.device !== null && (c.device !== info.dev || c.inode !== info.ino))) {
			throw new Error(`Worker transcript replaced or shortened: ${c.file}`);
		}
		c.device = info.dev; c.inode = info.ino;
		const end = through ?? info.size;
		if (end > info.size) throw new Error(`Worker transcript shortened: ${c.file}`);
		try { for await (const { entry, bytes, offset } of records(c.file, c.offset, end)) {
			if (!reader.headerSeen) {
				if (entry.type !== "session" || entry.id !== c.sessionId || resolve(entry.cwd ?? "") !== c.cwd || ![2, 3].includes(entry.version)) throw new Error(`Worker header mismatch: ${c.file}`);
				reader.headerSeen = true;
			} else {
				if (typeof entry.id !== "string" || !Number.isFinite(Date.parse(entry.timestamp))) throw new Error(`Invalid worker entry: ${c.file}:${offset}`);
				const messages = c.messages + (entry.type === "message" ? 1 : 0);
				const emitted = entry.type === "message" && messages <= c.forkedMessages ? [] : extractEvents(c, entry);
				if (!this.fits(emitted)) break;
				c.messages = messages;
				this.add(c, entry, { entryId: entry.id, entry, hash: digest(bytes), file: c.file, offset, bytes: bytes.length }, emitted);
				c.lastId = entry.id;
			}
			reader.hash.update(bytes);
			c.offset = offset + bytes.length;
		} } finally { c.hash = reader.hash.copy().digest("hex"); }
	}

	/** Byte caches advance as observed; only the returned immutable cut may be committed with a snapshot.
	 * Infinity drains a full audit locally; its model input is paginated separately, never sampled. */
	async capture(limit = 24000, deferRunningWorkers = false, admit?: (events: readonly FeedEvent[]) => boolean): Promise<{ events: FeedEvent[]; cut: Cut; gaps: string[]; more: boolean }> {
		const start = this.events.length;
		this.admit = admit;
		this.remaining = limit === Infinity ? Infinity : Math.max(0, Math.min(24000, limit)); this.full = false;
		const leaf = this.manager.getLeafId();
		const entries = suffix(this.manager, leaf, this.parentCursor);
		this.gaps.delete("parent");
		for (const entry of entries) {
			try {
				if (!this.addParent(entry)) break;
				this.parentCursor = entry.id;
			} catch (error) { this.gaps.set("parent", String(error)); break; }
		}
		await this.discover();
		for (const [id, reader] of this.workers) {
			if (this.full || (deferRunningWorkers && this.runningWorkers.size)) break;
			try {
				await this.readWorker(reader);
				if (!reader.headerSeen || reader.cursor.messages < reader.cursor.forkedMessages) this.gaps.set(id, `${id}: transcript has not reached its fork boundary`);
				else this.gaps.delete(id);
			} catch (error) { this.gaps.set(id, `${id}: ${String(error)}`); }
		}
		return { events: this.events.slice(start), cut: this.cut(), gaps: [...this.gaps.values()], more: this.full };
	}

	cut(): Cut {
		return { parent: this.parentCursor, workers: [...this.workers.values()].map((r) => ({ ...r.cursor })) };
	}

	/** Read-only transcript observations from the lead and captured worker streams. */
	sourceEntries(): SourceEntryObservation[] {
		return [...this.sources.values()]
			.filter((source): source is Source & { entry: Entry; stream: string; actor: string } => Boolean(source.entry && source.stream && source.actor))
			.map(source => ({ ref: makeRef(source.stream, source.entryId), stream: source.stream, actor: source.actor, entry: structuredClone(source.entry) }));
	}

	/** Structured todo observations from the lead and captured worker streams. */
	todoEntries(): SourceEntryObservation[] {
		return this.sourceEntries().filter(observation => isTodoEntry(observation.entry));
	}

	pairedSource(ref: string): string | undefined {
		const event = this.byRef.get(ref);
		if (!event?.callId) return undefined;
		const key = callKey(parseRef(ref)?.stream ?? ref, event.callId);
		return event.kind === "tool_call" ? this.returns.get(key) : this.invocations.get(key);
	}

	/** Ephemeral vectorless scan over original text. No payload copy or index survives this call. */
	async search(phrase: string, signal?: AbortSignal, question = phrase) {
		// Observations are branch-owned sources, not new lead activity or consumed coverage.
		const events = [...this.byRef.values()];
		const documents = new Map<string, string>(), gaps: string[] = [];
		let unreadable = 0;
		for (const event of events) {
			let text = renderEvent(event);
			if (["tool_call", "tool_result", "shell_result"].includes(event.kind)) {
				await scheduler.yield(); // A long explicit search must not monopolize the lead's event loop.
				signal?.throwIfAborted();
				try {
					const entry = await this.sourceEntry(event.ref), m = entry.message ?? entry;
					const block = parseRef(event.ref)?.block;
					const payload = block !== undefined ? JSON.stringify(m.content[block].arguments)
						: event.kind === "shell_result" ? String(m.output ?? "") : textOf(m.content);
					text += `\n${payload}`;
				} catch (error) {
					unreadable++;
					if (gaps.length < 5) gaps.push(`${event.ref}: ${String(error)}`);
				}
			}
			documents.set(event.ref, text);
		}
		return { matches: rankSearchDocuments(events, documents, phrase, question, ref => this.pairedSource(ref)), unreadable, gaps };
	}

	private async sourceEntry(ref: string): Promise<Entry> {
		if (!this.byRef.has(ref)) throw new Error(`Unknown/unobserved source: ${ref}`);
		const source = this.sources.get(entryRefOf(ref))!;
		let entry: Entry;
		if (source.entry) return source.entry;
		if (source.file) {
			const file = await open(source.file, "r");
			const bytes = Buffer.alloc(source.bytes!);
			try {
				let read = 0;
				while (read < bytes.length) {
					const n = await file.read(bytes, read, bytes.length - read, source.offset! + read);
					if (!n.bytesRead) throw new Error(`Source shortened: ${ref}`);
					read += n.bytesRead;
				}
			} finally { await file.close(); }
			if (digest(bytes) !== source.hash) throw new Error(`Source changed: ${ref}`);
			entry = JSON.parse(bytes.toString("utf8"));
		} else {
			// Parent sources come from pi's own in-memory tree, which pi legitimately mutates
			// (context edits, compaction). Presence on the branch is the durable check; a
			// re-serialization comparison is unstable across those mutations. Worker files keep
			// byte-exact verification below.
			entry = this.manager.getEntry(source.entryId)!;
			if (!entry) throw new Error(`Source missing: ${ref}`);
		}
		return entry;
	}

	async lookup(ref: string, offset = 0, limit = 4000) {
		if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 24000) throw new Error("Evidence pages allow offset >= 0 and limit 1..24000.");
		const entry = await this.sourceEntry(ref);
		const m = entry.message ?? entry;
		const block = parseRef(ref)?.block;
		const value = block !== undefined ? m.content[block] : ["user", "assistant", "custom"].includes(m.role)
			? { role: m.role, text: textOf(m.content), stopReason: m.stopReason, errorMessage: m.errorMessage } : m;
		const text = JSON.stringify(value);
		return { ref, offset, totalChars: text.length, nextOffset: offset + limit < text.length ? offset + limit : null, text: text.slice(offset, offset + limit) };
	}
}

export function renderEvent(e: FeedEvent, includeText = true): string {
	return `[src:${e.ref}] ${e.at} ${e.actor} ${e.kind}${e.name ? ` ${e.name}` : ""}${e.status ? ` status=${e.status}` : ""}${e.isError !== undefined ? ` isError=${e.isError}` : ""}${e.callId ? ` callId=${e.callId}` : ""}${includeText && e.text ? `\n${e.text}` : ""}`;
}

/** Render the bounded session evidence stream. */
export function renderEvents(events: readonly FeedEvent[]): string {
	return events.map(event => renderEvent(event)).join("\n");
}

const FENCE_ELIDE_CHARS = 1200;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t\r]*$/;
// Prefix of lookup()'s JSON page for an assistant message; keeps marker offsets directly usable.
const ASSISTANT_LOOKUP_PREFIX = JSON.stringify({ role: "assistant", text: "" }).slice(0, -2);

/** Replace the bodies of complete, oversized fenced blocks with source markers. Unclosed fences stay verbatim. */
function elideLargeFences(text: string, ref: string): string {
	const lines: { start: number; text: string }[] = [];
	for (let start = 0; start <= text.length;) {
		const newline = text.indexOf("\n", start), end = newline < 0 ? text.length : newline;
		lines.push({ start, text: text.slice(start, end) });
		start = end + 1;
	}
	let out = "", copied = 0;
	for (let i = 0; i < lines.length; i++) {
		const open = FENCE_OPEN.exec(lines[i].text);
		if (!open || (open[1][0] === "`" && open[2].includes("`"))) continue;
		const j = lines.findIndex((line, k) => {
			if (k <= i) return false;
			const close = FENCE_CLOSE.exec(line.text);
			return close !== null && close[1][0] === open[1][0] && close[1].length >= open[1].length;
		});
		if (j < 0) continue;
		const start = lines[i + 1].start, end = lines[j].start, body = text.slice(start, end);
		if (body.length > FENCE_ELIDE_CHARS) {
			const offset = ASSISTANT_LOOKUP_PREFIX.length + JSON.stringify(text.slice(0, start)).length - 2;
			const limit = Math.min(24000, JSON.stringify(body).length - 2);
			out += `${text.slice(copied, start)}[Omitted fenced block: message text chars ${start}-${end} (${body.length} chars) not shown. ` +
				`Its contents are unread here, not verified fact; read the original with inspect_evidence ref=${ref} offset=${offset} limit=${limit}` +
				`${limit === 24000 ? " and follow nextOffset" : ""}.]\n`;
			copied = end;
		}
		i = j;
	}
	return out + text.slice(copied);
}

export function renderUpdateEvent(event: FeedEvent): string {
	if (event.kind === "assistant" && event.text) return renderEvent({ ...event, text: elideLargeFences(event.text, event.ref) });
	if (!["tool_call", "tool_result", "shell_result"].includes(event.kind) || dialogs.has(event.name ?? "")) return renderEvent(event);
	const status = event.kind === "tool_call" ? "attempted; result is separate"
		: event.status ?? (event.isError === true ? "error" : event.isError === false ? "returned without tool error" : "outcome unknown");
	return `${renderEvent(event, false)}\n${status}; payload available through inspect_evidence.`;
}

export function renderUpdateEvents(events: readonly FeedEvent[]): string {
	return events.map(renderUpdateEvent).join("\n");
}

const SEARCH_STOPWORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "did", "do", "does", "exact", "for", "from", "including", "in", "is", "it", "of", "on", "or", "recorded", "report", "reported", "that", "the", "this", "to", "was", "were", "what", "when", "where", "which", "with"]);
export function searchTokens(value: string): string[] {
	return value.toLocaleLowerCase().normalize("NFKC").split(/[^\p{L}\p{N}_]+/u)
		.filter(token => token.length > 1 && !SEARCH_STOPWORDS.has(token));
}

/**
 * Rank ephemeral original-source documents without returning their text. Terms in results are
 * copied only from the supplied query/question, so payload content never leaks through search.
 */
export function rankSearchDocuments(events: readonly FeedEvent[], documents: ReadonlyMap<string, string>, phrase: string, question: string,
	pairedSource: (ref: string) => string | undefined = () => undefined) {
	const query = phrase.toLocaleLowerCase(), queryTerms = [...new Set(searchTokens(phrase))];
	const questionTerms = [...new Set(searchTokens(question))], suppliedTerms = [...new Set([...queryTerms, ...questionTerms])];
	const eventByRef = new Map(events.map(event => [event.ref, event]));
	const docs = events.map(event => {
		const text = documents.get(event.ref) ?? renderEvent(event), lower = text.toLocaleLowerCase(), tokens = searchTokens(text);
		const counts = new Map<string, number>();
		for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
		return { event, lower, counts };
	});
	const frequency = new Map<string, number>();
	for (const term of questionTerms) for (const doc of docs) if (doc.counts.has(term)) frequency.set(term, (frequency.get(term) ?? 0) + 1);
	type Candidate = { event: FeedEvent; pairedRef?: string; exact: boolean; payloadMatched: boolean; matched: string[]; score: number; coverage: number; time: number };
	const candidates: Candidate[] = [];
	for (const doc of docs) {
		const exact = Boolean(query && doc.lower.includes(query));
		const matched = suppliedTerms.filter(term => doc.counts.has(term));
		if (!exact && new Set(matched).size < 2) continue;
		let score = 0;
		for (const term of questionTerms) {
			const count = doc.counts.get(term) ?? 0;
			if (count) score += (Math.log((docs.length + 1) / ((frequency.get(term) ?? 0) + 1)) + 1) * Math.log1p(count);
		}
		const queryMatched = queryTerms.filter(term => doc.counts.has(term)).length;
		const metadata = renderEvent(doc.event, false).toLocaleLowerCase(), metadataTokens = new Set(searchTokens(metadata));
		const metadataMatched = suppliedTerms.filter(term => metadataTokens.has(term));
		const metadataQualifies = Boolean(query && metadata.includes(query)) || new Set(metadataMatched).size >= 2;
		candidates.push({ event: doc.event, exact, payloadMatched: !metadataQualifies, matched, score,
			coverage: queryTerms.length ? queryMatched / queryTerms.length : 0, time: Date.parse(doc.event.at) || 0 });
	}
	// A tool invocation and result are one evidence unit. Prefer returning the observed result;
	// inspecting either ref still supplies both records within one source-read page.
	const groups = new Map<string, Candidate[]>();
	for (const candidate of candidates) {
		const event = candidate.event, pair = pairedSource(event.ref), paired = pair ? eventByRef.get(pair) : undefined;
		const selected = paired && event.kind === "tool_call" && ["tool_result", "shell_result"].includes(paired.kind)
			? { ...candidate, event: paired, pairedRef: event.ref } : { ...candidate, ...(pair ? { pairedRef: pair } : {}) };
		const key = selected.event.callId ? `${parseRef(selected.event.ref)?.stream}\0${selected.event.callId}` : selected.event.ref;
		(groups.get(key) ?? groups.set(key, []).get(key)!).push(selected);
	}
	const preferred = [...groups.values()].map(group => group.sort((a, b) => {
		const result = (item: Candidate) => ["tool_result", "shell_result"].includes(item.event.kind) ? 1 : 0;
		return result(b) - result(a) || b.score - a.score || b.coverage - a.coverage || Number(b.exact) - Number(a.exact) || b.time - a.time || b.event.ref.localeCompare(a.event.ref);
	})[0]);
	preferred.sort((a, b) => b.score - a.score || b.coverage - a.coverage || Number(b.exact) - Number(a.exact) || b.time - a.time || b.event.ref.localeCompare(a.event.ref));
	return preferred.slice(0, 5).map(item => ({ ref: item.event.ref, actor: item.event.actor, at: item.event.at,
		kind: item.event.kind, name: item.event.name, isError: item.event.isError, pairedRef: item.pairedRef,
		payloadMatched: item.payloadMatched, matchMode: item.exact ? "exact" : "tokens", matchedTerms: item.matched, matchedTermCount: item.matched.length,
		queryCoverage: Number(item.coverage.toFixed(3)), score: Number(item.score.toFixed(3)) }));
}

/** Rank literal matches without exposing payload text in the search response. */
export function searchHistory(events: readonly FeedEvent[], phrase: string, payloadMatches: ReadonlySet<string> = new Set()) {
	const query = phrase.toLocaleLowerCase();
	const hits: { event: FeedEvent; text: string; from: number; time: number }[] = [];
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		const text = renderEvent(event), at = text.toLocaleLowerCase().indexOf(query);
		if (at < 0 && !payloadMatches.has(event.ref)) continue;
		const time = Date.parse(event.at);
		// Restore groups streams differently. Rank by source time, not capture order.
		const rank = hits.findIndex((h) => time > h.time || (time === h.time && event.ref > h.event.ref));
		if (rank < 0 && hits.length === 5) continue;
		const hit = { event, text, from: Math.max(0, at - 100), time };
		if (rank < 0) hits.push(hit); else hits.splice(rank, 0, hit);
		if (hits.length > 5) hits.pop();
	}
	return hits.map(({ event, text, from }) => ({ ref: event.ref, actor: event.actor, at: event.at, kind: event.kind,
		name: event.name, isError: event.isError, payloadMatched: payloadMatches.has(event.ref), text: text.slice(from, from + 500),
		truncated: from > 0 || from + 500 < text.length }));
}

export const isUserDirection = (event: FeedEvent): boolean => event.actor === "lead" && (event.kind === "user" || event.kind === "user_answer");
