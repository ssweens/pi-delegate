import type { Theme } from "@earendil-works/pi-coding-agent";
import { navKeys } from "./keys.ts";
import { keepInView, moveIndex, stepFor } from "./scroll.ts";
import { fit, indent, selectedRow } from "./text.ts";
import { kindWord, stateWord } from "./vocabulary.ts";
import { NO_ACCOUNT, type AnnotationView, type WorkView } from "./presentation.ts";

/** Why a row is shown at the top level although it has a recorded parent. */
type Detached = "outside" | "loop";
interface Node {
	item: AnnotationView;
	endeavor: boolean;
	/** Recorded parent present in this view; attached notes use their endeavor. */
	parent?: string;
	/** Recorded parent ID even when it is outside this view. */
	recordedParent: string | null;
	children: string[];
	detached?: Detached;
}
interface Row { id: string; depth: number }

const label = (item: AnnotationView): string => item.label || item.id;
const lines = (title: string, value: string): string[] => value.split(/\r?\n/).map((line, i) => i ? `  ${line}` : `${title}: ${line}`);

/** Navigable hierarchy of a Path work view. Input routing belongs to the parent component. */
export class GraphBrowser {
	private work: WorkView | undefined;
	private nodes = new Map<string, Node>();
	private roots: string[] = [];
	private expanded = new Set<string>();
	private selectedId: string | undefined;
	private scroll = 0;

	constructor(work: WorkView | undefined) {
		this.update(work);
	}

	update(work: WorkView | undefined): void {
		const previous = this.selectedId, previousParent = this.parentId, initial = !this.work;
		this.work = work;
		this.build();
		if (previous && this.nodes.has(previous)) this.selectedId = previous;
		else if (!initial && previousParent && this.nodes.has(previousParent)) this.selectedId = previousParent;
		else {
			const focus = [work?.focus, work?.focusEndeavor].find(id => id && this.nodes.has(id)) ?? undefined;
			this.selectedId = focus ?? this.roots[0];
			if (focus) for (const id of work?.focusPath ?? []) this.expanded.add(id);
		}
		this.reveal();
	}

	get selected(): AnnotationView | undefined {
		return this.selectedId ? this.nodes.get(this.selectedId)?.item : undefined;
	}

	get parentId(): string | undefined {
		return this.selectedId ? this.nodes.get(this.selectedId)?.parent : undefined;
	}

	move(delta: number): void {
		const rows = this.rows();
		if (!rows.length) return;
		const at = Math.max(0, rows.findIndex(row => row.id === this.selectedId));
		this.selectedId = rows[moveIndex(at, delta, rows.length)].id;
	}

	/**
	 * The keys every map view shares: ↑↓ and Home/End move, → or Space expands and collapses, ← goes to the parent.
	 * True when the key was one of them; a caller handles its own extras before or after.
	 */
	handleKey(data: string, page?: number): boolean {
		const nav = navKeys(data);
		const step = stepFor(nav, page);
		if (step !== undefined) this.move(step);
		else if (nav === "right" || data === " ") this.toggle();
		else if (nav === "left") this.parent();
		else return false;
		return true;
	}

	toggle(): void {
		const id = this.selectedId;
		if (!id || !this.nodes.get(id)?.children.length) return;
		if (!this.expanded.delete(id)) this.expanded.add(id);
	}

	parent(): void {
		if (this.parentId) this.selectedId = this.parentId;
	}

	render(theme: Theme, width: number, height: number): string[] {
		if (width < 1 || height < 1) return [];
		const rows = this.rows();
		if (!rows.length) return [fit(theme.fg("muted", NO_ACCOUNT), width)];
		const at = Math.max(0, rows.findIndex(row => row.id === this.selectedId));
		this.scroll = keepInView(this.scroll, at, height, rows.length);
		return rows.slice(this.scroll, this.scroll + height).map(({ id, depth }) => {
			const node = this.nodes.get(id)!, item = node.item;
			const selected = id === this.selectedId;
			const twisty = !node.children.length ? " " : this.expanded.has(id) ? "▾" : "▸";
			const focus = id === this.work?.focus ? theme.fg("accent", " ◆ focus") : "";
			const kind = node.endeavor ? "" : theme.fg("dim", `${kindWord(item.kind)}: `);
			const note = node.detached === "loop" ? " · parent loop" : node.detached === "outside" ? " · parent outside view"
				: !node.endeavor && !node.parent ? " · no recorded parent" : "";
			const name = selected ? theme.bold(theme.fg("accent", label(item))) : label(item);
			const line = `${selected ? "> " : "  "}${indent(depth)}${theme.fg("dim", twisty)} ${kind}${name}${theme.fg("muted", ` · ${stateWord(item.state)}${note}`)}${focus}`;
			return selected ? selectedRow(theme, line, width) : fit(line, width);
		});
	}

