import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, SettingsList, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type SettingItem } from "@earendil-works/pi-tui";
import { PROCESS_RISK_CLASSES, type ProcessRiskClass } from "./process-health.ts";
import { modeFor, modeNames } from "./modes.ts";

export interface MomSettingsState { enabled: boolean; inject: boolean; hush: boolean; nudgedClasses: ProcessRiskClass[]; mode: string; model: string; decider?: string }
/** What the Model row shows when Mom has no saved model of her own: the flag default she actually runs. */
export const modelFallback = (fallback: string) => fallback || "(not set)";
export type MomSettingChange = { enabled: boolean } | { inject: boolean } | { hush: boolean } | { nudgedClasses: ProcessRiskClass[] } | { mode: string } | { model: string } | { decider: string };

const HELP: Record<string, string> = {
	enabled: "On: Mom reads new conversation activity and updates her saved work map in the background. Off: pauses those updates. This does not control which suggestions are shown or whether continuity messages are added.",
	suggestions: "On: show eligible findings from Mom's map. Off: hide those findings. Background tracking continues either way.",
	hush: "On: hide unsolicited suggestions in this Pi session only. Mom keeps tracking. This resets when the session reloads.",
	inject: "On: after compaction, add a sourced continuity note from Mom's saved map to the model's context. Off: do not add that note. Tracking continues.",
	mode: "Choose how Mom keeps her notes. commit_graph uses graph transactions; v2 uses a smaller tree of work, rules, and notes with host-side checks; trail keeps an append-only list of waypoints pointing into the transcript; no decision model needed. Applies on her next idle operation.",
	model: "The model that writes Mom's map updates. This is Mom's model; it does not change Pi's model.",
	decider: "The local classifier for Mom's change checks. In v2 it proposes per-node changes before Mom edits. Required there: with no decision model, every v2 update fails loudly until one is set. Not used in trail mode.",
};

