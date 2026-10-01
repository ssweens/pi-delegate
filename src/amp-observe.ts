/**
 * On-demand observation of an opened Amp thread (todo 044, decision in todo 040 and ADR 0001).
 *
 * One `amp threads export <T-ID>` per call, never in the background. The export is a full dump of
 * the thread, so each call returns only the messages after the last messageId this run was shown.
 * That cursor is saved with the run record (acp-backend.ts), so it survives a parent restart. The
 * thread's `v` and `updatedAt` decide "no change" without reading the messages. The output is held
 * to the session's maxOutputBytes; what the bound leaves out is returned by the next call, never
 * skipped: a message larger than the bound is returned in parts, the cursor keeping how much of it
 * was shown. A failed or unreadable export is reported as unknown and moves nothing.
 */
import { ampThreadExport } from "./acp/runtime/amp-cli.js";
import type { AmpObservation, ObservedMessage } from "./backend.js";

/** Where the last observation left off. */
export interface ObserveCursor {
	/** The last messageId returned whole. Absent until a message with an ID was returned. */
	messageId?: string;
	/** Characters already returned of the message after `messageId`, which the bound cut. The next observation returns the rest. */
	offset?: number;
	version?: number;
	updatedAt?: string;
	/** Messages the bound left unread at that observation. */
	remaining: number;
	at: string;
}

export const OBSERVE_TIMEOUT_MS = 30_000;

// Only the export fields this module reads. Amp's export is observed data, not a published contract.
interface ExportedMessage { role?: unknown; content?: unknown; createdAt?: unknown; messageId?: unknown }
interface ThreadExport { v?: unknown; id?: unknown; updatedAt?: unknown; messages?: unknown }

const UNKNOWN = "unknown";

const idOf = (message: ExportedMessage): string | undefined =>
	typeof message.messageId === "string" || typeof message.messageId === "number" ? String(message.messageId) : undefined;

function timeOf(value: unknown): string | undefined {
	if (typeof value === "string" && value) return value;
	if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
	return undefined;
}

/** Text blocks verbatim; any other block as a marker, so nothing is paraphrased. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => {
		if (!block || typeof block !== "object") return "";
		const b = block as { type?: unknown; text?: unknown; name?: unknown };
		if (b.type === "text" && typeof b.text === "string") return b.text;
		const type = typeof b.type === "string" ? b.type : UNKNOWN;
		return typeof b.name === "string" ? `[${type} ${b.name}]` : `[${type}]`;
	}).filter(Boolean).join("\n");
}

/** The longest prefix of `text` that fits in `bytes` UTF-8 bytes, without a split character. */
function cut(text: string, bytes: number): string {
	if (bytes <= 0) return "";
	let out = Buffer.from(text, "utf8").subarray(0, bytes).toString("utf8");
	while (out.endsWith("�") && !text.startsWith(out)) out = out.slice(0, -1);
	return out;
}

export function messageHeader(m: ObservedMessage): string {
	return `#${m.messageId} ${m.role} · author ${m.author} · ${m.createdAt}${m.continued ? " · continued" : ""}`;
}

const messageBytes = (m: ObservedMessage) => Buffer.byteLength(`${messageHeader(m)}\n${m.text}\n`, "utf8");

/**
 * Pure: what one parsed export shows after `cursor`, held to `maxBytes`. Returns the new cursor
 * (unchanged when nothing new was returned).
 */
