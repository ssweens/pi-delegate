/** Away recap controls in the `recap` section of pi-delegate.json. */
import { defineSection } from "./settings-file.ts";
import { isRecord } from "./util/text.ts";

export interface RecapSettings {
	enabled: boolean;
	idleThresholdMs: number;
}

export const DEFAULT_RECAP_SETTINGS: RecapSettings = { enabled: true, idleThresholdMs: 5 * 60 * 1000 };
export const RECAP_IDLE_RANGE = { min: 1000, max: 24 * 60 * 60 * 1000 } as const;
export const RECAP_THRESHOLD_OPTIONS = [30_000, 60_000, 3 * 60 * 1000, 5 * 60 * 1000, 10 * 60 * 1000, 30 * 60 * 1000] as const;

export function formatRecapThreshold(milliseconds: number): string {
	return milliseconds % 60_000 === 0 ? `${milliseconds / 60_000}m` : `${Math.round(milliseconds / 1000)}s`;
}

export function normalizeRecapSettings(value: unknown): RecapSettings {
	const raw = isRecord(value) ? value : {};
	const threshold = raw.idleThresholdMs;
	return {
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_RECAP_SETTINGS.enabled,
		idleThresholdMs: typeof threshold === "number" && Number.isInteger(threshold) && threshold >= RECAP_IDLE_RANGE.min && threshold <= RECAP_IDLE_RANGE.max
			? threshold : DEFAULT_RECAP_SETTINGS.idleThresholdMs,
	};
}

const section = defineSection("recap", normalizeRecapSettings);
export const readRecapSettings = section.read;
/** Validates before writing so the file never holds a value this module ignores. */
export const saveRecapSettings = section.save;
