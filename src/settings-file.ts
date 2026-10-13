/**
 * Every pi-delegate setting, in one file: `<agentDir>/pi-delegate.json` (mode 0600, written atomically).
 *
 *   delegate  — delegation's controls: mode, depth and concurrency limits, model picking (delegate-settings.ts)
 *   todo      — todo controls: automatic incomplete-work reminders (todo-settings.ts)
 *   path      — Path's controls: mode, model, decision model, tracking, continuity, suggestion classes
 *   mom       — Path's former section name: still read (and merged under `path`), never written
 *   defaults  — the approved default model per role, with the catalog it was approved against
 *   ratings   — researched quality ratings, per exact `provider/id`
 *
 * One file for the package's settings, so there is one place to look and one place to edit. The
 * append-only run log stays its own file (`delegate-runs.jsonl`): it is one JSON line per run, not a
 * setting, and folding an ever-growing log into this file would rewrite the settings on every run.
 *
 * `defaults` and `ratings` lived in their own files before this (`delegate-models.json`,
 * `delegate-ratings.json`), so those two are still read until the first write folds them in. Path's
 * controls had no file of their own worth reading: they were sidecar records, and a session's records
 * are still read underneath by `loadState`.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { SHORT_LOCK } from "./util/jsonl.ts";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { isRecord } from "./util/text.ts";
import writeFileAtomic from "write-file-atomic";

/** One approved role default, as `delegate_ctl approve` records it: `spec` is `provider/id[:thinking]`. */
export interface ApprovedDefault { spec: string; reason?: string; approvedAt: number; cost?: { input: number; output: number } }
export interface RatingEntry { score: number; source: string; note?: string }
export interface SettingsFile {
	/** Delegation's controls, validated by delegate-settings.ts. */
	delegate?: Record<string, unknown>;
	/** Path's controls, validated by its own vocabulary (src/mom/globals.ts). */
	mom?: Record<string, unknown>;
	/** Path's controls as saved now; `mom` is the former name of this section. */
	path?: Record<string, unknown>;
	/** Todo controls, validated by todo-settings.ts. */
	todo?: Record<string, unknown>;
	defaults?: { approved?: Record<string, ApprovedDefault>; catalogAtApproval?: string[] };
	ratings?: { updatedAt?: number; entries?: Record<string, RatingEntry> };
}

export const settingsFile = (agentDir: string = getAgentDir()): string => join(agentDir, "pi-delegate.json");
/** Where `defaults` and `ratings` lived before this file existed. Read only. */
export const legacySettings = (agentDir: string = getAgentDir()) => ({
	defaults: join(agentDir, "delegate-models.json"),
	ratings: join(agentDir, "delegate-ratings.json"),
});

/** Never throws: a settings file that cannot be read is read as empty, and a section keeps whatever
 *  shape it has (each caller validates its own section, as it always did). */
export function readSettings(file: string = settingsFile()): SettingsFile {
	try {
		const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		return {
			...(isRecord(value.delegate) ? { delegate: value.delegate } : {}),
			...(isRecord(value.mom) ? { mom: value.mom } : {}),
			...(isRecord(value.path) ? { path: value.path } : {}),
			...(isRecord(value.todo) ? { todo: value.todo } : {}),
			...(isRecord(value.defaults) ? { defaults: value.defaults as SettingsFile["defaults"] } : {}),
			...(isRecord(value.ratings) ? { ratings: value.ratings as SettingsFile["ratings"] } : {}),
		};
	} catch { return {}; }
}

/** The older file for one of the two sections that used to have one, read only when this file has no
 *  such section — so a default approved or a rating saved before this file existed still applies. */
export function readLegacySection<K extends "defaults" | "ratings">(section: K, agentDir?: string): SettingsFile[K] | undefined {
	try { return JSON.parse(readFileSync(legacySettings(agentDir)[section], "utf8")) as SettingsFile[K]; }
	catch { return undefined; }
}

/** Merge one write into the file: sections merge key-wise and inner maps merge entry-wise, so two
 *  writers that never see each other's change (a Path setting, an approved role) cannot drop it. */
export function mergeSettings(current: SettingsFile, patch: SettingsFile): SettingsFile {
	const next: SettingsFile = { ...current };
	if (patch.delegate) next.delegate = { ...current.delegate, ...patch.delegate };
	if (patch.mom) next.mom = { ...current.mom, ...patch.mom };
	if (patch.path) next.path = { ...current.path, ...patch.path };
	if (patch.todo) next.todo = { ...current.todo, ...patch.todo };
	if (patch.defaults) next.defaults = { ...current.defaults, ...patch.defaults,
		approved: { ...current.defaults?.approved, ...patch.defaults.approved },
		...(patch.defaults.catalogAtApproval ? { catalogAtApproval: patch.defaults.catalogAtApproval } : {}) };
	if (patch.ratings) next.ratings = { ...current.ratings, ...patch.ratings,
		entries: { ...current.ratings?.entries, ...patch.ratings.entries } };
	return next;
}

export async function writeSettings(patch: SettingsFile, file: string = settingsFile()): Promise<SettingsFile> {
	mkdirSync(dirname(file), { recursive: true });
	// Atomic replacement protects readers from partial JSON; the lock protects this read/merge/write
	// transaction from concurrent Path, default, and rating saves.
	const release = await lockfile.lock(file, SHORT_LOCK);
	try {
		// Fold in whatever a legacy file still holds for a section this file does not have yet, before the
		// patch is merged: otherwise the first write would create that section with only its own change, and
		// a read that prefers this file would quietly drop everything the legacy file had.
		const current = readSettings(file), seeded: SettingsFile = { ...current };
		for (const section of ["defaults", "ratings"] as const) {
			if (seeded[section]) continue;
			const legacy = readLegacySection(section, dirname(file));
			if (legacy) seeded[section] = legacy;
		}
		const next = mergeSettings(seeded, patch);
		await writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		return next;
	} finally { await release(); }
}

/**
 * A validated section (`delegate`, `todo`): `read` normalizes what the file holds; `save` validates a change
 * against `normalize` before writing, so the file never holds a value the module would ignore.
 */
export function defineSection<T extends object>(name: "delegate" | "todo", normalize: (value: unknown) => T) {
	const read = (file: string = settingsFile()): T => normalize(readSettings(file)[name]);
	const save = async (change: Partial<T>, file: string = settingsFile()): Promise<T> => {
		const next = normalize({ ...read(file), ...change });
		for (const [key, value] of Object.entries(change)) {
			if (next[key as keyof T] !== value) throw new Error(`invalid ${key}: ${JSON.stringify(value)}`);
		}
		const written = await writeSettings({ [name]: { ...change } }, file);
		return normalize(written[name]);
	};
	return { read, save };
}