export function selectObserved(threadId: string, exported: ThreadExport, cursor: ObserveCursor | undefined, maxBytes: number, at: string): { observation: AmpObservation; cursor: ObserveCursor } {
	const version = typeof exported.v === "number" && Number.isFinite(exported.v) ? exported.v : undefined;
	const updatedAt = timeOf(exported.updatedAt);
	const base = { threadId, at, ...(version !== undefined ? { version } : {}), ...(updatedAt !== undefined ? { updatedAt } : {}), maxBytes };
	// The thread's version marks change: the same v and updatedAt, with nothing left unread, is no change.
	const sameThread = cursor !== undefined && version !== undefined && cursor.version === version && cursor.updatedAt === updatedAt;
	if (sameThread && cursor.remaining === 0 && !cursor.offset) {
		return { observation: { ...base, state: "unchanged", messages: [], remaining: 0, truncated: false }, cursor: { ...cursor, at } };
	}
	const all = (exported.messages as ExportedMessage[]).filter((m) => m && typeof m === "object");
	let start = 0;
	let cursorReset = false;
	if (cursor?.messageId !== undefined) {
		const index = all.findIndex((m) => idOf(m) === cursor.messageId);
		if (index >= 0) start = index + 1;
		else cursorReset = true;
	}
	const pending = all.slice(start);
	// The bound cut the first pending message last time: it continues from there.
	const resume = !cursorReset && typeof cursor?.offset === "number" && cursor.offset > 0 ? cursor.offset : 0;
	const messages: ObservedMessage[] = [];
	let budget = maxBytes;
	let cutAt: number | undefined;
	let lastId = cursorReset ? undefined : cursor?.messageId;
	for (const [index, raw] of pending.entries()) {
		const skip = index === 0 ? resume : 0;
		const message: ObservedMessage = {
			messageId: idOf(raw) ?? UNKNOWN,
			role: typeof raw.role === "string" && raw.role ? raw.role : UNKNOWN,
			// The export carries no per-message author; the thread's creator is not every sender's identity.
			author: UNKNOWN,
			createdAt: timeOf(raw.createdAt) ?? UNKNOWN,
			text: textOf(raw.content).slice(skip),
			...(skip ? { continued: true as const } : {}),
		};
		const size = messageBytes(message);
		if (size > budget) {
			if (messages.length) break;
			// The first message alone exceeds the bound: return what fits of it; the cursor keeps where it was cut.
			message.text = cut(message.text, budget - messageBytes({ ...message, text: "" }));
			message.truncated = true;
			cutAt = skip + message.text.length;
		}
		messages.push(message);
		budget -= messageBytes(message);
		if (cutAt !== undefined) break;
		const id = idOf(raw);
		if (id !== undefined) lastId = id;
	}
	const cutOne = cutAt !== undefined;
	const remaining = pending.length - messages.length;
	// Same version: unchanged, even while earlier-unread messages are still being returned. Without a
	// version on either side, only "no message after the cursor" can be said.
	const unversioned = version === undefined && cursor !== undefined && cursor.version === undefined && messages.length === 0 && !cursorReset;
	const state = sameThread || unversioned ? "unchanged" : "changed";
	const observation: AmpObservation = { ...base, state, messages, remaining, truncated: remaining > 0 || cutOne, ...(cursorReset ? { cursorReset: true as const } : {}) };
	const next: ObserveCursor = { remaining, at, ...(lastId !== undefined ? { messageId: lastId } : {}), ...(cutAt !== undefined ? { offset: cutAt } : {}), ...(version !== undefined ? { version } : {}), ...(updatedAt !== undefined ? { updatedAt } : {}) };
	return { observation, cursor: next };
}

/** One export, on demand. `cursor` is undefined in the result when the export failed: nothing moved. */
export async function observeAmpThread(input: { threadId: string; cwd: string; cursor?: ObserveCursor; maxBytes: number; timeoutMs?: number }): Promise<{ observation: AmpObservation; cursor?: ObserveCursor }> {
	const at = new Date().toISOString();
	const unknown = (error: string) => ({ observation: { threadId: input.threadId, at, state: "unknown" as const, messages: [], remaining: 0, truncated: false, maxBytes: input.maxBytes, error } });
	let exported: unknown;
	try {
		const run = await ampThreadExport(input.threadId, input.cwd, { timeoutMs: input.timeoutMs ?? OBSERVE_TIMEOUT_MS });
		if (run.timedOut) return unknown(`amp threads export did not finish within ${input.timeoutMs ?? OBSERVE_TIMEOUT_MS} ms`);
		if (run.code !== 0) return unknown(`amp threads export exited ${run.code ?? "by signal"}${run.stderr ? `: ${run.stderr}` : ""}`);
		exported = JSON.parse(run.stdout.toString("utf8"));
	} catch (error) {
		return unknown(error instanceof SyntaxError ? "amp threads export returned invalid JSON" : `amp threads export could not run: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!exported || typeof exported !== "object" || Array.isArray(exported)) return unknown("amp threads export returned no thread object");
	const thread = exported as ThreadExport;
	if (thread.id !== undefined && thread.id !== input.threadId) return unknown(`amp threads export returned thread ${String(thread.id)}, not ${input.threadId}`);
	if (!Array.isArray(thread.messages)) return unknown("amp threads export has no messages list");
	return selectObserved(input.threadId, thread, input.cursor, input.maxBytes, at);
}

/** Text the parent model reads. Messages are quoted, never blended into the tool's own reporting. */
export function observationText(o: AmpObservation): string {
	const marks = [o.version !== undefined ? `v ${o.version}` : "", o.updatedAt ? `updated ${o.updatedAt}` : ""].filter(Boolean).join(", ");
	const head = `observed Amp thread ${o.threadId} at ${o.at}${marks ? ` (${marks})` : ""}`;
	if (o.state === "unknown") return `${head}: unknown, ${o.error ?? "no reason given"}. The observation cursor did not move.`;
	if (o.state === "unchanged" && !o.messages.length) return `${head}: no change since the last observation.`;
	const notes = [
		o.state === "unchanged" ? "the thread is unchanged since the last observation; these were left unread by its bound" : "",
		o.cursorReset ? "the last message shown before is no longer in the thread, so this lists from its start" : "",
		o.remaining ? `${o.remaining} more after these were left out by the ${o.maxBytes}-byte bound; observe again to read them` : "",
		o.messages.some((m) => m.truncated) ? `a message was cut to the ${o.maxBytes}-byte bound; observe again for the rest of it` : "",
	].filter(Boolean);
	const count = `${o.messages.length} message${o.messages.length === 1 ? "" : "s"} since the last observation`;
	const lines = [`${head}: ${count}${notes.length ? `; ${notes.join("; ")}` : ""}.`];
	if (o.messages.length) {
		lines.push(`----- ${o.threadId} messages, verbatim -----`);
		for (const m of o.messages) lines.push(messageHeader(m), m.text);
		lines.push("----- end of messages -----");
	}
	return lines.join("\n");
}
