/** The Delegate and Todo rows of the settings panel (src/ui/settings-panel.ts). */
import {
	DEFAULT_DELEGATE_SETTINGS, MAX_DEPTH_RANGE, type DelegateSettings, type DelegationMode, type ModelPicking,
} from "../delegate-settings.ts";
import { DEFAULT_TODO_SETTINGS, type TodoSettings } from "../todo-settings.ts";
import type { SettingOption, SettingsRow } from "./settings-panel.ts";

const MODES: Record<DelegationMode, Omit<SettingOption, "value">> = {
	opportunistic: { label: "Opportunistic", summary: "delegate when it pays off",
		help: "The model delegates for context isolation, parallel work, or a cheaper or stronger model, and does everything else itself. This is the default." },
	orchestrator: { label: "Orchestrator", summary: "root delegates every task",
		help: "The main session hands every task to children in the background and stays free to talk with you. It never waits on a child unless you ask, and it cannot edit or write files itself: those calls are refused with a reminder to delegate. Children are not told this; it applies to the main session only." },
	off: { label: "Off", summary: "no delegation tools",
		help: "The main session does not get delegate or delegate_ctl. Runs already started keep running and still report, and the Agents frame still shows them." },
};
const PICKING: Record<ModelPicking, Omit<SettingOption, "value">> = {
	scoped: { label: "First scoped", summary: "in Pi's scope, with credentials",
		help: "A role's model: line can list several models, most preferred first. Pick the first one that has credentials and is in Pi's scoped models (--models, or enabledModels in settings). With no scope configured, every model with credentials is in scope." },
	available: { label: "First available", summary: "any model with credentials",
		help: "A role's model: line can list several models, most preferred first. Pick the first one that has credentials, ignoring Pi's scoped models." },
};

export function delegateRows(current: () => DelegateSettings, save: (change: Partial<DelegateSettings>) => Promise<void>): SettingsRow[] {
	const d = DEFAULT_DELEGATE_SETTINGS;
	const depths = Array.from({ length: MAX_DEPTH_RANGE.max - MAX_DEPTH_RANGE.min + 1 }, (_, i) => i + MAX_DEPTH_RANGE.min);
	const parallel = [0, 2, 4, 8, 16, 32, 64];
	const parallelLabel = (n: number) => n === 0 ? "No limit" : String(n);
	return [
		{ id: "mode", section: "Delegation", label: "Mode", value: () => MODES[current().mode].label, isDefault: () => current().mode === d.mode,
			help: "How the main session uses children. Applies from its next turn.",
			options: () => (Object.keys(MODES) as DelegationMode[]).map((value) => ({ value, ...MODES[value] })),
			choose: (value) => save({ mode: value as DelegationMode }) },
		{ id: "maxDepth", section: "Delegation", label: "Max depth", value: () => String(current().maxDepth), isDefault: () => current().maxDepth === d.maxDepth,
			help: "How deep children may delegate. Your session is depth 0 and its children depth 1. A child at the limit gets no delegation tools. Applies to children started from now on.",
			options: () => depths.map((n) => ({ value: String(n), label: String(n),
				summary: n === 1 ? "children only" : n === 2 ? "children and grandchildren" : `${n} levels below you`,
				help: n === 1 ? "Children cannot start children of their own." : `A child can start children down to depth ${n}.${n === d.maxDepth ? " This is the default." : ""}` })),
			choose: (value) => save({ maxDepth: Number(value) }) },
		{ id: "maxConcurrent", section: "Delegation", label: "Max running", value: () => parallelLabel(current().maxConcurrent), isDefault: () => current().maxConcurrent === d.maxConcurrent,
			help: "How many runs, of either backend, may be unsettled at once across the whole tree, grandchildren included. A start or revival over the limit is refused with CONCURRENCY_LIMIT, not queued, so the model can wait for one to finish.",
			options: () => parallel.map((n) => ({ value: String(n), label: parallelLabel(n),
				summary: n === 0 ? "never refuse a start" : `at most ${n} at once`,
				help: n === 0 ? "No limit: every start is accepted." : `A ${n + 1}th unsettled run is refused until one settles.${n === d.maxConcurrent ? " This is the default." : ""}` })),
			choose: (value) => save({ maxConcurrent: Number(value) }) },
		{ id: "modelPicking", section: "Delegation", label: "Model picking", value: () => PICKING[current().modelPicking].label, isDefault: () => current().modelPicking === d.modelPicking,
			help: "How a role's ordered model: list is resolved when a delegate call names no model and the role has no approved default. The run's status says which entry was picked and why earlier ones were skipped.",
			options: () => (Object.keys(PICKING) as ModelPicking[]).map((value) => ({ value, ...PICKING[value] })),
			choose: (value) => save({ modelPicking: value as ModelPicking }) },
	];
}

const TODO_REMINDERS: Record<"on" | "off", Omit<SettingOption, "value">> = {
	off: { label: "Off", summary: "no automatic follow-ups",
		help: "Do not send a follow-up when a turn ends with open todo items. The todo tool and widget still work normally. This is the default." },
	on: { label: "On", summary: "follow up on open todos",
		help: "Send a bounded follow-up when a turn ends with open todo items, unless the assistant asked a question, was aborted, is waiting on progress, or a delegate child will wake the parent." },
};

export function todoRows(current: () => TodoSettings, save: (change: Partial<TodoSettings>) => Promise<void>): SettingsRow[] {
	const d = DEFAULT_TODO_SETTINGS;
	return [{ id: "todoReminders", section: "Todos", label: "Reminders", value: () => current().reminders ? TODO_REMINDERS.on.label : TODO_REMINDERS.off.label,
		isDefault: () => current().reminders === d.reminders,
		help: "Whether pi-delegate sends automatic follow-ups for incomplete todos. The todo tool, command, and widget are unaffected.",
		options: () => ([false, true] as const).map((enabled) => ({ value: enabled ? "on" : "off", ...(enabled ? TODO_REMINDERS.on : TODO_REMINDERS.off) })),
		choose: (value) => save({ reminders: value === "on" }) }];
}
