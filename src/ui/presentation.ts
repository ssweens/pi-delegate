/** Read-only, English-first projection. No inference, storage writes, or model calls. */
export interface AnnotationView {
	id: string;
	kind: string;
	state: string;
	label: string;
	intent: string;
	observed: string;
	sources: string[];
	/** One explicit grounding owner for the public intent/Why. */
	purposeSource?: string;
	history?: unknown;
	actor?: string;
	/** Only a boundary label was loaded, not the complete account. */
	summaryOnly?: boolean;
}
export interface EndeavorView extends AnnotationView {
	parent: string | null;
	annotations: AnnotationView[];
}
export interface ConnectionView {
	from: string;
	to: string;
	relation: string;
	sources: string[];
	/** Preserve the exact attached-record endpoint; do not widen its scope. */
	fromAnnotation?: string;
	toAnnotation?: string;
}
export interface WorkView {
	orientation: string;
	motherThread: string | null;
	purpose: string | null;
	focus: string | null;
	/** The endeavor containing a focused rule, choice, or observation. */
	focusEndeavor: string | null;
	focusPath: string[];
	roots: string[];
	endeavors: EndeavorView[];
	outside: string[];
	connections: ConnectionView[];
	/** Old flat records with no recorded parent remain explicitly unattached. */
	unattachedAnnotations: AnnotationView[];
	selected: string[];
	historical: boolean;
	original: { ref: string; text: string } | null;
	format?: string;
	checkpoint?: string;
	previousCheckpoint?: string;
	revision?: number;
	at?: number;
	initialized?: boolean;
	coverageComplete?: boolean;
	/** Durable evidence coverage while catching up; undefined once complete or unprovable. */
	coverage?: { consumed: number; total: number };
	status?: string;
	change?: unknown;
	unfinished?: unknown;
	/** Technical read failure is retained for detail views, not used as orientation. */
	error?: unknown;
	totalRecords: number;
	omittedRecords: number;
}

type RecordData = Record<string, any>;
const endeavorKinds = new Set(["feature", "theory", "postulate", "try"]);
const text = (value: unknown): string => typeof value === "string" ? value : "";
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const records = (value: unknown): RecordData[] => Array.isArray(value) ? value.filter(v => v && typeof v === "object" && typeof v.id === "string") : [];
const copy = <T>(value: T): T => structuredClone(value);
const name = (item: Pick<AnnotationView, "label" | "id">): string => item.label || item.id;
const stateName = (state: string): string => ({ active: "in progress", parked: "waiting", settled: "finished", proposed: "proposed", unknown: "not yet known" })[state] ?? "not yet known";
const annotationName = (kind: string): string => ({ rule: "Rule", choice: "Open choice", observation: "Observation" })[kind] ?? "Attached note";
const sentence = (value: string): string => /[.!?]$/.test(value.trim()) ? value.trim() : `${value.trim()}.`;
const excerpt = (value: string, limit = 280): string => {
	const single = value.replace(/\s+/g, " ").trim();
	return single.length > limit ? `${single.slice(0, limit).trimEnd()}… (excerpt)` : single;
};
const list = (items: string[], limit = 5): string => items.slice(0, limit).join("; ") + (items.length > limit ? `; and ${items.length - limit} more` : "");

function annotation(raw: RecordData, summaryOnly: boolean): AnnotationView {
	return { id: raw.id, kind: text(raw.kind), state: text(raw.state), label: text(raw.label) || raw.id,
		intent: text(raw.intent), observed: text(raw.observed), sources: strings(raw.sources),
		...(typeof raw.purposeSource === "string" ? { purposeSource: raw.purposeSource } : {}),
		...(raw.history !== undefined ? { history: copy(raw.history) } : {}),
		...(typeof raw.actor === "string" ? { actor: raw.actor } : {}), ...(summaryOnly ? { summaryOnly: true } : {}) };
}

