/**
 * Every pi-delegate setting in one inline panel. It renders in the editor's place, below the
 * conversation, never as an overlay. Each row opens its choices in place, with a description per
 * choice and help beside the list; a choice saves to the global file at once. Mom's own panel opens
 * as a row's submenu, so there is one place for the whole package.
 */
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import {
	DEFAULT_DELEGATE_SETTINGS, MAX_DEPTH_RANGE, type DelegateSettings, type DelegationMode, type ModelPicking,
} from "../delegate-settings.ts";
import { DEFAULT_TODO_SETTINGS, type TodoSettings } from "../todo-settings.ts";

export interface SettingOption { value: string; label: string; summary: string; help: string }
export interface SettingsRow {
	id: string;
	section: string;
	label: string;
	help: string;
	/** What the row shows on the right of its label. */
	value: () => string;
	/** False when the saved value differs from the shipped default; the row is marked. */
	isDefault?: () => boolean;
	options?: () => SettingOption[];
	/** Choose an option. Rejects to keep the old value and show why. */
	choose?: (value: string) => Promise<void>;
	/** A row that opens its own component in place (Mom's panel, the role list). `close` returns here. */
	submenu?: (close: () => void) => Component;
	/** A row that acts when activated, such as restoring defaults. */
	action?: () => Promise<void>;
}

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

type Mode = { kind: "list" } | { kind: "options"; index: number } | { kind: "submenu"; component: Component };

export class SettingsPanel implements Component {
	private readonly theme = getSettingsListTheme();
	private selected = 0;
	private mode: Mode = { kind: "list" };
	private saving = false;
	private notice?: string;

	constructor(private readonly title: string, private readonly rows: SettingsRow[], private readonly redraw: () => void,
		private readonly close: () => void, private readonly maxVisible = 12) {}

	private row() { return this.rows[this.selected]!; }

	private run(work: () => Promise<void>, ok?: string) {
		this.saving = true; this.notice = undefined; this.redraw();
		void work().then(() => { this.notice = ok; }, (cause) => { this.notice = `Not saved: ${cause instanceof Error ? cause.message : String(cause)}`; })
			.finally(() => { this.saving = false; this.redraw(); });
	}

	private activate() {
		const row = this.row();
		if (row.submenu) {
			this.mode = { kind: "submenu", component: row.submenu(() => { this.mode = { kind: "list" }; this.redraw(); }) };
		} else if (row.options && row.choose) {
			const options = row.options(), shown = row.value();
			this.mode = { kind: "options", index: Math.max(0, options.findIndex((o) => o.label === shown)) };
		} else if (row.action) this.run(row.action, "Done.");
	}

	handleInput(data: string) {
		if (this.saving) return;
		if (this.mode.kind === "submenu") { this.mode.component.handleInput?.(data); this.redraw(); return; }
		const keys = getKeybindings();
		const up = keys.matches(data, "tui.select.up"), down = keys.matches(data, "tui.select.down");
		const confirm = keys.matches(data, "tui.select.confirm") || data === " ", cancel = keys.matches(data, "tui.select.cancel");
		const right = keys.matches(data, "tui.editor.cursorRight"), left = keys.matches(data, "tui.editor.cursorLeft");
		if (this.mode.kind === "options") {
			const row = this.row(), options = row.options!();
			if (up) this.mode.index = (this.mode.index + options.length - 1) % options.length;
			else if (down) this.mode.index = (this.mode.index + 1) % options.length;
			else if (cancel || left) this.mode = { kind: "list" };
			else if (confirm || right) {
				const option = options[this.mode.index]!;
				this.mode = { kind: "list" };
				this.run(() => row.choose!(option.value), `${row.label}: ${option.label}`);
			}
		} else {
			if (up) this.selected = (this.selected + this.rows.length - 1) % this.rows.length;
			else if (down) this.selected = (this.selected + 1) % this.rows.length;
			else if (cancel || left) { this.close(); return; }
			else if (confirm || right) this.activate();
		}
		this.redraw();
	}

	handleMouse(event: TuiMouseEvent) {
		if (this.mode.kind === "submenu") return this.mode.component.handleMouse?.(event);
		if (event.type === "wheel" && event.wheelDelta) {
			const step = event.wheelDelta < 0 ? -1 : 1;
			if (this.mode.kind === "options") {
				const count = this.row().options!().length;
				this.mode.index = Math.max(0, Math.min(count - 1, this.mode.index + step));
			} else this.selected = Math.max(0, Math.min(this.rows.length - 1, this.selected + step));
			this.redraw();
		}
		return { handled: true };
	}

