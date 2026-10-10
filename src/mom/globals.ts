/**
 * Mom's controls are global: a section of the pi-delegate settings file in Pi's agent directory, not a
 * record inside each session's `.mom` sidecar. A mode, model or decision model the user saves is a setting of Mom's, not a property
 * of the transcript it happened to be saved in — saving it in one session must hold in the next one,
 * and it must save whether or not Oven is running.
 *
 * The session's own older control records are still read, underneath this file: a value saved before
 * this existed keeps working until the user saves again.
 */
import { readSettings, settingsFile, writeSettings } from "../settings-file.ts";
import { modeFor } from "./modes.ts";
import { PROCESS_RISK_CLASSES, type ProcessRiskClass } from "./process-health.ts";
import { CONTROL_KEYS, type ControlKey } from "./sidecar.ts";

/** Every durable Mom control. `hush` is deliberately absent: it is this session's quiet toggle. */
export type MomGlobals = Partial<Record<ControlKey, boolean | string | ProcessRiskClass[]>>;

const PROVIDER_MODEL = /^[\w.-]+\/[\w./:-]+$/;

/**
 * Keep only the values the sidecar would have accepted. A bad field is dropped rather than thrown on,
 * so one malformed value does not prevent a session from loading the other controls.
 */
export function validGlobals(value: unknown): MomGlobals {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const source = value as Record<string, unknown>, cleaned: MomGlobals = {};
	if (typeof source.enabled === "boolean") cleaned.enabled = source.enabled;
	if (typeof source.inject === "boolean") cleaned.inject = source.inject;
	if (Array.isArray(source.nudgedClasses) && source.nudgedClasses.every(entry => PROCESS_RISK_CLASSES.includes(entry as never)))
		cleaned.nudgedClasses = [...new Set(source.nudgedClasses as ProcessRiskClass[])];
	if (typeof source.mode === "string") { try { cleaned.mode = modeFor(source.mode).name; } catch { /* an undeclared mode is not a mode */ } }
	// An empty model means "the configured default"; an empty decision model means "no decision model".
	if (typeof source.model === "string" && (source.model.trim() === "" || PROVIDER_MODEL.test(source.model.trim()))) cleaned.model = source.model.trim();
	if (typeof source.decider === "string" && (source.decider.trim() === "" || PROVIDER_MODEL.test(source.decider.trim()))) cleaned.decider = source.decider.trim();
	return cleaned;
}

/** Mom's section of the pi-delegate settings file. */
export function readMomGlobals(file: string = settingsFile()): MomGlobals {
	return validGlobals(readSettings(file).mom);
}

/** Save one change, merged over what is there. Written atomically before anything hears about it, so a
 *  setting survives an unreachable or failing slice. */
export async function writeMomGlobals(patch: MomGlobals, file: string = settingsFile()): Promise<MomGlobals> {
	const written = await writeSettings({ mom: validGlobals(patch) }, file);
	return validGlobals(written.mom);
}

/** Global values win; a session's own saved controls remain underneath (see `loadState`). */
export function mergeGlobals(globals: MomGlobals, session: MomGlobals): MomGlobals {
	return { ...session, ...globals };
}