/** Settings save their global value first; the selected row's help stays beside the list. */
export function momSettings(initial: MomSettingsState, save: (change: MomSettingChange) => Promise<void>,
	redraw: () => void, close: () => void, maxVisible = 12,
	/** Opens the model picker as this row's submenu. Omitted where no interactive model list exists. */
	pickModel?: (current: string, done: (selected?: string) => void) => Component,
	/** Opens the classifier picker as this row's submenu. */
	pickDecider?: (current: string, done: (selected?: string) => void) => Component,
	/** The flag default Mom runs when she has no saved model; shown in place of a bare placeholder. */
	fallback = ""): Component {
	const theme = getSettingsListTheme();
	let state = initial, saving = false, error: string | undefined, selectedIndex = 0, submenuOpen = false;
	const items: SettingItem[] = [
		{ id: "enabled", label: "Background tracking", currentValue: state.enabled ? "on" : "off", values: ["on", "off"] },
		{ id: "suggestions", label: "Suggestions", currentValue: state.nudgedClasses.length ? "on" : "off", values: ["on", "off"] },
		{ id: "hush", label: "Quiet this session", currentValue: state.hush ? "on" : "off", values: ["off", "on"] },
		{ id: "inject", label: "Automatic continuity", currentValue: state.inject ? "on" : "off", values: ["off", "on"] },
		{ id: "mode", label: "Map mode", currentValue: modeFor(state.mode).name, values: modeNames() },
		{ id: "model", label: "Model", currentValue: state.model || modelFallback(fallback),
			...(pickModel ? { submenu: (current, done) => {
				submenuOpen = true;
				return pickModel(current, selected => { submenuOpen = false; done(selected); redraw(); });
			} } : {}) },
		{ id: "decider", label: "Decision model", currentValue: state.decider === undefined ? "(not set)" : state.decider || "(none)",
			...(pickDecider ? { submenu: (current, done) => {
				submenuOpen = true;
				return pickDecider(current, selected => { submenuOpen = false; done(selected); redraw(); });
			} } : {}) },
	];
	const maxRows = Math.max(3, maxVisible);
	const value = (id: string) => id === "model" ? state.model || modelFallback(fallback)
		: id === "decider" ? (state.decider === undefined ? "(not set)" : state.decider || "(none)")
		: id === "mode" ? modeFor(state.mode).name
		: id === "enabled" || id === "inject" || id === "hush" ? state[id] ? "on" : "off"
		: state.nudgedClasses.length ? "on" : "off";
	const list = new SettingsList(items, maxRows, theme, (id, next) => {
		// The list cycles optimistically. Restore it until the global file write succeeds.
		list.updateValue(id, value(id));
		const change: MomSettingChange = id === "enabled" ? { enabled: next === "on" } : id === "inject" ? { inject: next === "on" }
			: id === "hush" ? { hush: next === "on" } : id === "mode" ? { mode: modeFor(next).name }
			: id === "model" ? { model: next.trim() } : id === "decider" ? { decider: next.trim() }
			: { nudgedClasses: next === "on" ? [...PROCESS_RISK_CLASSES] : [] };
		saving = true; error = undefined; redraw();
		void (async () => {
			try { await save(change); state = { ...state, ...change }; }
			catch (cause) { error = `Not saved: ${String(cause)}`; }
			finally {
				for (const item of items) list.updateValue(item.id, value(item.id));
				saving = false; redraw();
			}
		})();
	}, close);
	const visibleStart = () => Math.max(0, Math.min(selectedIndex - Math.floor(maxRows / 2), items.length - maxRows));
	const helpLines = (width: number) => {
		const selected = items[selectedIndex] ?? items[0]!;
		return [theme.hint("SETTING HELP"), theme.label(selected.label, true), "",
			...wrapTextWithAnsi(HELP[selected.id] ?? "No help is available for this setting.", Math.max(1, width - 2)).map(line => theme.description(`  ${line}`))];
	};
	return {
		render: width => {
			const narrow = width < 88;
			const heading = [truncateToWidth(theme.label("Mom settings", true), width), ""];
			if (narrow) return [...heading, ...list.render(width), "", ...helpLines(width),
				...(saving ? [theme.hint("Saving…")] : []), ...(error ? [truncateToWidth(theme.description(error), width)] : [])];
			const leftWidth = Math.min(52, Math.max(38, Math.floor(width * 0.43)));
			const divider = theme.hint(" │ ");
			const rightWidth = Math.max(1, width - leftWidth - visibleWidth(divider));
			const left = list.render(leftWidth), right = helpLines(rightWidth), rows = Math.max(left.length, right.length);
			const columns = Array.from({ length: rows }, (_, index) => {
				const text = truncateToWidth(left[index] ?? "", leftWidth);
				const padding = " ".repeat(Math.max(0, leftWidth - visibleWidth(text)));
				return truncateToWidth(`${text}${padding}${divider}${right[index] ?? ""}`, width);
			});
			return [...heading, ...columns, ...(saving ? [theme.hint("Saving…")] : []), ...(error ? [truncateToWidth(theme.description(error), width)] : [])];
		},
		invalidate: () => list.invalidate(),
		handleInput: data => {
			if (saving) return;
			const keys = getKeybindings();
			if (!submenuOpen && keys.matches(data, "tui.select.cancel")) { close(); return; }
			if (!submenuOpen) {
				if (keys.matches(data, "tui.select.up")) selectedIndex = selectedIndex === 0 ? items.length - 1 : selectedIndex - 1;
				else if (keys.matches(data, "tui.select.down")) selectedIndex = (selectedIndex + 1) % items.length;
			}
			list.handleInput(data); redraw();
		},
		handleMouse: event => {
			if (saving) return { handled: true };
			const adjusted = { ...event, y: event.y - 2 };
			if (!submenuOpen) {
				if (adjusted.type === "wheel" && adjusted.wheelDelta) {
					selectedIndex = adjusted.wheelDelta < 0 ? Math.max(0, selectedIndex - 1) : Math.min(items.length - 1, selectedIndex + 1);
				} else if (adjusted.type === "press" && adjusted.button === "left") {
					const row = adjusted.y;
					const index = visibleStart() + row;
					if (row >= 0 && index < items.length && row < maxRows) selectedIndex = index;
				}
			}
			const result = list.handleMouse(adjusted); redraw(); return result;
		},
	};
}
