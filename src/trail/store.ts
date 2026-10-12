/**
 * Mom's trail on disk: `session.trail` beside `session.jsonl`, one JSON record per line, append-only.
 * Same discipline as the `.mom` sidecar (src/mom/sidecar.ts): the lead and Mom's tools in oven both
 * append, so every write takes the file lock, finishes a torn last line first and fsyncs; on read only
 * complete lines count and an unreadable one is skipped and reported, never fatal. The IO is copied
 * rather than shared because the sidecar keeps it private and the two files must stay independent.
 */
import { open, readFile, stat } from "node:fs/promises";
import lockfile from "proper-lockfile";
import { isStep, WAYPOINT_KINDS, type Strike, type Trail, type TrailRecord, type Waypoint, type WaypointKind } from "./types.ts";

// Pi's session lister scans every *.jsonl file in the session directory; the trail must not match.
export const trailFile = (sessionFile: string) => sessionFile.replace(/\.jsonl$/, "") + ".trail";

export interface TrailIO {
	/** Stable file identity (device:inode), or undefined when the file does not exist. */
	identity(file: string): Promise<string | undefined>;
	read(file: string): Promise<Buffer>;
	/** Append one record durably, serialized with every other writer of the file. */
	append(file: string, data: string, beforeWrite?: () => Promise<void>): Promise<void>;
}

const nodeIO: TrailIO = {
	identity: (file) => stat(file).then(info => `${info.dev}:${info.ino}`, (error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	}),
	read: (file) => readFile(file),
	append: async (file, data, beforeWrite) => {
		const release = await lockfile.lock(file, { realpath: false, stale: 15_000, retries: { retries: 40, minTimeout: 25, maxTimeout: 250 } });
		try {
			await beforeWrite?.();
			const handle = await open(file, "a+");
			try {
				// A crashed writer may have left the last line open: finish it so a torn record stays one skippable
				// line and never merges with this one.
				const { size } = await handle.stat();
				let prefix = "";
				if (size > 0) { const last = Buffer.alloc(1); await handle.read(last, 0, 1, size - 1); if (last[0] !== 0x0a) prefix = "\n"; }
				await handle.appendFile(prefix + data);
				await handle.sync();
			} finally { await handle.close(); }
		} finally { await release(); }
	},
};

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isParent = (value: unknown): value is string | null => value === null || typeof value === "string";
const optionalString = (value: unknown): value is string | undefined => value === undefined || typeof value === "string";
const isRefs = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every(ref => typeof ref === "string" && ref.length > 0);

/** The record a line holds, rebuilt from its known fields so a stray key never reaches a projection; or why it is not one. */
function readRecord(value: unknown): TrailRecord | string {
	if (!isObject(value)) return "not a trail record";
	if (typeof value.id !== "string" || typeof value.sessionId !== "string" || typeof value.at !== "number" || !Number.isFinite(value.at) || !isParent(value.parent)) return "not a trail record";
	const base = { id: value.id, sessionId: value.sessionId, at: value.at, parent: value.parent };
	if (value.type === "waypoint") {
		if (!WAYPOINT_KINDS.includes(value.kind as WaypointKind)) return `unknown waypoint kind ${JSON.stringify(value.kind)}`;
		if (typeof value.line !== "string" || typeof value.caption !== "string" || !isRefs(value.refs)) return "waypoint lacks line, caption or refs";
		if (value.by !== "mom" && value.by !== "user") return "waypoint lacks a writer";
		if (!optionalString(value.closes) || !optionalString(value.supersedes)) return "waypoint links are not ids";
		const waypoint: TrailRecord = { type: "waypoint", ...base, kind: value.kind as WaypointKind, line: value.line, refs: [...value.refs], caption: value.caption, by: value.by };
		if (value.closes !== undefined) waypoint.closes = value.closes;
		if (value.supersedes !== undefined) waypoint.supersedes = value.supersedes;
		if (typeof value.anchor === "string" && value.anchor) waypoint.anchor = value.anchor;
		if (value.step === true) waypoint.step = true;
		return waypoint;
	}
	if (value.type === "strike") {
		if (typeof value.target !== "string" || !optionalString(value.reason)) return "strike lacks a target";
		const strike: TrailRecord = { type: "strike", ...base, target: value.target };
		if (value.reason !== undefined) strike.reason = value.reason;
		return strike;
	}
	return `unknown record type ${JSON.stringify(value.type)}`;
}

export class TrailStore {
	private records?: TrailRecord[];
	private unreadable: string[] = [];
	/** Identity of the file the cache was read from; a replaced file means the cache lies. */
	private seen?: string;
	constructor(private readonly sessionFile: () => string | undefined, private readonly sessionId: string,
		private readonly io: TrailIO = nodeIO) {}

	/** Forget what was read: Mom's tools in oven append to the same file. */
	invalidate(): void { this.records = undefined; }

	/** Why each unreadable line of the last load was skipped. */
	get skipped(): readonly string[] { return this.unreadable; }

