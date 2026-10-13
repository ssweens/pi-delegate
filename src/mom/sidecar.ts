import { randomUUID } from "node:crypto";
import { isRecord } from "../util/text.ts";
import { nodeJsonlIO, parseJsonLines, readIfExists, siblingFile, type JsonlIO } from "../util/jsonl.ts";

/** The only durable Path record families. Map records also own cursor/failure/control state. */
export type SidecarType = "map" | "notice" | "usage" | "injection";
export type SidecarWriteType = SidecarType;
/** Every durable delivery setting. A control record names exactly one, so the sidecar can reject a
 * malformed request before it is written and a reader can apply it without guessing. */
export const CONTROL_KEYS = ["enabled", "inject", "nudgedClasses", "mode", "model", "decider"] as const;
export type ControlKey = typeof CONTROL_KEYS[number];
export interface SidecarRecord { id: string; sessionId: string; type: SidecarType; at: number; data: Record<string, any> }

/** Path's durable state lives in an append-only sidecar beside the session transcript, never inside it. */
export interface MomStore {
	/** This session's durable records, oldest first; empty until the sidecar exists. */
	load(): Promise<SidecarRecord[]>;
	/** A supplied ID deduplicates retries and returns the original record. */
	append(type: SidecarWriteType, data: Record<string, any>, id?: string): Promise<SidecarRecord>;
	/** Forget cached records so the next load reads what another writer appended. */
	invalidate?(): void;
	/** Why each unreadable line of the last load was skipped: one bad line never stops Path. */
	readonly skipped?: readonly string[];
	/** Which coverage track map records written through this store belong to; `loadState` sets it. */
	track?: "graph" | "trail";
}

export const sidecarFile = (sessionFile: string) => siblingFile(sessionFile, "mom");

const types: readonly SidecarType[] = ["map", "notice", "usage", "injection"];
const recordKeys = ["at", "data", "id", "sessionId", "type"];

export class SidecarStore implements MomStore {
	private records?: SidecarRecord[];
	private unreadable: string[] = [];
	/** The sidecar this instance has seen exist. Once it is deleted or replaced, this instance
	 * never writes again: its in-memory state must not resurrect a reset Path. */
	private seen?: { file: string; identity: string };
	private detached = false;
	/** Map records written in trail mode are marked, so graph and trail keep separate coverage. */
	track: "graph" | "trail" = "graph";
	constructor(private readonly sessionFile: () => string | undefined, private readonly sessionId: string,
		private readonly io: JsonlIO = nodeJsonlIO) {}

	/** Forget what was read: Path's tools in oven append to the same file. */
	invalidate(): void { this.records = undefined; }

	get skipped(): readonly string[] { return this.unreadable; }

	async load(): Promise<SidecarRecord[]> {
		if (this.records) return this.records;
		this.records = [];
		const session = this.sessionFile();
		if (!session) return this.records; // no session file: no durable state
		const file = sidecarFile(session);
		const bytes = await readIfExists(this.io, file);
		const identity = await this.io.identity(file);
		if (identity && !this.seen) this.seen = { file, identity };
		// A complete line that cannot be read is skipped and reported, never fatal.
		const parsed = parseJsonLines(bytes);
		this.unreadable = parsed.unreadable;
		for (const { number, value } of parsed.values) {
			const record = value as SidecarRecord;
			if (!isRecord(record) ||
				JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(recordKeys) ||
				typeof record.id !== "string" || typeof record.sessionId !== "string" || !types.includes(record.type) ||
				!Number.isFinite(record.at) || !isRecord(record.data)) {
				this.unreadable.push(`line ${number}: not a Path record`);
				continue;
			}
			if (record.sessionId === this.sessionId) this.records.push(record);
		}
		return this.records;
	}

	async append(type: SidecarWriteType, data: Record<string, any>, id: string = randomUUID(), beforeWrite?: () => Promise<void>): Promise<SidecarRecord> {
		const session = this.sessionFile();
		if (!session) throw new Error("Path needs a persisted session file for its state; in-memory sessions keep none.");
		const file = sidecarFile(session);
		if (!this.detached && this.seen?.file === file && await this.io.identity(file) !== this.seen.identity) this.detached = true;
		if (this.detached) throw new Error(`Path's sidecar was deleted or replaced outside this session (${file}). This instance will not write its in-memory map back; /reload rebuilds from the session transcript.`);
		try {
			await this.load();
			const existing = this.records!.find(record => record.id === id);
			if (existing) return existing;
			const record: SidecarRecord = { id, sessionId: this.sessionId, type, at: Date.now(), data: type === "map" && this.track === "trail" ? { ...data, trail: true } : data };
			await this.io.append(file, JSON.stringify(record) + "\n", beforeWrite);
			if (!this.seen || this.seen.file !== file) { const identity = await this.io.identity(file); if (identity) this.seen = { file, identity }; }
			this.records!.push(record);
			return record;
		} catch (error) {
			// The filesystem may have accepted only a prefix before rejecting. Forget the cache so the next
			// same-instance append re-reads; the next record then starts on its own line.
			this.records = undefined;
			throw error;
		}
	}
}