/** Keep old flat membership unknown; never infer parents from governing or return links. */
export function presentGraph(raw: any): WorkView {
	const input: RecordData = raw && typeof raw === "object" ? raw : {};
	const selected = records(input.nodes), boundary = records(input.boundaryNodes);
	const selectedIds = new Set(selected.map(n => n.id));
	const all = new Map<string, RecordData>();
	for (const node of [...boundary, ...selected]) all.set(node.id, node);
	const endeavors: EndeavorView[] = [], unattachedAnnotations: AnnotationView[] = [];
	const owners = new Map<string, string>();
	for (const node of all.values()) if (endeavorKinds.has(node.kind)) {
		endeavors.push({ ...annotation(node, !selectedIds.has(node.id) && !("intent" in node)), parent: typeof node.parent === "string" ? node.parent : null, annotations: [] });
		owners.set(node.id, node.id);
	}
	const centers = new Map(endeavors.map(e => [e.id, e]));
	for (const node of all.values()) if (!endeavorKinds.has(node.kind)) {
		const item = annotation(node, !selectedIds.has(node.id) && !("intent" in node));
		const parent = typeof node.parent === "string" ? centers.get(node.parent) : undefined;
		if (parent) { parent.annotations.push(item); owners.set(node.id, parent.id); }
		else unattachedAnnotations.push(item);
	}
	const purpose = typeof input.purpose === "string" ? input.purpose : null;
	const motherThread = typeof input.motherThread === "string" ? input.motherThread : purpose;
	const focus = typeof input.focus === "string" ? input.focus : null;
	const focusEndeavor = focus ? owners.get(focus) ?? null : null;
	const path: string[] = [];
	if (focusEndeavor) {
		const visited = new Set<string>();
		let cursor: string | null = focusEndeavor;
		while (cursor && !visited.has(cursor)) {
			visited.add(cursor); path.unshift(cursor); cursor = centers.get(cursor)?.parent ?? null;
		}
	}
	const roots = endeavors.filter(e => e.parent === null).map(e => e.id);
	const connections: ConnectionView[] = (Array.isArray(input.edges) ? input.edges : []).filter((e: any) => e && typeof e.from === "string" && typeof e.to === "string").map((e: any) => ({
		from: owners.get(e.from) ?? e.from, to: owners.get(e.to) ?? e.to, relation: text(e.relation), sources: strings(e.sources),
		...(owners.get(e.from) && owners.get(e.from) !== e.from ? { fromAnnotation: e.from } : {}),
		...(owners.get(e.to) && owners.get(e.to) !== e.to ? { toAnnotation: e.to } : {}),
	}));
	const omittedRecords = Number.isSafeInteger(input.omittedNodes) && input.omittedNodes >= 0 ? input.omittedNodes : 0;
	const totalRecords = Number.isSafeInteger(input.totalNodes) && input.totalNodes >= 0 ? input.totalNodes : all.size;
	const outside: string[] = [];
	const boundaryWork = endeavors.filter(e => e.summaryOnly).map(e => name(e));
	if (boundaryWork.length) outside.push(`Only names and states are loaded for ${list(boundaryWork)}; their full accounts are outside this view.`);
	const boundaryNotes = [...all.values()].filter(n => !selectedIds.has(n.id) && !("intent" in n) && !endeavorKinds.has(n.kind));
	if (boundaryNotes.length) outside.push(`${boundaryNotes.length} attached ${boundaryNotes.length === 1 ? "note is" : "notes are"} shown by name and state only.`);
	if (omittedRecords) outside.push(`${omittedRecords} of ${totalRecords} recorded items are outside the selection; ${all.size - selectedIds.size} are included as surrounding context and ${Math.max(0, totalRecords - all.size)} are not loaded.`);
	if (unattachedAnnotations.length) outside.push(`${unattachedAnnotations.length} selected ${unattachedAnnotations.length === 1 ? "note has" : "notes have"} no recorded endeavor parent in this view; no attachment has been guessed.`);
	const original = input.original && typeof input.original.text === "string" ? { ref: text(input.original.ref), text: input.original.text } : null;
	const view: WorkView = { orientation: "", motherThread, purpose, focus, focusEndeavor, focusPath: path, roots, endeavors, outside, connections,
		unattachedAnnotations, selected: [...selectedIds], historical: Boolean(input.historical), original,
		totalRecords, omittedRecords };
	for (const key of ["format", "checkpoint", "previousCheckpoint", "revision", "at", "initialized", "coverageComplete", "status", "change", "unfinished", "error"] as const) {
		if (input[key] !== undefined) (view as unknown as RecordData)[key] = copy(input[key]);
	}
	view.orientation = orientation(view, all);
	return view;
}

