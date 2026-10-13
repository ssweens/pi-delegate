/** Todo-specific controls in the `todo` section of pi-delegate.json. */
import { defineSection } from "./settings-file.ts";
import { isRecord } from "./util/text.ts";

export interface TodoSettings {
	/** Send a follow-up when a turn ends with open todo items. */
	reminders: boolean;
}

export const DEFAULT_TODO_SETTINGS: TodoSettings = { reminders: false };

export function normalizeTodoSettings(value: unknown): TodoSettings {
	const raw = isRecord(value) ? value : {};
	return { reminders: typeof raw.reminders === "boolean" ? raw.reminders : DEFAULT_TODO_SETTINGS.reminders };
}

const section = defineSection("todo", normalizeTodoSettings);
export const readTodoSettings = section.read;
/** Validates before writing so the file never holds a value this module ignores. */
export const saveTodoSettings = section.save;
