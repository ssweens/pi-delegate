import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import writeFileAtomic from "write-file-atomic";
import { DelegateError } from "./backend.ts";
import { ownerAlive, processIdentity } from "./util/process.ts";

const SUBSESSION_DIR = "subsessions";
const STORAGE_MARKER = ".pi-delegate-storage.json";
export interface SessionStorageInfo { root: string; customSessionDir: boolean }
export interface SessionDirectoryProvider { getCwd(): string; getSessionDir(): string; usesDefaultSessionDir?(): boolean }

/** Resolve Pi's configured global session root, including custom --session-dir and nested child sessions. */
export function sessionStorageInfo(cwd: string, sessionDir: string, usesDefaultSessionDir?: boolean): SessionStorageInfo {
	const dir = realpathSync(sessionDir);
	const marker = join(dir, STORAGE_MARKER);
	if (existsSync(marker)) {
		const saved = readRecord<SessionStorageInfo & { version: number }>(marker);
		if (!saved || saved.version !== 1 || typeof saved.root !== "string" || typeof saved.customSessionDir !== "boolean")
			throw new Error(`Invalid pi-delegate session storage marker: ${marker}`);
		return { root: saved.root, customSessionDir: saved.customSessionDir };
	}
	if (usesDefaultSessionDir === true) return { root: dirname(dir), customSessionDir: false };
	if (usesDefaultSessionDir === false) return { root: dir, customSessionDir: true };
	const defaultSessionDir = SessionManager.create(cwd).getSessionDir();
	if (resolve(defaultSessionDir) === dir) return { root: dirname(dir), customSessionDir: false };
	return { root: dir, customSessionDir: true };
}

export function sessionStorageInfoForManager(manager: SessionDirectoryProvider): SessionStorageInfo {
	return sessionStorageInfo(manager.getCwd(), manager.getSessionDir(), manager.usesDefaultSessionDir?.());
}

export function storagePath(cwd: string, sessionDir: string, usesDefaultSessionDir?: boolean): string {
	return join(sessionStorageInfo(cwd, sessionDir, usesDefaultSessionDir).root, SUBSESSION_DIR);
}

export function storagePathForManager(manager: SessionDirectoryProvider): string {
	return join(sessionStorageInfoForManager(manager).root, SUBSESSION_DIR);
}

export function storageDir(cwd: string, sessionDir: string, usesDefaultSessionDir?: boolean): string {
	const info = sessionStorageInfo(cwd, sessionDir, usesDefaultSessionDir);
	const dir = join(info.root, SUBSESSION_DIR);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const marker = join(dir, STORAGE_MARKER);
	if (!existsSync(marker)) writeRecord(marker, { version: 1, ...info });
	return dir;
}

export function storageDirForManager(manager: SessionDirectoryProvider): string {
	return storageDir(manager.getCwd(), manager.getSessionDir(), manager.usesDefaultSessionDir?.());
}

/** A missing record is different from a corrupt or unreadable one. Never overwrite the latter. */
export function readRecord<T>(path: string): T | undefined {
	try { return JSON.parse(readFileSync(path, "utf8")) as T; }
	catch (error: any) { if (error.code === "ENOENT") return undefined; throw error; }
}

/** Replace the record atomically (temp file, fsync, rename), private to the user. Synchronous: callers save mid-event. */
export function writeRecord(path: string, value: unknown): void {
	const data = `${JSON.stringify(value)}\n`;
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileAtomic.sync(path, data, { mode: 0o600 });
}

/**
 * Ownership is per child run, not per parent. Any number of Pi processes may share a
 * directory or even a parent session: each writes only the runs it owns. A run whose owner
 * process is alive is read-only elsewhere; a run whose owner died is adopted by whoever
 * restores it. The owner is this process's one identity (util/process.ts), stable across reloads.
 */
export interface RunOwner { ownerPid: number; ownerHost: string; ownerToken: string }

let owner: RunOwner | undefined;
/** This process as a run record names its owner. The same object for the life of the process. */
export function processOwner(): RunOwner {
	const me = processIdentity();
	if (owner?.ownerToken !== me.token) owner = { ownerPid: me.pid, ownerHost: me.host, ownerToken: me.token };
	return owner;
}