	/** This session's records, oldest first; empty until the file exists. Cached until invalidate(). */
	async load(): Promise<TrailRecord[]> {
		if (this.records) return this.records;
		this.records = [];
		const session = this.sessionFile();
		if (!session) return this.records;
		const file = trailFile(session);
		let bytes: Buffer = Buffer.alloc(0);
		try { bytes = await this.io.read(file); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		this.seen = await this.io.identity(file);
		// Only complete lines count, found in bytes not decoded characters: a torn or still-written tail may end in
		// the middle of a UTF-8 sequence.
		this.unreadable = [];
		const text = bytes.subarray(0, bytes.lastIndexOf(0x0a) + 1).toString("utf8");
		for (const [number, line] of text.split("\n").entries()) {
			if (!line) continue;
			let parsed: unknown;
			try { parsed = JSON.parse(line); }
			catch (error) { this.unreadable.push(`line ${number + 1}: ${error instanceof Error ? error.message : String(error)}`); continue; }
			const record = readRecord(parsed);
			if (typeof record === "string") { this.unreadable.push(`line ${number + 1}: ${record}`); continue; }
			if (record.sessionId === this.sessionId) this.records.push(record);
		}
		return this.records;
	}

	/** Appends a waypoint; one whose id is already on the trail is returned as recorded (retry idempotency). */
	async appendWaypoint(waypoint: Waypoint): Promise<Waypoint> {
		const record = await this.append({ type: "waypoint", ...waypoint });
		const { type: _type, ...stored } = record as { type: "waypoint" } & Waypoint;
		return stored;
	}

	async appendStrike(strike: Strike): Promise<Strike> {
		const record = await this.append({ type: "strike", ...strike });
		const { type: _type, ...stored } = record as { type: "strike" } & Strike;
		return stored;
	}

	private async append(record: TrailRecord): Promise<TrailRecord> {
		const session = this.sessionFile();
		if (!session) throw new Error("Mom's trail needs a persisted session file; in-memory sessions keep none.");
		const file = trailFile(session);
		if (record.sessionId !== this.sessionId) throw new Error(`Trail record ${record.id} belongs to session ${record.sessionId}, not ${this.sessionId}`);
		try {
			// Another writer may have replaced or removed the file since it was read: re-read before trusting the cache.
			if (this.records && await this.io.identity(file) !== this.seen) this.records = undefined;
			await this.load();
			const existing = this.records!.find(item => item.id === record.id);
			if (existing) return existing;
			await this.io.append(file, JSON.stringify(record) + "\n");
			if (!this.seen) this.seen = await this.io.identity(file);
			this.records!.push(record);
			return record;
		} catch (error) {
			// The filesystem may have accepted only a prefix before rejecting. Forget the cache so the next
			// append re-reads; the next record then starts on its own line.
			this.records = undefined;
			throw error;
		}
	}
}

/**
 * One branch's trail: a record whose parent is null or on `branch` belongs to it. Struck waypoints move
 * to `struck`; a strike that names nothing on this trail is ignored.
 * Order is transcript order, not file order: Mom backfills older history after newer, so each waypoint sorts
 * by its position on `branch` (iterated root to leaf): its `anchor`, else the earliest entry its refs
 * (`<stream>:<entryId>[:b<n>]`) name on the branch, else the position of the record before it in the file.
 * The sort is stable, so ties keep file order.
 * Steps (isStep, decided by kind on every read, so older files are sorted the same way) stay out of
 * `waypoints` and appear only in `entries`.
 */
export function trailFor(records: readonly TrailRecord[], branch: ReadonlySet<string>): Trail {
	const onBranch = records.filter(record => record.parent === null || branch.has(record.parent));
	const index = new Map<string, number>();
	for (const id of branch) index.set(id, index.size);
	const positionOf = (w: Waypoint): number | undefined => {
		const anchored = w.anchor === undefined ? undefined : index.get(w.anchor);
		if (anchored !== undefined) return anchored;
		let best: number | undefined;
		for (const ref of w.refs) {
			const at = index.get(ref.split(":")[1] ?? "");
			if (at !== undefined && (best === undefined || at < best)) best = at;
		}
		return best;
	};
	const waypoints = new Map<string, Waypoint>();
	const position = new Map<string, number>();
	let previous = -1;
	for (const record of onBranch) {
		if (record.type !== "waypoint" || waypoints.has(record.id)) continue;
		const { type: _type, ...waypoint } = record;
		waypoints.set(record.id, waypoint);
		previous = positionOf(waypoint) ?? previous;
		position.set(record.id, previous);
	}
	const strikes = new Map<string, Strike>();
	for (const record of onBranch) {
		if (record.type !== "strike" || !waypoints.has(record.target) || strikes.has(record.target)) continue;
		const { type: _type, ...strike } = record;
		strikes.set(record.target, strike);
	}
	const ordered = [...waypoints.values()].sort((a, b) => position.get(a.id)! - position.get(b.id)!);
	const trail: Trail = { waypoints: [], struck: [] };
	const entries: Waypoint[] = [];
	for (const waypoint of ordered) {
		const strike = strikes.get(waypoint.id);
		if (strike) { trail.struck.push({ waypoint, strike }); continue; }
		entries.push(waypoint);
		if (!isStep(waypoint)) trail.waypoints.push(waypoint);
	}
	if (entries.length !== trail.waypoints.length) trail.entries = entries;
	return trail;
}