	details(): string[] {
		const node = this.selectedId ? this.nodes.get(this.selectedId) : undefined;
		if (!node) return [];
		const item = node.item, out = [label(item), `ID: ${item.id}`];
		out.push(`Kind: ${item.kind || "unknown"} · State: ${item.state || "unknown"} (${stateWord(item.state)})${item.summaryOnly ? " · name/state only" : ""}`);
		if (node.parent) out.push(`Within: ${this.named(node.parent)}`);
		else if (node.recordedParent) out.push(`Within: [${node.recordedParent}] — ${node.detached === "loop" ? "parent links form a loop" : "outside this view"}`);
		else if (!node.endeavor) out.push("Within: no recorded endeavor parent");
		out.push(...lines("Intent", item.intent || (item.summaryOnly ? "not loaded" : "not recorded")));
		if (item.observed) out.push(...lines("Observed", item.observed));
		if (item.actor) out.push(`Actor: ${item.actor}`);
		const relations = (this.work?.connections ?? []).filter(c => (c.fromAnnotation ?? c.from) === item.id || (c.toAnnotation ?? c.to) === item.id);
		for (const c of relations) {
			out.push(`Relation: ${this.named(c.fromAnnotation ?? c.from)} —${c.relation || "related"}→ ${this.named(c.toAnnotation ?? c.to)}${c.sources.length ? ` (sources: ${c.sources.join(", ")})` : ""}`);
		}
		if (item.purposeSource) out.push(`Purpose source: ${item.purposeSource}${item.sources.includes(item.purposeSource) ? "" : " (not among recorded sources)"}`);
		out.push(item.sources.length ? "Sources:" : "Sources: none recorded", ...item.sources.map(ref => `  ${ref}`));
		return out;
	}

	private named(id: string): string {
		const node = this.nodes.get(id);
		return node ? `${label(node.item)} [${id}]` : `[${id}] (outside this view)`;
	}

	/** Index unique IDs (first record wins) and choose roots from actual parent links. */
	private build(): void {
		this.nodes.clear();
		this.roots = [];
		const work = this.work;
		if (!work) return;
		const endeavors = work.endeavors.filter(e => {
			if (this.nodes.has(e.id)) return false;
			this.nodes.set(e.id, { item: e, endeavor: true, recordedParent: e.parent, children: [] });
			return true;
		});
		for (const e of endeavors) {
			const node = this.nodes.get(e.id)!;
			if (e.parent && this.nodes.get(e.parent)?.endeavor) node.parent = e.parent;
		}
		for (const e of endeavors) if (this.nodes.get(e.id)!.parent) this.nodes.get(e.parent!)!.children.push(e.id);
		for (const e of endeavors) for (const a of e.annotations) if (!this.nodes.has(a.id)) {
			this.nodes.set(a.id, { item: a, endeavor: false, parent: e.id, recordedParent: e.id, children: [] });
			this.nodes.get(e.id)!.children.push(a.id);
		}
		const visited = new Set<string>();
		const walk = (id: string) => {
			if (visited.has(id)) return;
			visited.add(id);
			for (const child of this.nodes.get(id)!.children) walk(child);
		};
		const root = (id: string, detached?: Detached) => {
			const node = this.nodes.get(id)!;
			if (detached) node.detached = detached;
			this.roots.push(id);
			walk(id);
		};
		for (const e of endeavors) if (!e.parent) root(e.id);
		for (const e of endeavors) if (e.parent && !this.nodes.get(e.id)!.parent) root(e.id, "outside");
		for (const e of endeavors) if (!visited.has(e.id)) {
			// Unreached endeavors hang below a parent loop; root the first repeated ancestor.
			const seen = new Set<string>();
			let cursor = e.id;
			while (!seen.has(cursor)) { seen.add(cursor); cursor = this.nodes.get(cursor)!.parent!; }
			root(cursor, "loop");
		}
		for (const a of work.unattachedAnnotations) if (!this.nodes.has(a.id)) {
			this.nodes.set(a.id, { item: a, endeavor: false, recordedParent: null, children: [] });
			this.roots.push(a.id);
		}
	}

	private rows(): Row[] {
		const rows: Row[] = [], seen = new Set<string>();
		const visit = (id: string, depth: number) => {
			if (seen.has(id)) return;
			seen.add(id);
			rows.push({ id, depth });
			if (this.expanded.has(id)) for (const child of this.nodes.get(id)!.children) visit(child, depth + 1);
		};
		for (const id of this.roots) visit(id, 0);
		return rows;
	}

	/** Expand displayed ancestors so the selection is a visible row. */
	private reveal(): void {
		const id = this.selectedId;
		if (!id || this.rows().some(row => row.id === id)) return;
		const seen = new Set<string>();
		for (let cursor = this.nodes.get(id)?.parent; cursor && !seen.has(cursor); cursor = this.nodes.get(cursor)?.parent) {
			seen.add(cursor);
			this.expanded.add(cursor);
			if (this.roots.includes(cursor)) break;
		}
	}
}
