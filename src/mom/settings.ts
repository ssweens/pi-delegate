import type { Component } from "@earendil-works/pi-tui";
import { SettingsPanel, type SettingOption, type SettingsRow } from "../ui/settings-panel.ts";
import { PROCESS_RISK_CLASSES, type ProcessRiskClass } from "./process-health.ts";
import { modeFor, modeNames } from "./modes.ts";

export interface MomSettingsState { enabled: boolean; inject: boolean; hush: boolean; nudgedClasses: ProcessRiskClass[]; mode: string; model: string; decider?: string }
/** What the Model row shows when Path has no saved model of its own: the flag default it actually runs. */
export const modelFallback = (fallback: string) => fallback || "(not set)";
export type MomSettingChange = { enabled: boolean } | { inject: boolean } | { hush: boolean } | { nudgedClasses: ProcessRiskClass[] } | { mode: string } | { model: string } | { decider: string };

const HELP: Record<string, string> = {
	enabled: "On: Path reads new conversation activity and updates its saved work map in the background. Off: pauses those updates. This does not control which suggestions are shown or whether continuity messages are added.",
	suggestions: "On: show eligible findings from Path's map. Off: hide those findings. Background tracking continues either way.",
	hush: "On: hide unsolicited suggestions in this Pi session only. Path keeps tracking. This resets when the session reloads.",
	inject: "On: after compaction, add a sourced continuity note from Path's saved map to the model's context. Off: do not add that note. Tracking continues.",
	mode: "Choose how Path keeps its notes. commit_graph uses graph transactions; v2 uses a smaller tree of work, rules, and notes with host-side checks; trail keeps an append-only list of waypoints pointing into the transcript; no decision model needed. Applies on its next idle operation.",
	model: "The model that writes Path's map updates. This is Path's model; it does not change Pi's model.",
	decider: "The local classifier for Path's change checks (decision models first; below them every other local model, for a server that does not tag them). In v2 it proposes per-node changes before Path edits; required there: with no decision model, every v2 update fails loudly until one is set. In trail mode it reads each user turn and skips the update model when none steers the work.",
};

const ON_OFF = (on: string, off: string): SettingOption[] => [{ value: "on", label: "on", summary: "", help: on }, { value: "off", label: "off", summary: "", help: off }];

/** Path's rows of the settings panel: the same rows in /path settings and in /delegate settings. */
export function pathRows(state: () => MomSettingsState, save: (change: MomSettingChange) => Promise<void>,
	/** Opens the model picker as this row's submenu. Omitted where no interactive model list exists. */
	pickModel?: (current: string, done: (selected?: string) => void) => Component,
	/** Opens the classifier picker as this row's submenu. */
	pickDecider?: (current: string, done: (selected?: string) => void) => Component,
	/** The flag default Path runs when it has no saved model; shown in place of a bare placeholder. */
	fallback = ""): SettingsRow[] {
	const onOff = (on: boolean) => on ? "on" : "off";
	const toggle = (id: "enabled" | "inject" | "hush", label: string): SettingsRow => ({ id, section: "Path", label, help: HELP[id]!,
		value: () => onOff(state()[id]), options: () => ON_OFF("", ""), choose: async value => save({ [id]: value === "on" } as MomSettingChange) });
	const picker = (id: "model" | "decider", label: string, value: () => string, pick?: (current: string, done: (selected?: string) => void) => Component): SettingsRow => ({
		id, section: "Path", label, help: HELP[id]!, value,
		choose: async selected => save({ [id]: selected.trim() } as MomSettingChange),
		...(pick ? { submenu: close => pick(id === "model" ? state().model : state().decider ?? "", selected => close(selected)) } : {}) });
	return [
		toggle("enabled", "Background tracking"),
		{ id: "suggestions", section: "Path", label: "Suggestions", help: HELP.suggestions!, value: () => onOff(state().nudgedClasses.length > 0),
			options: () => ON_OFF("", ""), choose: async value => save({ nudgedClasses: value === "on" ? [...PROCESS_RISK_CLASSES] : [] }) },
		toggle("hush", "Quiet this session"),
		toggle("inject", "Automatic continuity"),
		{ id: "mode", section: "Path", label: "Map mode", help: HELP.mode!, value: () => modeFor(state().mode).name,
			options: () => modeNames().map(name => ({ value: name, label: name, summary: "", help: modeFor(name).description })),
			choose: async value => save({ mode: modeFor(value).name }) },
		picker("model", "Model", () => state().model || modelFallback(fallback), pickModel),
		picker("decider", "Decision model", () => state().decider === undefined ? "(not set)" : state().decider || "(none)", pickDecider),
	];
}

/** /path settings: Path's rows alone in the settings panel. A save updates what the rows read. */
export function momSettings(initial: MomSettingsState, save: (change: MomSettingChange) => Promise<void>,
	redraw: () => void, close: () => void, maxVisible = 12,
	pickModel?: (current: string, done: (selected?: string) => void) => Component,
	pickDecider?: (current: string, done: (selected?: string) => void) => Component,
	fallback = ""): Component {
	let state = initial;
	return new SettingsPanel("Path settings", pathRows(() => state, async change => { await save(change); state = { ...state, ...change }; },
		pickModel, pickDecider, fallback), redraw, close, maxVisible);
}
