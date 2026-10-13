/**
 * Path's trail on disk: `session.trail` beside `session.jsonl`, one JSON record per line, append-only.
 * Same discipline as the `.mom` sidecar: the lead and Path's tools in oven both append through the shared JSONL IO
 * (src/util/jsonl.ts), which locks, finishes a torn last line and fsyncs; on read only complete lines count and an
 * unreadable one is skipped and reported, never fatal.
 */
import { entryIdOf } from "../util/ref.ts";
import { nodeJsonlIO, parseJsonLines, readIfExists, siblingFile, type JsonlIO } from "../util/jsonl.ts";
import { isRecord } from "../util/text.ts";
import { isStep, WAYPOINT_KINDS, type Retitle, type Strike, type Trail, type TrailRecord, type Waypoint, type WaypointKind } from "./types.ts";

export const trailFile = (sessionFile: string) => siblingFile(sessionFile, "trail");

const isParent = (value: unknown): value is string | null => value === null || typeof value === "string";
const optionalString = (value: unknown): value is string | undefined => value === undefined || typeof value === "string";
const isRefs = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every(ref => typeof ref === "string" && ref.length > 0);

/** The record a line holds, rebuilt from its known fields so a stray key never reaches a projection; or why it is not one. */
function readRecord(value: unknown): TrailRecord | string {
	if (!isRecord(value)) return "not a trail record";
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
		if (typeof value.title === "string" && value.title) waypoint.title = value.title;
		if (typeof value.from === "string" && value.from) waypoint.from = value.from;
		if (typeof value.anchor === "string" && value.anchor) waypoint.anchor = value.anchor;
		if (value.step === true) waypoint.step = true;
		return waypoint;
	}
	if (value.type === "title") {
		if (typeof value.target !== "string" || typeof value.title !== "string" || !value.title) return "title lacks a target or text";
		return { type: "title", ...base, target: value.target, title: value.title };
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
		private readonly io: JsonlIO = nodeJsonlIO) {}

	/** Forget what was read: Path's tools in oven append to the same file. */
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
		const bytes = await readIfExists(this.io, file);
		this.seen = await this.io.identity(file);
		const parsed = parseJsonLines(bytes);
		this.unreadable = parsed.unreadable;
		for (const { number, value } of parsed.values) {
			const record = readRecord(value);
			if (typeof record === "string") { this.unreadable.push(`line ${number}: ${record}`); continue; }
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

	async appendTitle(title: Retitle): Promise<void> { await this.append({ type: "title", ...title }); }

	async appendStrike(strike: Strike): Promise<Strike> {
		const record = await this.append({ type: "strike", ...strike });
		const { type: _type, ...stored } = record as { type: "strike" } & Strike;
		return stored;
	}

	private async append(record: TrailRecord): Promise<TrailRecord> {
		const session = this.sessionFile();
		if (!session) throw new Error("Path's trail needs a persisted session file; in-memory sessions keep none.");
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
 * Order is transcript order, not file order: Path backfills older history after newer, so each waypoint sorts
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
			const at = index.get(entryIdOf(ref) ?? "");
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
	// A later title record names a waypoint anew (a refresh); the latest wins over its own title.
	for (const record of onBranch) {
		if (record.type !== "title") continue;
		const target = waypoints.get(record.target);
		if (target) waypoints.set(target.id, { ...target, title: record.title });
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