	private listLines(width: number): string[] {
		const t = this.theme, lines: string[] = [];
		const labelWidth = Math.max(...this.rows.map((r) => visibleWidth(r.label))) + 2;
		// Keep the selected row in view; section headings scroll with their rows.
		const rows = this.rows.length > this.maxVisible
			? this.rows.slice(Math.max(0, Math.min(this.selected - Math.floor(this.maxVisible / 2), this.rows.length - this.maxVisible))).slice(0, this.maxVisible)
			: this.rows;
		let section: string | undefined;
		for (const row of rows) {
			if (row.section !== section) {
				if (section !== undefined) lines.push("");
				section = row.section;
				lines.push(t.hint(row.section.toUpperCase()));
			}
			const selected = row === this.row();
			const mark = row.isDefault && !row.isDefault() ? t.value("●", false) : " ";
			const cursor = selected ? t.cursor : " ".repeat(visibleWidth(t.cursor));
			const label = row.label + " ".repeat(Math.max(0, labelWidth - visibleWidth(row.label)));
			const value = row.submenu ? `${row.value()} ›` : row.value();
			lines.push(truncateToWidth(`${cursor}${t.label(label, selected)}${mark} ${t.value(value, selected)}`, width));
			if (selected && this.mode.kind === "options") {
				for (const [i, option] of row.options!().entries()) {
					const on = i === this.mode.index;
					lines.push(truncateToWidth(`    ${on ? t.cursor : " ".repeat(visibleWidth(t.cursor))}${t.label(option.label, on)} ${t.description(option.summary)}`, width));
				}
			}
		}
		return lines;
	}

	private helpLines(width: number): string[] {
		const t = this.theme, row = this.row();
		const option = this.mode.kind === "options" ? row.options!()[this.mode.index] : undefined;
		const text = option ? option.help : row.help;
		const title = option ? `${row.label}: ${option.label}` : row.label;
		return [t.hint("HELP"), t.label(title, true), "",
			...wrapTextWithAnsi(text, Math.max(1, width - 2)).map((line) => t.description(`  ${line}`))];
	}

	render(width: number): string[] {
		if (this.mode.kind === "submenu") return this.mode.component.render(width);
		const t = this.theme;
		const keys = this.mode.kind === "options" ? "↑↓ choose · Enter save · Esc back" : "↑↓ move · Enter change · Esc close · ● changed from default";
		const status = this.saving ? [t.hint("Saving…")] : this.notice ? [truncateToWidth(t.description(this.notice), width)] : [];
		const heading = [truncateToWidth(`${t.label(this.title, true)}  ${t.hint(keys)}`, width), ""];
		if (width < 88) return [...heading, ...this.listLines(width), "", ...this.helpLines(width), ...status];
		const leftWidth = Math.min(60, Math.max(42, Math.floor(width * 0.48)));
		const divider = t.hint(" │ ");
		const rightWidth = Math.max(1, width - leftWidth - visibleWidth(divider));
		const left = this.listLines(leftWidth), right = this.helpLines(rightWidth);
		const columns = Array.from({ length: Math.max(left.length, right.length) }, (_, i) => {
			const text = truncateToWidth(left[i] ?? "", leftWidth);
			return truncateToWidth(`${text}${" ".repeat(Math.max(0, leftWidth - visibleWidth(text)))}${divider}${right[i] ?? ""}`, width);
		});
		return [...heading, ...columns, ...status];
	}

	invalidate() { if (this.mode.kind === "submenu") this.mode.component.invalidate(); }
}

/** A read-only page, such as the role list: ↑↓/PgUp/PgDn scroll it, Esc or ← returns. */
export function textPage(title: string, lines: () => string[], close: () => void, maxRows = 20): Component {
	const t = getSettingsListTheme();
	let top = 0, total = 0;
	const rows = Math.max(3, maxRows);
	return {
		render: (width) => {
			const body = lines().flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
			total = body.length;
			top = Math.max(0, Math.min(top, total - rows));
			const range = total > rows ? ` · ${top + 1}–${Math.min(total, top + rows)}/${total}` : "";
			return [truncateToWidth(`${t.label(title, true)}  ${t.hint(`${total > rows ? "↑↓ PgUp/PgDn scroll · " : ""}Esc back${range}`)}`, width), "", ...body.slice(top, top + rows)];
		},
		handleInput: (data) => {
			const keys = getKeybindings();
			if (keys.matches(data, "tui.select.cancel") || keys.matches(data, "tui.editor.cursorLeft")) close();
			else if (keys.matches(data, "tui.select.up")) top = Math.max(0, top - 1);
			else if (keys.matches(data, "tui.select.down")) top = Math.min(Math.max(0, total - rows), top + 1);
			else if (keys.matches(data, "tui.select.pageUp")) top = Math.max(0, top - rows);
			else if (keys.matches(data, "tui.select.pageDown")) top = Math.min(Math.max(0, total - rows), top + rows);
		},
		invalidate() {},
	};
}
