/**
 * Delegation's own controls, in the `delegate` section of `pi-delegate.json`. Each is read when it
 * applies (a delegate call, a turn start), so a change in the settings panel takes effect on the next
 * call without a reload.
 */
import { readSettings, settingsFile, writeSettings } from "./settings-file.ts";

/**
 * - `opportunistic`: delegate for context isolation, parallelism, or a model-tier switch; otherwise do the work.
 * - `orchestrator`: the root session delegates every task and stays free to talk; it cannot edit or write files.
 * - `off`: the root session does not get the delegation tools.
 */
export const DELEGATION_MODES = ["opportunistic", "orchestrator", "off"] as const;
export type DelegationMode = typeof DELEGATION_MODES[number];
/**
 * How a role's `model:` list is resolved: the first entry with credentials (`available`), or the first
 * entry that is also in Pi's scoped models (`--models` / `enabledModels`) when a scope is set (`scoped`).
 */
export const MODEL_PICKING = ["scoped", "available"] as const;
export type ModelPicking = typeof MODEL_PICKING[number];

export interface DelegateSettings {
	mode: DelegationMode;
	/** The deepest a child may run. The root session is depth 0, its children depth 1. */
	maxDepth: number;
	/** Unsettled runs of both backends, across the whole delegation tree. 0 is no limit. */
	maxConcurrent: number;
	modelPicking: ModelPicking;
}

export const DEFAULT_DELEGATE_SETTINGS: DelegateSettings = { mode: "opportunistic", maxDepth: 3, maxConcurrent: 16, modelPicking: "scoped" };
export const MAX_DEPTH_RANGE = { min: 1, max: 8 } as const;
export const MAX_CONCURRENT_RANGE = { min: 0, max: 64 } as const;

const int = (value: unknown, { min, max }: { min: number; max: number }, fallback: number) =>
	typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;

/** A section that is missing or malformed field by field reads as its default for that field. */
export function normalizeDelegateSettings(value: unknown): DelegateSettings {
	const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
	const d = DEFAULT_DELEGATE_SETTINGS;
	return {
		mode: DELEGATION_MODES.includes(raw.mode as DelegationMode) ? raw.mode as DelegationMode : d.mode,
		maxDepth: int(raw.maxDepth, MAX_DEPTH_RANGE, d.maxDepth),
		maxConcurrent: int(raw.maxConcurrent, MAX_CONCURRENT_RANGE, d.maxConcurrent),
		modelPicking: MODEL_PICKING.includes(raw.modelPicking as ModelPicking) ? raw.modelPicking as ModelPicking : d.modelPicking,
	};
}

export function readDelegateSettings(file: string = settingsFile()): DelegateSettings {
	return normalizeDelegateSettings(readSettings(file).delegate);
}

/** Validates the change before writing, so the file never holds a value this module would ignore. */
export async function saveDelegateSettings(change: Partial<DelegateSettings>, file: string = settingsFile()): Promise<DelegateSettings> {
	const next = normalizeDelegateSettings({ ...readDelegateSettings(file), ...change });
	for (const [key, value] of Object.entries(change)) {
		if (next[key as keyof DelegateSettings] !== value) throw new Error(`invalid ${key}: ${JSON.stringify(value)}`);
	}
	const written = await writeSettings({ delegate: { ...change } }, file);
	return normalizeDelegateSettings(written.delegate);
}

export interface ModelCandidate { provider: string; id: string }
const key = (m: ModelCandidate) => `${m.provider}/${m.id}`;

/**
 * The first entry of a role's ordered `model:` list the session can use. An entry is `provider/id` (exact
 * offering) or a bare `id` (any provider's offering of it, in the registry's order), with an optional
 * `:thinking`. Credentials are always required (`available`); with `scoped` picking and a non-empty scope,
 * the offering must also be in the scope. An empty scope means Pi has none configured: every available
 * model is in it, as Pi itself treats it. Returns why each skipped entry was skipped, for the run's report.
 */
export function pickModel<M extends ModelCandidate>(entries: readonly string[], available: readonly M[], scoped: readonly M[], picking: ModelPicking):
	{ model: M; entry: string; thinking?: string; skipped: string[] } | { model?: undefined; skipped: string[] } {
	const scope = picking === "scoped" && scoped.length ? new Set(scoped.map(key)) : undefined;
	const skipped: string[] = [];
	for (const entry of entries) {
		const colon = entry.lastIndexOf(":");
		const spec = colon > 0 && !entry.slice(colon + 1).includes("/") ? entry.slice(0, colon) : entry;
		const thinking = spec === entry ? undefined : entry.slice(colon + 1);
		const slash = spec.indexOf("/");
		const matching = available.filter((m) => slash > 0 ? m.provider === spec.slice(0, slash) && m.id === spec.slice(slash + 1) : m.id === spec);
		if (!matching.length) { skipped.push(`${entry}: no credentials or not in the catalog`); continue; }
		const allowed = scope ? matching.filter((m) => scope.has(key(m))) : matching;
		if (!allowed.length) { skipped.push(`${entry}: not in Pi's scoped models`); continue; }
		return { model: allowed[0], entry, ...(thinking ? { thinking } : {}), skipped };
	}
	return { skipped };
}
