import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { SettingsList, truncateToWidth, type Component, type SettingItem } from "@earendil-works/pi-tui";
import { PROCESS_RISK_CLASSES, type ProcessRiskClass } from "./process-health.ts";
import { modeFor, modeNames } from "./modes.ts";

export interface MomSettingsState { enabled: boolean; inject: boolean; hush: boolean; nudgedClasses: ProcessRiskClass[]; mode: string; model: string; decider: string }
export type MomSettingChange = { enabled: boolean } | { inject: boolean } | { hush: boolean } | { nudgedClasses: ProcessRiskClass[] } | { mode: string } | { model: string } | { decider: string };

/** Stock keyboard/mouse behavior; only durable-save acknowledgement is Mom-specific. */
export function momSettings(initial: MomSettingsState, save: (change: MomSettingChange) => Promise<void>,
	redraw: () => void, close: () => void, maxVisible = 12,
	/** Opens the model picker as this row's submenu. Omitted where no interactive model list exists. */
	pickModel?: (current: string, done: (selected?: string) => void) => Component,
	/** Opens the classifier picker as the decider row's submenu. */
	pickDecider?: (current: string, done: (selected?: string) => void) => Component): Component {
	const theme = getSettingsListTheme();
	let state = initial, saving = false, error: string | undefined;
	const value = (id: string) => id === "model" ? state.model || "(configured default)"
		: id === "decider" ? state.decider || "(none)"
		: id === "mode" ? modeFor(state.mode).name
		: id === "enabled" || id === "inject" || id === "hush" ? state[id] ? "on" : "off"
		: state.nudgedClasses.length ? "on" : "off";
	const items: SettingItem[] = [
		{ id: "enabled", label: "Tracking", description: "Keep Mom's current understanding up to date in the background. Saved globally; new sessions read it.", currentValue: value("enabled"), values: ["on", "off"] },
		{ id: "suggestions", label: "Suggestions", description: "Show useful concerns and opportunities. Existing class selections remain compatible as on or off.", currentValue: value("suggestions"), values: ["on", "off"] },
		{ id: "hush", label: "Quiet this session", description: "Pause unsolicited suggestions while tracking continues. Resets on reload.", currentValue: value("hush"), values: ["off", "on"] },
		{ id: "inject", label: "Automatic continuity", description: "Add visible, sourced continuity after compaction. Off is the recommended default. Saved globally; new sessions read it.", currentValue: value("inject"), values: ["off", "on"] },
		{ id: "mode", label: "Map mode", description: "How Mom maintains the work map. Saved globally; this session applies it on its next idle slice.", currentValue: value("mode"), values: modeNames() },
		{ id: "model", label: "Model", description: "The model Mom runs on. Saved globally; scoped to Mom, never Pi's default. New sessions read it.", currentValue: value("model"),
			...(pickModel ? { submenu: (current: string, done: (selected?: string) => void) => pickModel(current, done) } : {}) },
		{ id: "decider", label: "Decision model", description: "Decides what changes before her model writes them. Saved globally; new sessions read it. Uses a Pi classifier; (none) disables the gate.", currentValue: value("decider"),
			...(pickDecider ? { submenu: (current: string, done: (selected?: string) => void) => pickDecider(current, done) } : {}) },
	];
	const list = new SettingsList(items, maxVisible, theme, (id, next) => {
		// SettingsList cycles optimistically. Restore immediately, before any render;
		// only a successful sidecar append may change the visible/live value.
		list.updateValue(id, value(id));
		const change: MomSettingChange = id === "enabled" ? { enabled: next === "on" } : id === "inject" ? { inject: next === "on" }
			: id === "hush" ? { hush: next === "on" } : id === "mode" ? { mode: modeFor(next).name }
			: id === "model" ? { model: next.trim() } : id === "decider" ? { decider: next.trim() }
			: { nudgedClasses: next === "on" ? [...PROCESS_RISK_CLASSES] : [] };
		saving = true; error = undefined;
		void (async () => {
			try { await save(change); state = { ...state, ...change }; }
			catch (cause) { error = `Not saved: ${String(cause)}`; }
			finally {
				for (const item of items) list.updateValue(item.id, value(item.id));
				saving = false; redraw();
			}
		})();
	}, close);
	return {
		render: width => [truncateToWidth(theme.label("Mom settings", true), width), "", ...list.render(width),
			...(saving ? [theme.hint("Saving…")] : []), ...(error ? [truncateToWidth(theme.description(error), width)] : [])],
		invalidate: () => list.invalidate(),
		handleInput: data => { if (!saving) list.handleInput(data); redraw(); },
		handleMouse: event => {
			if (saving) return { handled: true };
			// The native list starts below our two-line heading.
			const result = list.handleMouse({ ...event, y: event.y - 2 }); redraw(); return result;
		},
	};
}
