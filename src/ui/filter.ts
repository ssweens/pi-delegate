/** Type-to-search for lists: one input line and one matcher, shared by the Agents history and the Deals sheet. */
import { decodeKittyPrintable, fuzzyFilter, Input } from "@earendil-works/pi-tui";
import { navKeys } from "./keys.ts";

/** `items` that fuzzily match `query` (best first), or all of them when it is empty. */
export const filterBy = <T>(items: T[], query: string, text: (item: T) => string): T[] => query ? fuzzyFilter(items, query, text) : items;

const printable = (data: string): boolean => decodeKittyPrintable(data) !== undefined || (data.length > 0 && !/[\x00-\x1f\x7f]/.test(data));

export interface FilterOptions {
	prompt?: string;
	placeholder?: string;
	/** A printable key starts the search itself, as in Pi's own lists; otherwise `start()` opens it. */
	typeToSearch?: boolean;
	/** Enter goes to the list (to select) instead of closing the input. */
	enterSelects?: boolean;
	/** The query changed. */
	onChange(query: string): void;
	/** The input opened or closed. */
	onToggle?(active: boolean): void;
}

/** A filter line over a list. While open it takes the typing; the list keys (↑↓, PgUp/PgDn) pass through. */
export class FilterInput {
	private readonly input: Input;
	private open = false;
	private focus = false;

	constructor(private readonly options: FilterOptions) {
		this.input = new Input({ prompt: options.prompt ?? "Filter: ", placeholder: options.placeholder });
		this.input.onSubmit = () => this.close();
		this.input.onEscape = () => this.close();
	}

	get active(): boolean { return this.open; }
	get query(): string { return this.input.getValue().trim(); }

	set focused(value: boolean) { this.focus = value; this.input.focused = value && this.open; }

	start(): void { this.open = true; this.input.focused = this.focus; this.options.onToggle?.(true); }

	private close(): void { this.open = false; this.input.focused = false; this.options.onToggle?.(false); }

	/** True when the filter took the key. */
	handle(data: string): boolean {
		if (!this.open) {
			if (!this.options.typeToSearch || !printable(data)) return false;
			this.start();
		} else {
			const nav = navKeys(data);
			if (nav === "up" || nav === "down" || nav === "pageUp" || nav === "pageDown" || (nav === "confirm" && this.options.enterSelects)) return false;
		}
		const before = this.input.getValue();
		this.input.handleInput(data);
		if (this.input.getValue() !== before) this.options.onChange(this.query);
		return true;
	}

	render(width: number): string {
		return this.input.render(width)[0] ?? "";
	}

	invalidate(): void { this.input.invalidate(); }
}
