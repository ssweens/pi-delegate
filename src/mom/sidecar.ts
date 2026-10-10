import { appendFile, readFile, stat, truncate } from "node:fs/promises";
import { randomUUID } from "node:crypto";

/** The only durable Mom record families. Map records also own cursor/failure/control state. */
export type SidecarType = "map" | "notice" | "usage" | "injection";
export type SidecarWriteType = SidecarType;
/** Every durable delivery setting. A control record names exactly one, so the sidecar can reject a
 * malformed request before it is written and a reader can apply it without guessing. */
export const CONTROL_KEYS = ["enabled", "inject", "nudgedClasses", "mode", "model", "decider"] as const;
export type ControlKey = typeof CONTROL_KEYS[number];
export interface SidecarRecord { id: string; sessionId: string; type: SidecarType; at: number; data: Record<string, any> }

/** Mom's durable state lives in an append-only sidecar beside the session transcript, never inside it. */
export interface MomStore {
	/** This session's durable records, oldest first; empty until the sidecar exists. */
	load(): Promise<SidecarRecord[]>;
	/** A supplied ID deduplicates retries and returns the original record. */
	append(type: SidecarWriteType, data: Record<string, any>, id?: string): Promise<SidecarRecord>;
	/** Forget cached records so the next load reads what another writer appended. */
	invalidate?(): void;
}

// Pi's session lister scans every *.jsonl file in the session directory; the sidecar must not match.
export const sidecarFile = (sessionFile: string) => sessionFile.replace(/\.jsonl$/, "") + ".mom";

const types: readonly SidecarType[] = ["map", "notice", "usage", "injection"];
const recordKeys = ["at", "data", "id", "sessionId", "type"];

export interface SidecarIO {
	/** Stable file identity (device:inode), or undefined when the file does not exist. */
	identity(file: string): Promise<string | undefined>;
	read(file: string): Promise<Buffer>;
	append(file: string, data: string): Promise<void>;
	truncate(file: string, bytes: number): Promise<void>;
}
const nodeIO: SidecarIO = {
	identity: (file) => stat(file).then(info => `${info.dev}:${info.ino}`, (error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	}),
	read: (file) => readFile(file),
	append: (file, data) => appendFile(file, data),
	truncate: (file, bytes) => truncate(file, bytes),
};

export class SidecarStore implements MomStore {
	private records?: SidecarRecord[];
	private torn?: { file: string; bytes: number };
	/** The sidecar this instance has seen exist. Once it is deleted or replaced, this instance
	 * never writes again: its in-memory state must not resurrect a reset Mom. */
	private seen?: { file: string; identity: string };
	private detached = false;
	constructor(private readonly sessionFile: () => string | undefined, private readonly sessionId: string,
		private readonly io: SidecarIO = nodeIO) {}

	/** Forget what was read: Mom's tools in oven append to the same file. */
	invalidate(): void { this.records = undefined; this.torn = undefined; }

	async load(): Promise<SidecarRecord[]> {
		if (this.records) return this.records;
		this.records = [];
		const session = this.sessionFile();
		if (!session) return this.records; // no session file: no durable state
		const file = sidecarFile(session);
		let bytes: Buffer = Buffer.alloc(0);
		try { bytes = await this.io.read(file); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		const identity = await this.io.identity(file);
		if (identity && !this.seen) this.seen = { file, identity };
		// Locate the durable prefix in bytes, not decoded characters: a torn write may
		// end in the middle of a UTF-8 sequence. Corrupt complete lines remain loud.
		const newline = bytes.lastIndexOf(0x0a);
		const durableBytes = newline + 1;
		if (durableBytes < bytes.length) this.torn = { file, bytes: durableBytes };
		const text = bytes.subarray(0, durableBytes).toString("utf8");
		for (const line of text.split("\n")) {
			if (!line) continue;
			const record = JSON.parse(line) as SidecarRecord;
			if (!record || typeof record !== "object" || Array.isArray(record) ||
				JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(recordKeys) ||
				typeof record.id !== "string" || typeof record.sessionId !== "string" || !types.includes(record.type) ||
				!Number.isFinite(record.at) || !record.data || typeof record.data !== "object" || Array.isArray(record.data)) {
				throw new Error(`Corrupt Mom state line in ${file}`);
			}
			if (record.sessionId === this.sessionId) this.records.push(record);
		}
		return this.records;
	}

	async append(type: SidecarWriteType, data: Record<string, any>, id: string = randomUUID()): Promise<SidecarRecord> {
		const session = this.sessionFile();
		if (!session) throw new Error("Mom needs a persisted session file for her state; in-memory sessions keep none.");
		const file = sidecarFile(session);
		if (!this.detached && this.seen?.file === file && await this.io.identity(file) !== this.seen.identity) this.detached = true;
		if (this.detached) throw new Error(`Mom's sidecar was deleted or replaced outside this session (${file}). This instance will not write its in-memory map back; /reload rebuilds from the session transcript.`);
		try {
			await this.load();
			const existing = this.records!.find(record => record.id === id);
			if (existing) return existing;
			if (this.torn) {
				// Two writers share the file (the lead, and Mom's tools in oven): a line may be mid-write. Only a
				// tail that is still partial a moment later is a torn write to repair.
				await new Promise(resolve => setTimeout(resolve, 250));
				this.invalidate(); await this.load();
				const again = this.records!.find(record => record.id === id);
				if (again) return again;
				if (this.torn) { await this.io.truncate(this.torn.file, this.torn.bytes); this.torn = undefined; }
			}
			const record: SidecarRecord = { id, sessionId: this.sessionId, type, at: Date.now(), data };
			await this.io.append(file, JSON.stringify(record) + "\n");
			if (!this.seen || this.seen.file !== file) { const identity = await this.io.identity(file); if (identity) this.seen = { file, identity }; }
			this.records!.push(record);
			return record;
		} catch (error) {
			// The filesystem may have accepted only a prefix before rejecting. Forget
			// both caches so the next same-instance append re-reads and repairs the file.
			this.records = undefined;
			this.torn = undefined;
			throw error;
		}
	}
}