/** True when another live process owns the run. Unowned records, ours and dead owners' are not "elsewhere". */
export function ownedElsewhere(record: Partial<RunOwner>): boolean {
	if (!record.ownerToken || record.ownerToken === processOwner().ownerToken) return false;
	return ownerAlive({ pid: record.ownerPid, host: record.ownerHost, token: record.ownerToken });
}

/** Give up a run's ownership, so the next process to open its parent adopts it. */
export function releaseOwner(run: Partial<RunOwner>): void {
	delete run.ownerPid; delete run.ownerHost; delete run.ownerToken;
}

/** Acting on a run another live process owns. */
export function ownedElsewhereError(run: { id: string } & Partial<RunOwner>): DelegateError {
	return new DelegateError("RUN_OWNED_ELSEWHERE", `${run.id} is owned by another live Pi process (pid ${run.ownerPid} on ${run.ownerHost}); it is read-only here. Use that session, or wait for it to exit.`);
}

// --- Run records, for both backends ----------------------------------------------------------

/** What every run record carries: its run, its parent, and the process that owns it. */
export interface OwnedRecord extends Partial<RunOwner> { id: string; ownerKey: string }
/** A run restored from its record. `foreign`: another live process owns it, so it is read-only here. */
export interface StoredRun extends OwnedRecord { foreign?: boolean }

export interface RunStoreOptions<R extends StoredRun, F extends OwnedRecord> {
	/** Fields every record of this store carries and must carry (acp: backend), besides version and savedAt. */
	tag?: Record<string, string>;
	/** Whether a record's own fields are what a run needs. Its version, tag, id and parent are checked already. */
	valid(record: F): boolean;
	/** The run a valid record restores to: its in-process fields added, older record shapes upgraded. */
	revive(record: F, path: string): R;
	/** This process adopted the run (its owner died, or it was ours before a reload): settle what was running when its record was saved. */
	recover(run: R, savedAt: number): void;
	/** The record of the run: the run without its in-process fields. */
	persisted(run: R): object;
	/**
	 * Saving a run another live process owns. "throw" (pi): every write path is ours to guard. "skip" (acp): read-only
	 * paths (an observation's cursor) save as they go, and a foreign run's record is its owner's to write.
	 */
	foreignSave: "throw" | "skip";
}

/**
 * One backend's run records: one JSON file per run, written whole and atomically, restored without running
 * anything. Restoring decides ownership: another live process's run is read-only here, any other is adopted
 * and recovered from whatever its last owner left running.
 */
export class RunStore<R extends StoredRun, F extends OwnedRecord> {
	constructor(private readonly options: RunStoreOptions<R, F>) {}

	/** A run's record file in `dir`. */
	static recordPath(dir: string, id: string): string { return join(dir, `${encodeURIComponent(id)}.json`); }

	/** Every record file in `dir`, in name order; none when it does not exist. */
	static recordFiles(dir: string): string[] {
		return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")).sort().map((name) => join(dir, name)) : [];
	}

	/** Restore one record of `ownerKey`'s, adopting it unless another live process owns it. A missing or invalid record throws. */
	load(path: string, ownerKey: string): R {
		const record = readRecord<F & { version: unknown; savedAt: number } & Record<string, unknown>>(path);
		const tag = this.options.tag ?? {};
		if (!record || record.version !== 1 || record.ownerKey !== ownerKey || typeof record.id !== "string" ||
			Object.entries(tag).some(([key, value]) => record[key] !== value) || !this.options.valid(record)) {
			throw new Error(`Cannot restore delegate metadata: ${path}`);
		}
		const { version: _version, savedAt, ...fields } = record;
		for (const key of Object.keys(tag)) delete (fields as Record<string, unknown>)[key];
		const run = this.options.revive(fields as unknown as F, path);
		if (ownedElsewhere(run)) { run.foreign = true; return run; }
		// Unowned, ours from before a reload, or its owner died: this process adopts it.
		Object.assign(run, processOwner());
		this.options.recover(run, savedAt);
		return run;
	}

	save(run: R, path: string): void {
		if (run.foreign) {
			if (this.options.foreignSave === "skip") return;
			throw ownedElsewhereError(run);
		}
		writeRecord(path, { ...this.options.persisted(run), ...this.options.tag, version: 1, savedAt: Date.now() });
	}
}
