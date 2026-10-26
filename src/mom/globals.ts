/**
 * Path's controls are global: a section of the pi-delegate settings file in Pi's agent directory, not a
 * record inside each session's `.mom` sidecar. A mode, model or decision model the user saves is a setting of Path's, not a property
 * of the transcript it happened to be saved in — saving it in one session must hold in the next one,
 * and it must save whether or not Oven is running.
 *
 * The session's own older control records are still read, underneath this file: a value saved before
 * this existed keeps working until the user saves again.
 */
import { isModelRefOrEmpty } from "../model-ref.ts";
import { isRecord } from "../util/text.ts";
import { readSettings, settingsFile, writeSettings } from "../settings-file.ts";
import { modeFor } from "./modes.ts";
import { PROCESS_RISK_CLASSES, type ProcessRiskClass } from "./process-health.ts";
import { CONTROL_KEYS, type ControlKey } from "./sidecar.ts";

/** Every durable Path control. `hush` is deliberately absent: it is this session's quiet toggle. */
export type MomGlobals = Partial<Record<ControlKey, boolean | string | ProcessRiskClass[]>>;

/**
 * Keep only the values the sidecar would have accepted. A bad field is dropped rather than thrown on,
 * so one malformed value does not prevent a session from loading the other controls.
 */
export function validGlobals(value: unknown): MomGlobals {
	if (!isRecord(value)) return {};
	const source = value, cleaned: MomGlobals = {};
	if (typeof source.enabled === "boolean") cleaned.enabled = source.enabled;
	if (typeof source.detached === "boolean") cleaned.detached = source.detached;
	if (typeof source.inject === "boolean") cleaned.inject = source.inject;
	if (Array.isArray(source.nudgedClasses) && source.nudgedClasses.every(entry => PROCESS_RISK_CLASSES.includes(entry as never)))
		cleaned.nudgedClasses = [...new Set(source.nudgedClasses as ProcessRiskClass[])];
	if (typeof source.mode === "string") { try { cleaned.mode = modeFor(source.mode).name; } catch { /* an undeclared mode is not a mode */ } }
	// An empty model means "the configured default"; an empty decision model means "no decision model".
	if (typeof source.model === "string" && isModelRefOrEmpty(source.model)) cleaned.model = source.model.trim();
	if (typeof source.decider === "string" && isModelRefOrEmpty(source.decider)) cleaned.decider = source.decider.trim();
	return cleaned;
}

/** Path's section of the pi-delegate settings file. */
export function readMomGlobals(file: string = settingsFile()): MomGlobals {
	const settings = readSettings(file);
	return validGlobals({ ...settings.mom, ...settings.path });
}

/** Save one change, merged over what is there. Written atomically before anything hears about it, so a
 *  setting survives an unreachable or failing slice. */
export async function writeMomGlobals(patch: MomGlobals, file: string = settingsFile()): Promise<MomGlobals> {
	const written = await writeSettings({ path: validGlobals(patch) }, file);
	return validGlobals({ ...written.mom, ...written.path });
}

/** Global values win; a session's own saved controls remain underneath (see `loadState`). */
export function mergeGlobals(globals: MomGlobals, session: MomGlobals): MomGlobals {
	return { ...session, ...globals };
}
