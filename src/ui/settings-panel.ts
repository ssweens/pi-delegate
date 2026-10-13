/**
 * Every pi-delegate settings screen (Delegate, Todos, Path) is this one panel: Pi's own SettingsList, the component
 * behind Pi's /settings, with its type-to-search. A row's help is its description under the list; a two-way row
 * cycles on Enter/Space as Pi's toggles do; a longer choice opens a list of its options, each with its own help; a
 * row may instead open its own component (a model picker, the role list). A choice saves at once.
 */
import { getSelectListTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { SelectList, SettingsList, truncateToWidth, wrapTextWithAnsi, type Component, type SettingItem } from "@earendil-works/pi-tui";
import { errorMessage } from "../util/text.ts";
import { hint, joinHints, pageKeys, upDown } from "./hints.ts";
import { navKeys } from "./keys.ts";
import { PagedText } from "./scroll.ts";

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
	/** Save a choice. Rejects to keep the old value and show why. */
	choose?: (value: string) => Promise<void>;
	/** A row that opens its own component in place (a model picker, the role list). `close(choice)` returns here and
	 *  saves `choice` through `choose` when one is given. */
	submenu?: (close: (choice?: string) => void) => Component;
	/** A row that acts when activated, such as restoring defaults. */
	action?: () => Promise<void>;
}

const CHANGED = "●";

/** The options of a row as a list, the highlighted option's help below it; Enter chooses, Esc returns. */
function optionList(row: SettingsRow, done: (value?: string) => void, maxVisible: number): Component {
	const t = getSettingsListTheme(), options = row.options!();
	const list = new SelectList(options.map(option => ({ value: option.value, label: option.label, description: option.summary })),
		Math.min(options.length, maxVisible), getSelectListTheme());
	let highlighted = Math.max(0, options.findIndex(option => option.label === row.value()));
	list.setSelectedIndex(highlighted);
	list.onSelectionChange = item => { highlighted = Math.max(0, options.findIndex(option => option.value === item.value)); };
	list.onSelect = item => done(item.value);
	list.onCancel = () => done();
	return {
		render: width => {
			const option = options[highlighted]!;
			return [truncateToWidth(t.label(row.label, true), width), "", ...list.render(width), "",
				...wrapTextWithAnsi(option.help, Math.max(1, width - 4)).map(line => t.description(`  ${line}`)),
				"", t.hint("  Enter to select · Esc to go back")];
		},
		handleInput: data => list.handleInput(data),
		handleMouse: event => list.handleMouse(event),
		invalidate: () => list.invalidate(),
	};
}

export class SettingsPanel implements Component {
	private readonly theme = getSettingsListTheme();
	private readonly list: SettingsList;
	private readonly byId: Map<string, SettingsRow>;
	private saving = false;
	private notice?: string;

	constructor(private readonly title: string, private readonly rows: SettingsRow[], private readonly redraw: () => void,
		close: () => void, maxVisible = 12) {
		this.byId = new Map(rows.map(row => [row.id, row]));
		const sections = new Set(rows.map(row => row.section)).size > 1;
		const items: SettingItem[] = rows.map(row => {
			const options = row.options?.() ?? [];
			// One list for every section: the section names the row, which keeps "Model" and "Mode" apart and searchable.
			const item: SettingItem = { id: row.id, label: sections ? `${row.section} · ${row.label}` : row.label, description: row.help, currentValue: this.shown(row) };
			if (row.submenu) item.submenu = (_current, done) => row.submenu!(choice => { done(); if (choice !== undefined) this.choose(row, choice); });
			else if (row.choose && options.length === 2) item.values = options.map(option => option.value);
			else if (row.choose && options.length) item.submenu = (_current, done) => optionList(row, value => { done(); if (value !== undefined) this.choose(row, value); }, maxVisible);
			// An action has one "value": activating it cycles to the same one, which runs it.
			else if (row.action) item.values = [item.currentValue];
			return item;
		});
		this.list = new SettingsList(items, Math.max(3, maxVisible), this.theme, id => {
			const row = this.byId.get(id)!;
			if (row.action) { this.run(row.action, "Done."); return; }
			// A two-way row cycled. The list shows the marked display value, not an option value, so the next option is
			// the one not shown now.
			const options = row.options?.() ?? [];
			const next = options.find(option => option.label !== row.value()) ?? options[0];
			if (row.choose && next) this.choose(row, next.value);
		}, close, { enableSearch: true });
	}

	/** The value column: the row's value, marked when it differs from the default; `›` where the row opens more. */
	private shown(row: SettingsRow): string {
		const changed = row.isDefault && !row.isDefault() ? ` ${CHANGED}` : "";
		const opens = row.submenu || (row.options && row.options().length > 2) ? " ›" : "";
		return `${row.value()}${changed}${opens}`;
	}

	private choose(row: SettingsRow, value: string) {
		const option = row.options?.().find(each => each.value === value);
		this.run(() => row.choose!(value), `${row.label}: ${option?.label ?? value}`);
	}

	private run(work: () => Promise<void>, ok?: string) {
		this.saving = true; this.notice = undefined; this.refresh();
		void work().then(() => { this.notice = ok; }, cause => { this.notice = `Not saved: ${errorMessage(cause)}`; })
			.finally(() => { this.saving = false; this.refresh(); });
	}

	/** Every row's value again: a save (or a failed one) may change several. */
	private refresh() {
		for (const row of this.rows) this.list.updateValue(row.id, this.shown(row));
		this.redraw();
	}

	handleInput(data: string) {
		if (this.saving) return;
		this.list.handleInput(data);
		this.redraw();
	}

	handleMouse(event: Parameters<SettingsList["handleMouse"]>[0]) {
		// The list starts below the heading's two lines.
		const result = this.list.handleMouse({ ...event, y: event.y - 2 });
		this.redraw();
		return result;
	}

	render(width: number): string[] {
		const t = this.theme;
		const status = this.saving ? [t.hint("Saving…")] : this.notice ? [truncateToWidth(t.description(this.notice), width)] : [];
		const marked = this.rows.some(row => row.isDefault) ? `  ${t.hint(`${CHANGED} changed from default`)}` : "";
		return [truncateToWidth(`${t.label(this.title, true)}${marked}`, width), "", ...this.list.render(width), ...status];
	}

	invalidate() { this.list.invalidate(); }
}

/** A read-only page, such as the role list: ↑↓/PgUp/PgDn scroll it, Esc or ← returns. */
export function textPage(title: string, lines: () => string[], close: () => void, maxRows = 20): Component {
	const t = getSettingsListTheme();
	const rows = Math.max(3, maxRows);
	return new PagedText({
		lines: width => lines().flatMap(line => wrapTextWithAnsi(line, Math.max(1, width))),
		rows: () => rows,
		chrome: (width, range, scrollable) => ({
			head: [truncateToWidth(`${t.label(title, true)}  ${t.hint(joinHints(scrollable && `${upDown()} ${pageKeys()} scroll`, hint.cancel("back"), range))}`, width), ""],
		}),
		onKey: data => {
			const nav = navKeys(data);
			if (nav !== "cancel" && nav !== "left") return false;
			close();
			return true;
		},
	});
}