function orientation(view: WorkView, raw: Map<string, RecordData>): string {
	const byId = new Map(view.endeavors.map(e => [e.id, e]));
	const purpose = view.purpose ? byId.get(view.purpose) : undefined;
	const pieces: string[] = [];
	const coverageComplete = view.coverageComplete !== false && !view.error;
	if (view.historical) pieces.push("You are reading an earlier saved account, not current work.");
	else if (!coverageComplete) pieces.push("Mom has not read the latest activity yet. This is her last-saved snapshot, not current orientation.");
	if (!view.endeavors.length && !view.unattachedAnnotations.length) {
		pieces.push("Mom has not saved an account of this work yet.");
	} else if (purpose) {
		pieces.push(`The mother thread ${view.historical ? "was" : "is"} “${name(purpose)}”.`);
		pieces.push(purpose.intent ? `Its purpose: ${sentence(excerpt(purpose.intent))}` : "Its full purpose is not included in this selected view.");
	} else pieces.push("The mother-thread account is outside this view; its purpose cannot be reconstructed from these records.");
	if (view.original) pieces.push(`The original user request was: “${excerpt(view.original.text)}”`);
	else pieces.push("The original user request is not available in this read.");
	if (view.omittedRecords && view.selected.length) {
		pieces.push(`This read selects: ${list(view.selected.map(id => text(raw.get(id)?.label) || id))}.`);
		const paths = new Set<string>();
		for (const id of view.selected) {
			let item = byId.get(id) ?? view.endeavors.find(e => e.annotations.some(a => a.id === id));
			const labels: string[] = [], seen = new Set<string>();
			while (item && !seen.has(item.id)) {
				seen.add(item.id); labels.unshift(name(item)); item = item.parent ? byId.get(item.parent) : undefined;
			}
			if (labels.length) paths.add(labels.join(" → "));
		}
		if (paths.size) pieces.push(`That work belongs here: ${list([...paths])}.`);
	}
	if (view.focusPath.length) {
		pieces.push(`${view.historical ? "Where work was" : coverageComplete ? "Where you are" : "Last saved focus"}: ${view.focusPath.map(id => byId.get(id)?.label || id).join(" → ")}.`);
		const focused = view.focus ? raw.get(view.focus) : undefined;
		if (focused && view.focus !== view.focusEndeavor) pieces.push(`The ${view.historical ? "recorded" : coverageComplete ? "current" : "last saved"} point of attention in that endeavor is the attached ${annotationName(text(focused.kind)).toLowerCase()} “${text(focused.label) || focused.id}” (${focused.kind === "rule" && focused.state === "active" ? "in force" : stateName(text(focused.state))}), not a separate endeavor.`);
		else if (focused) pieces.push(`That endeavor is ${stateName(text(focused.state))}.`);
	} else if (view.focus) pieces.push("The current point of attention is outside the loaded hierarchy.");
	const selectedWork = view.endeavors.filter(e => !e.summaryOnly);
	for (const [state, label] of [["active", "Work in progress"], ["parked", "Waiting work"], ["settled", "Finished work"], ["proposed", "Proposed work"]]) {
		const matches = selectedWork.filter(e => e.state === state).map(name);
		if (matches.length) pieces.push(`${label} shown: ${list(matches)}.`);
	}
	const notes = view.endeavors.flatMap(e => e.annotations.filter(a => !a.summaryOnly).map(a => ({ item: a, owner: name(e) })));
	const rules = notes.filter(({ item }) => item.kind === "rule" && item.state === "active");
	if (rules.length) pieces.push(sentence(`Rules still in force: ${list(rules.map(({ item, owner }) => `${owner} — ${excerpt(item.intent || item.label, 220)}`))}`));
	const waiting = notes.filter(({ item }) => item.state === "parked");
	if (waiting.length) pieces.push(`Waiting within this work: ${list(waiting.map(({ item, owner }) => `${owner} — ${name(item)}`))}.`);
	const outcomes = notes.filter(({ item }) => item.kind === "observation" && item.state === "settled");
	if (outcomes.length) pieces.push(`Recorded outcomes: ${list(outcomes.map(({ item, owner }) => `${owner} — ${name(item)}`))}.`);
	if (view.roots.length > 1) pieces.push(`Other top-level endeavors are also shown: ${list(view.roots.filter(id => id !== view.purpose).map(id => name(byId.get(id)!)))}.`);
	if (view.outside.length) pieces.push(`Outside this view: ${view.outside.join(" ")}`);
	else if (raw.size) pieces.push("This read includes the whole saved account; no other work is hidden by the selection.");
	if (view.error) pieces.unshift("Mom could not update this account. This is the last saved view, not confirmation that recent activity has been incorporated.");
	return pieces.join(" ");
}

