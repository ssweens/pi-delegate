import { open, readFile, stat } from "node:fs/promises";
import lockfile from "proper-lockfile";
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
	/** Why each unreadable line of the last load was skipped: one bad line never stops Mom. */
	readonly skipped?: readonly string[];
	/** Which coverage track map records written through this store belong to; `loadState` sets it. */
	track?: "graph" | "trail";
}

// Pi's session lister scans every *.jsonl file in the session directory; the sidecar must not match.
export const sidecarFile = (sessionFile: string) => sessionFile.replace(/\.jsonl$/, "") + ".mom";

const types: readonly SidecarType[] = ["map", "notice", "usage", "injection"];
const recordKeys = ["at", "data", "id", "sessionId", "type"];

export interface SidecarIO {
	/** Stable file identity (device:inode), or undefined when the file does not exist. */
	identity(file: string): Promise<string | undefined>;
	read(file: string): Promise<Buffer>;
	/** Append one record durably, serialized with every other writer of the file. */
	append(file: string, data: string, beforeWrite?: () => Promise<void>): Promise<void>;
}
const nodeIO: SidecarIO = {
	identity: (file) => stat(file).then(info => `${info.dev}:${info.ino}`, (error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	}),
	read: (file) => readFile(file),
	append: async (file, data, beforeWrite) => {
		// The lead and Mom's tools in oven both append: take the file's lock, and finish the previous line first when
		// a crashed writer left it open, so a torn record stays one skippable line and never merges with this one.
		const release = await lockfile.lock(file, { realpath: false, stale: 15_000, retries: { retries: 40, minTimeout: 25, maxTimeout: 250 } });
		try {
			await beforeWrite?.();
			const handle = await open(file, "a+");
			try {
				const { size } = await handle.stat();
				let prefix = "";
				if (size > 0) { const last = Buffer.alloc(1); await handle.read(last, 0, 1, size - 1); if (last[0] !== 0x0a) prefix = "\n"; }
				await handle.appendFile(prefix + data);
				await handle.sync();
			} finally { await handle.close(); }
		} finally { await release(); }
	},
};

export class SidecarStore implements MomStore {
	private records?: SidecarRecord[];
	private unreadable: string[] = [];
	/** The sidecar this instance has seen exist. Once it is deleted or replaced, this instance
	 * never writes again: its in-memory state must not resurrect a reset Mom. */
	private seen?: { file: string; identity: string };
	private detached = false;
	/** Map records written in trail mode are marked, so graph and trail keep separate coverage. */
	track: "graph" | "trail" = "graph";
	constructor(private readonly sessionFile: () => string | undefined, private readonly sessionId: string,
		private readonly io: SidecarIO = nodeIO) {}

	/** Forget what was read: Mom's tools in oven append to the same file. */
	invalidate(): void { this.records = undefined; }

	get skipped(): readonly string[] { return this.unreadable; }

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
		// Only complete lines count, found in bytes not decoded characters: a torn or still-written tail may end in
		// the middle of a UTF-8 sequence. A complete line that cannot be read is skipped and reported, never fatal.
		this.unreadable = [];
		const durableBytes = bytes.lastIndexOf(0x0a) + 1;
		const text = bytes.subarray(0, durableBytes).toString("utf8");
		for (const [number, line] of text.split("\n").entries()) {
			if (!line) continue;
			let record: SidecarRecord;
			try { record = JSON.parse(line) as SidecarRecord; }
			catch (error) { this.unreadable.push(`line ${number + 1}: ${error instanceof Error ? error.message : String(error)}`); continue; }
			if (!record || typeof record !== "object" || Array.isArray(record) ||
				JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(recordKeys) ||
				typeof record.id !== "string" || typeof record.sessionId !== "string" || !types.includes(record.type) ||
				!Number.isFinite(record.at) || !record.data || typeof record.data !== "object" || Array.isArray(record.data)) {
				this.unreadable.push(`line ${number + 1}: not a Mom record`);
				continue;
			}
			if (record.sessionId === this.sessionId) this.records.push(record);
		}
		return this.records;
	}

	async append(type: SidecarWriteType, data: Record<string, any>, id: string = randomUUID(), beforeWrite?: () => Promise<void>): Promise<SidecarRecord> {
		const session = this.sessionFile();
		if (!session) throw new Error("Mom needs a persisted session file for her state; in-memory sessions keep none.");
		const file = sidecarFile(session);
		if (!this.detached && this.seen?.file === file && await this.io.identity(file) !== this.seen.identity) this.detached = true;
		if (this.detached) throw new Error(`Mom's sidecar was deleted or replaced outside this session (${file}). This instance will not write its in-memory map back; /reload rebuilds from the session transcript.`);
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
