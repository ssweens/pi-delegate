/** Todo-specific controls in the `todo` section of pi-delegate.json. */
import { readSettings, settingsFile, writeSettings } from "./settings-file.ts";

export interface TodoSettings {
	/** Send a follow-up when a turn ends with open todo items. */
	reminders: boolean;
}

export const DEFAULT_TODO_SETTINGS: TodoSettings = { reminders: false };

export function normalizeTodoSettings(value: unknown): TodoSettings {
	const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
	return { reminders: typeof raw.reminders === "boolean" ? raw.reminders : DEFAULT_TODO_SETTINGS.reminders };
}

export function readTodoSettings(file: string = settingsFile()): TodoSettings {
	return normalizeTodoSettings(readSettings(file).todo);
}

/** Validate before writing so the file never holds a value this module ignores. */
export async function saveTodoSettings(change: Partial<TodoSettings>, file: string = settingsFile()): Promise<TodoSettings> {
	const next = normalizeTodoSettings({ ...readTodoSettings(file), ...change });
	for (const [key, value] of Object.entries(change)) {
		if (next[key as keyof TodoSettings] !== value) throw new Error(`invalid ${key}: ${JSON.stringify(value)}`);
	}
	const written = await writeSettings({ todo: { ...change } }, file);
	return normalizeTodoSettings(written.todo);
}