/** Compact by default; explicit detail retains every projected field and source. */
export function readText(view: WorkView, details = false): string {
	if (!details) return summaryText(view);
	const { orientation: _orientation, ...data } = view;
	return `${summaryText(view)}\n\nRecorded details:\n${JSON.stringify(data, null, 2)}`;
}

/** Plain excerpts, not new semantic summaries. Quotation delimiters are omitted in
 * the overview; the exact wording (including punctuation) remains in detail. */
const compact = (value: string, limit = 90): string => {
	const plain = value.replace(/["“”«»„‟「」『』]/g, "")
		.replace(/(?<!\p{L})['‘’]|['‘’](?!\p{L})/gu, "").replace(/\s+/g, " ").trim();
	if (plain.length <= limit) return plain;
	const head = plain.slice(0, limit), boundary = head.lastIndexOf(" ");
	return `${(boundary > limit / 2 ? head.slice(0, boundary) : head).trimEnd()}…`;
};
const GROUP_LIMIT = 2;
const ENDEAVOR_LIMIT = 2;
const grouped = (items: string[]): string => items.slice(0, GROUP_LIMIT).join("; ")
	+ (items.length > GROUP_LIMIT ? `; … ${items.length - GROUP_LIMIT} more` : "");

/** Bounded story groups under their recorded endeavor, never inferred membership. */
export interface ProgressView { coverage?: { consumed: number; total: number } }
/**
 * How much recorded evidence Mom has durably consumed. Honest coverage, not effort: entries differ
 * in size, so the percentage is a monotone progress signal, not an estimate of remaining time.
 * Returns undefined rather than guessing when the branch no longer contains the consumed leaf.
 */
/** Floored: unread entries never round up to a claim of 100%. */
const readPercent = (consumed: number, total: number) => consumed >= total ? 100 : Math.floor((consumed / total) * 100);

export function coverageProgress(branch: readonly { id: string }[], consumedLeaf: string | null): { consumed: number; total: number; percent: number } | undefined {
	if (!branch.length) return undefined;
	const consumed = consumedLeaf === null ? 0 : branch.findIndex(entry => entry.id === consumedLeaf) + 1;
	if (consumedLeaf !== null && consumed === 0) return undefined;
	const total = branch.length;
	return { consumed, total, percent: readPercent(consumed, total) };
}

export function coverageSentence(view: ProgressView): string | undefined {
	const coverage = view.coverage;
	if (!coverage || coverage.total <= 0 || coverage.consumed >= coverage.total) return undefined;
	return `She has read ${coverage.consumed} of ${coverage.total} recorded entries (${readPercent(coverage.consumed, coverage.total)}%).`;
}

export function summaryText(view: WorkView): string {
	const lines: string[] = [];
	const endeavors = new Map(view.endeavors.map(e => [e.id, e]));
	const items = [...view.endeavors, ...view.endeavors.flatMap(e => e.annotations), ...view.unattachedAnnotations];
	const byId = new Map(items.map(item => [item.id, item]));
	const selected = new Set(view.omittedRecords ? view.selected : []);
	const state = (item: AnnotationView) => item.kind === "rule" && item.state === "active" ? "in force" : stateName(item.state);
	const coverageComplete = view.coverageComplete !== false && !view.error;
	const current = view.historical ? "Recorded focus" : coverageComplete ? "Current" : "Last saved focus";
	const rule = (item: AnnotationView) => item.kind === "rule" && item.state === "active";
	const history = (item: AnnotationView, indent: string) => {
		if (!item.history) return;
		const checkpoint = text((item.history as RecordData).checkpoint);
		lines.push(`${indent}Folded away → history ${checkpoint || "(checkpoint not recorded; see details)"}`);
	};
	const whyEligible = (item: AnnotationView) => !item.summaryOnly && Boolean(item.intent)
		&& ["active", "parked", "proposed"].includes(item.state);
	const why = (item: AnnotationView, indent: string, prefix = "") => {
		if (!whyEligible(item)) return false;
		if (!item.purposeSource || !item.sources.includes(item.purposeSource)) {
			lines.push(`${indent}${prefix}Why: evidence unavailable`); return true;
		}
		lines.push(`${indent}${prefix}Why: ${compact(item.intent, 100)} [src:${item.purposeSource}]`);
		return true;
	};
	const note = (item: AnnotationView, owner: string | null, indent: string, label = "") => {
		const identified = item.id === view.focus || selected.has(item.id);
		const prefix = `${label}${identified ? `[${item.id}] ` : ""}`;
		const phrase = item.state === "settled" ? name(item) : item.intent || `${name(item)} (intent not loaded)`;
		if (!(item.kind === "rule" && why(item, indent, prefix))) {
			lines.push(`${indent}${prefix}${compact(phrase, item.id === view.focus || item.state === "parked" ? 100 : 90)}${item.summaryOnly ? " · name/state only" : ""}`);
		}
		// Keep exact attached-record scope. Labels are only previews; no endpoint
		// is widened to its containing endeavor. Omitted targets are counted.
		const targets = [...new Set(view.connections.filter(c => c.relation === "governs" && (c.fromAnnotation ?? c.from) === item.id)
			.map(c => c.toAnnotation ?? c.to))];
		if (item.state !== "settled" && targets.length && !(targets.length === 1 && targets[0] === owner)) {
			lines.push(`${indent}  Applies to: ${grouped(targets.map(id => compact(byId.get(id)?.label || id, 70)))}`);
		}
		history(item, `${indent}  `);
	};
	const annotations = (notes: AnnotationView[], owner: string | null) => {
		const focus = notes.find(item => item.id === view.focus);
		if (focus) note(focus, owner, "  ", `${current} · ${state(focus)}: `);
		const rest = notes.filter(item => item !== focus);
		const groups: [string, AnnotationView[]][] = [
			["Rules in force", rest.filter(rule)],
			["Waiting on you", rest.filter(item => item.state === "parked" && item.kind === "choice")],
			["Waiting", rest.filter(item => item.state === "parked" && item.kind !== "choice")],
			["Recorded outcomes", rest.filter(item => item.state === "settled")],
			["Other notes", rest.filter(item => !rule(item) && !["parked", "settled"].includes(item.state))],
		];
		for (const [label, members] of groups) {
			if (!members.length) continue;
			lines.push(`  ${label} (${members.length}):`);
			// Explicit selection wins within a group; focused holds are above all groups.
			const ordered = [...members].sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)));
			for (const item of ordered.slice(0, GROUP_LIMIT)) note(item, owner, "    ");
			if (members.length > GROUP_LIMIT) lines.push(`    … ${members.length - GROUP_LIMIT} more`);
		}
	};

	if (view.error) lines.push("Mom could not update this account; last saved view only, not confirmation of recent activity.");
	else if (!view.historical && !coverageComplete) lines.push(`Mom has not read the latest activity yet; this is her last-saved snapshot, not current orientation.${coverageSentence(view) ? ` ${coverageSentence(view)}` : ""}`);
	if (view.historical) lines.push(`History${view.checkpoint ? ` · checkpoint=${view.checkpoint}` : ""} — earlier saved account, not current work.`);
	if (!items.length) lines.push(view.omittedRecords ? "No records loaded in this selection." : "Mom has not saved an account of this work yet.");
	else if (!view.purpose || !endeavors.has(view.purpose)) lines.push(`Endeavor: account outside this view${view.purpose ? ` [${view.purpose}]` : ""}.`);

	const pinned = [view.motherThread, view.focusEndeavor, view.purpose]
		.filter((id): id is string => Boolean(id && endeavors.has(id)))
		.filter((id, index, all) => all.indexOf(id) === index);
	const important = new Set(pinned);
	const alternativeIds = new Set(view.connections.filter(connection => connection.relation === "alternative_to")
		.flatMap(connection => [connection.from, connection.to]));
	const rest = view.endeavors.filter(e => !important.has(e.id)).sort((a, b) => {
		const rank = (e: EndeavorView) => selected.has(e.id) || e.annotations.some(a => selected.has(a.id)) ? 0
			: alternativeIds.has(e.id) ? 1 : e.state === "parked" ? 2 : e.state === "active" ? 3 : 4;
		return rank(a) - rank(b);
	});
	const shown = pinned.map(id => endeavors.get(id)!).concat(rest.slice(0, ENDEAVOR_LIMIT));
	for (const endeavor of shown) {
		const focused = endeavor.id === view.focusEndeavor;
		const heading = endeavor.id === view.motherThread ? "Mother thread" : "Endeavor";
		lines.push(`${heading}: ${compact(name(endeavor), 70)} [${endeavor.id}] — ${state(endeavor)}${focused ? view.historical ? " · recorded focus" : coverageComplete ? " · current" : " · last saved focus" : ""}${endeavor.summaryOnly ? " · name/state only" : ""}`);
		if (endeavor.parent) lines.push(`  Within: ${compact(endeavors.get(endeavor.parent)?.label || endeavor.parent)}`);
		annotations(endeavor.annotations, endeavor.id);
		why(endeavor, "  ");
		const links: [string, string[]][] = [
			["Depends on", view.connections.filter(c => c.relation === "depends_on" && c.from === endeavor.id).map(c => c.toAnnotation ?? c.to)],
			["Alternative to", view.connections.filter(c => c.relation === "alternative_to" && c.from === endeavor.id).map(c => c.toAnnotation ?? c.to)],
			["Returns to", view.connections.filter(c => c.relation === "returns_to" && c.from === endeavor.id).map(c => c.toAnnotation ?? c.to)],
		];
		for (const [label, targets] of links) if (targets.length) lines.push(`  ${label}: ${grouped([...new Set(targets)].map(id => compact(byId.get(id)?.label || id, 70)))}`);
		history(endeavor, "  ");
	}
	if (rest.length > ENDEAVOR_LIMIT) lines.push(`Other endeavors: … ${rest.length - ENDEAVOR_LIMIT} more (full map details).`);
	if (view.unattachedAnnotations.length) {
		lines.push("Notes — parent not recorded in this view:");
		annotations(view.unattachedAnnotations, null);
	}
	if (view.focus && !byId.has(view.focus)) lines.push(`Focus: [${view.focus}] — outside the loaded view.`);
	if (view.omittedRecords) lines.push(`Selection: ${view.selected.length} records; ${view.omittedRecords} of ${view.totalRecords} outside selection, ${Math.max(0, view.totalRecords - items.length)} not loaded.`);
	const partial = items.filter(item => item.summaryOnly);
	if (partial.length) lines.push(`Context (${partial.length}): name/state only.`);
	if (items.length) lines.push("Details: select an endeavor for full annotations and sources.");
	return lines.join("\n");
}
