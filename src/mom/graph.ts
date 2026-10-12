import { Type, type Static, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

const object = { additionalProperties: false } as const;
const id = Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" });
// Codex strict tools reject uniqueItems; check uniqueness locally.
const refs = Type.Array(Type.String({ minLength: 1 }), { minItems: 1 });
const pointer = Type.Union([id, Type.Null()]);
const relation = Type.Union([Type.Literal("returns_to"), Type.Literal("informs"), Type.Literal("governs"), Type.Literal("depends_on"), Type.Literal("alternative_to")]);
const endeavorKind = Type.Union([Type.Literal("feature"), Type.Literal("theory"), Type.Literal("postulate"), Type.Literal("try")]);
const annotationKind = Type.Union([Type.Literal("rule"), Type.Literal("choice"), Type.Literal("observation")]);
const nodeFields = {
	id, kind: Type.Union([endeavorKind, annotationKind]),
	parent: pointer,
	state: Type.Union([Type.Literal("proposed"), Type.Literal("active"), Type.Literal("parked"), Type.Literal("settled"), Type.Literal("unknown")]),
	label: Type.String({ minLength: 1, maxLength: 160 }),
	intent: Type.String({ maxLength: 1200 }), observed: Type.String({ maxLength: 2400 }),
	actor: Type.String({ maxLength: 200, description: "Observed actor identity, or empty if unknown/not applicable." }), sources: refs,
};
export const NodeInput = Type.Object(nodeFields, object);
const History = Type.Object({ checkpoint: Type.String({ minLength: 1 }), nodes: Type.Array(id, { minItems: 1, uniqueItems: true }),
	reason: Type.String({ minLength: 1 }), sources: refs,
	// Original endpoints in the prior checkpoint, not new self-edges in the active map.
	returns: Type.Array(Type.Object({ from: id, to: id }, object)),
}, object);
const Node = Type.Object({ ...nodeFields, purposeSource: Type.Optional(Type.String({ minLength: 1 })), history: Type.Optional(History) }, object);
const edgeFields = { from: id, relation, to: id };
export const Edge = Type.Object({ ...edgeFields, sources: refs }, object);
const reason = { reason: Type.String({ minLength: 1 }), sources: refs };
export const Edit = Type.Union([
	Type.Object({ op: Type.Literal("put_node"), node: Node }, object),
	Type.Object({ op: Type.Literal("put_edge"), edge: Edge }, object),
	Type.Object({ op: Type.Literal("remove_edge"), ...edgeFields }, object),
	Type.Object({ op: Type.Literal("remove_node"), id, ...reason }, object),
	Type.Object({ op: Type.Literal("fold"), thread: id, ...reason }, object),
	Type.Object({ op: Type.Literal("merge"), thread: id, into: id, ...reason }, object),
]);
export const Unfinished = Type.Array(Type.Object({ node: id,
	label: { ...nodeFields.label, description: "Copy this node's current label exactly; do not substitute its ID." },
	disposition: Type.Union([Type.Literal("carried"), Type.Literal("reparented"), Type.Literal("resolved")]),
	target: pointer, sources: refs,
}, object), { maxItems: 64, description: "Before settling or folding, account for unfinished work and continuing permission holds, including those still only in endeavor prose. Attach active rule annotations for continuing holds. List every active/parked descendant: carried to the parent/root, reparented to another surviving endeavor, or resolved with evidence. Empty means you claim nothing remains within the closing scope. This is a model declaration, not host verification of prose." });
export type UnfinishedItems = Static<typeof Unfinished>;
const graphFields = { revision: Type.Integer({ minimum: 0 }), purpose: pointer,
	focus: pointer, nodes: Type.Array(Node), edges: Type.Array(Edge) };
/** `motherThread` is a persisted role pointer to the one coordinating root endeavor. */
export const GraphSchema = Type.Object({ ...graphFields, motherThread: pointer }, object);
const LegacyGraphSchema = Type.Object(graphFields, object);
export type WorkGraph = Static<typeof GraphSchema>;
export type GraphNode = Static<typeof Node>;
export type GraphEdge = Static<typeof Edge>;
export type GraphEdit = Static<typeof Edit>;

/** Suggest a full observed source when a partial ref, wrong stream prefix, or stray
 * whitespace still identifies exactly one source. Block suffixes do not change the entry identity. */
export function sourceSuggestion(mangled: string, known: Iterable<string>): string | undefined {
	const candidates = [...known], ref = mangled.replace(/\s+/g, "");
	if (ref !== mangled && candidates.includes(ref)) return ref;
	const prefix = candidates.filter(observed => observed.startsWith(ref));
	if (prefix.length === 1) return prefix[0];
	// A shortened entry:block reference still identifies the exact block, not its siblings.
	if (ref.includes(":")) {
		const suffix = candidates.filter(observed => observed.endsWith(`:${ref}`));
		if (suffix.length) return suffix.length === 1 ? suffix[0] : undefined;
	}
	const base = ref.replace(/(:[^:]+):b\d+$/, "$1"), terminal = base.slice(base.lastIndexOf(":") + 1);
	if (!terminal) return undefined;
	const matches = candidates.filter(observed => {
		const observedBase = observed.replace(/(:[^:]+):b\d+$/, "$1");
		return observedBase.slice(observedBase.lastIndexOf(":") + 1) === terminal;
	});
	return matches.length === 1 ? matches[0] : undefined;
}
export const emptyGraph = (): WorkGraph => ({ revision: 0, motherThread: null, purpose: null, focus: null, nodes: [], edges: [] });
const edgeKey = (e: Pick<GraphEdge, "from" | "relation" | "to">) => `${e.from}/${e.relation}/${e.to}`;

/** Settled detail stays retrievable; ongoing work and constraints remain inline. */
export function graphForModel(graph: WorkGraph) {
	return { revision: graph.revision, purpose: graph.purpose, focus: graph.focus,
		work: graph.nodes.filter(isEndeavor).map(node => ({ id: node.id, parent: node.parent, state: node.state, label: node.label,
			...(node.state !== "settled" || node.id === graph.purpose || node.id === graph.focus
				? { why: node.intent } : {}), ...(node.state !== "settled" ? { status: node.observed } : {}), details: `node:${node.id}` })),
		notes: graph.nodes.filter(node => !isEndeavor(node)).map(node => ({ id: node.id, on: node.parent, kind: node.kind, state: node.state,
			text: node.state === "settled" ? node.label : node.intent || node.label, ...(node.actor ? { actor: node.actor } : {}), details: `node:${node.id}` })),
		edges: graph.edges.map(({ sources: _sources, ...edge }) => edge) };
}

/** Annotations are attached records, never independent work centers. */
export const isEndeavor = (node: { kind: string }): boolean => ["feature", "theory", "postulate", "try"].includes(node.kind);

function checkForest(nodes: ReadonlyMap<string, GraphNode>) {
	for (const node of nodes.values()) {
		if (node.parent === null && !isEndeavor(node)) throw new Error(`Only an endeavor can be a root; attach annotation ${node.id} to its endeavor.`);
		const seen = new Set([node.id]);
		let parent = node.parent;
		while (parent !== null) {
			if (seen.has(parent)) throw new Error(`Endeavor parent cycle at ${parent}.`);
			seen.add(parent);
			const ancestor = nodes.get(parent);
			if (!ancestor || !isEndeavor(ancestor)) throw new Error(`Parent must be an existing endeavor: ${node.id} -> ${parent}`);
			parent = ancestor.parent;
		}
	}
}
function subtree(nodes: ReadonlyMap<string, GraphNode>, root: string) {
	const included = new Set([root]);
	for (const key of included) for (const node of nodes.values()) if (node.parent === key) included.add(node.id);
	return included;
}

/** Name the failing record and field so a repair can target it; never just "invalid". */
export function shapeError(prefix: string, schema: TSchema, value: unknown, list = "nodes"): Error {
	const items = (value as Record<string, unknown> | null)?.[list];
	const pattern = new RegExp(`^/${list}/(\\d+)(/.*)?$`);
	const details = Errors(schema, value).filter(e => e.keyword !== "boolean").slice(0, 4).map(e => {
		const match = pattern.exec(e.instancePath);
		const item = match && Array.isArray(items) ? items[Number(match[1])] as { id?: unknown } | undefined : undefined;
		const where = match ? `${list}[${typeof item?.id === "string" ? item.id : match[1]}]${match[2] ?? ""}` : e.instancePath || "(root)";
		const extra = (e.params as { additionalProperties?: string[] }).additionalProperties;
		return `${where}: ${e.message}${Array.isArray(extra) ? ` (${extra.join(", ")})` : ""}`;
	});
	return new Error(`${prefix}${details.length ? ` ${details.join("; ")}.` : ""}`);
}

/** Parent links form one mother-thread tree. Cross-links may cycle. Neither structural check certifies semantic truth. */
export function checkGraph(value: unknown): asserts value is WorkGraph {
	if (!Check(GraphSchema, value)) throw shapeError("Invalid endeavor map shape:", GraphSchema, value);
	checkGraphStructure(value, true);
}
function checkGraphStructure(value: Static<typeof LegacyGraphSchema> & { motherThread?: string | null }, requireMother: boolean): void {
	for (const group of [value.nodes, value.edges]) for (const item of group) {
		if (new Set(item.sources).size !== item.sources.length) throw new Error("Duplicate graph source reference.");
	}
	for (const node of value.nodes) if (node.purposeSource && !node.sources.includes(node.purposeSource)) {
		throw new Error(`Purpose source must belong to node sources: ${node.id} -> ${node.purposeSource}`);
	}
	const nodes = new Map(value.nodes.map(n => [n.id, n]));
	if (nodes.size !== value.nodes.length) throw new Error("Duplicate graph node ID.");
	checkForest(nodes);
	if (value.nodes.length && (!value.purpose || !value.focus)) throw new Error("A nonempty graph needs purpose and focus nodes.");
	for (const p of [value.purpose, value.focus]) if (p !== null && !nodes.has(p)) throw new Error(`Unknown purpose/focus node: ${p}`);
	if (value.purpose && nodes.get(value.purpose)!.parent !== null) throw new Error("Purpose must identify a root endeavor (the main line).");
	if (requireMother) {
		if (!value.nodes.length && value.motherThread !== null) throw new Error("An empty map cannot identify a mother-thread root.");
		if (value.nodes.length && (!value.motherThread || value.motherThread !== value.purpose)) throw new Error("A nonempty graph needs purpose to identify its stable mother-thread root.");
		const roots = value.nodes.filter(node => node.parent === null);
		if (value.nodes.length && (roots.length !== 1 || roots[0]!.id !== value.motherThread)) throw new Error("The endeavor map needs exactly one coordinating mother-thread root; every other endeavor belongs beneath it.");
	}
	const edges = new Set<string>();
	for (const edge of value.edges) {
		const from = nodes.get(edge.from), to = nodes.get(edge.to);
		if (!from || !to) throw new Error(`Dangling graph connection: ${edgeKey(edge)}`);
		if (edge.from === edge.to || edges.has(edgeKey(edge))) throw new Error(`Self/duplicate graph connection: ${edgeKey(edge)}`);
		if (edge.relation === "alternative_to" && (!isEndeavor(from) || !isEndeavor(to))) {
			throw new Error(`Alternative connection endpoints must both be endeavors: ${edgeKey(edge)}`);
		}
		edges.add(edgeKey(edge));
	}
}

/** Deterministic, version-free cutover for current-format maps created before the
 * mother-thread role was explicit. It preserves every node/source and makes the
 * existing purpose root the sole parent of former peer roots. */
export function normalizeMotherRoot(value: unknown): { graph: WorkGraph; changed: boolean } {
	if (Check(GraphSchema, value)) { checkGraph(value); return { graph: value, changed: false }; }
	if (!Check(LegacyGraphSchema, value)) throw shapeError("Invalid endeavor map shape:", LegacyGraphSchema, value);
	checkGraphStructure(value, false);
	if (!value.nodes.length) return { graph: { revision: value.revision, motherThread: null, purpose: value.purpose, focus: value.focus, nodes: value.nodes, edges: value.edges }, changed: true };
	if (!value.purpose) throw new Error("A nonempty legacy graph has no purpose root for the mother-thread cutover.");
	const graph: WorkGraph = { revision: value.revision + 1, motherThread: value.purpose, purpose: value.purpose, focus: value.focus,
		nodes: value.nodes.map(node => node.parent === null && node.id !== value.purpose ? { ...node, parent: value.purpose } : node), edges: value.edges };
	checkGraph(graph);
	return { graph, changed: true };
}

/** Prior endeavors this transaction closes: folded, or newly settled by an upsert. Only a prior
 * endeavor and its prior descendants are safe to reason about before edits validate; proposed
 * moves/new nodes are checked later against the successfully edited graph. */
export function closingEndeavors(previous: WorkGraph, upserts: readonly GraphNode[], folds: readonly { thread: string }[]): Set<string> {
	const old = new Map(previous.nodes.map(node => [node.id, node]));
	const closing = new Set(folds.filter(fold => {
		const node = old.get(fold.thread); return Boolean(node && isEndeavor(node));
	}).map(fold => fold.thread));
	for (const node of upserts) {
		const before = old.get(node.id);
		if (before && isEndeavor(before) && node.state === "settled" && before.state !== "settled") closing.add(node.id);
	}
	return closing;
}

/** Errors provable from the declared closing scopes alone, before applying any edit. */
export function unfinishedPreflightErrors(previous: WorkGraph, upserts: readonly GraphNode[], folds: readonly { thread: string }[], items: UnfinishedItems): string[] {
	const old = new Map(previous.nodes.map(node => [node.id, node])), proposed = new Map(old);
	for (const node of upserts) proposed.set(node.id, node);
	const closing = closingEndeavors(previous, upserts, folds);
	const required = new Set<string>();
	for (const node of old.values()) {
		if (node.state !== "active" && node.state !== "parked") continue;
		const seen = new Set<string>();
		let parent = node.parent;
		while (parent && !seen.has(parent)) {
			if (closing.has(parent)) required.add(node.id);
			seen.add(parent); parent = old.get(parent)?.parent ?? null;
		}
	}
	const errors: string[] = [];
	if (!closing.size && items.length) errors.push("This transaction closes no endeavor. Set unfinished=[]; if completion was intended, settle or fold the endeavor in this transaction first.");
	const declared = new Set<string>();
	for (const item of items) {
		if (declared.has(item.node)) errors.push(`Duplicate unfinished disposition: ${item.node}.`);
		declared.add(item.node);
		const prior = old.get(item.node), attempted = proposed.get(item.node);
		if (!prior && !attempted) errors.push(`Unknown unfinished disposition node: ${item.node}. Use an active/parked descendant of a closing endeavor.`);
		else if (prior === attempted && prior && prior.label !== item.label) {
			errors.push(`Unfinished disposition label for ${item.node} must exactly match ${JSON.stringify(prior.label)}; received ${JSON.stringify(item.label)}.`);
		}
	}
	const missing = [...required].filter(id => !declared.has(id));
	if (missing.length) errors.push(`Missing unfinished disposition for ${missing.join(",")}: declare carried, reparented, or resolved with sources.`);
	return errors;
}

/** Check declared close-out effects against nodes, not the meaning of conversation or intent prose. */
export function checkUnfinished(previous: WorkGraph, upserts: readonly GraphNode[], folds: readonly { thread: string }[], after: WorkGraph,
	items: UnfinishedItems, known: ReadonlySet<string>): void {
	const old = new Map(previous.nodes.map(n => [n.id, n])), proposed = new Map(old), result = new Map(after.nodes.map(n => [n.id, n]));
	for (const node of upserts) proposed.set(node.id, node);
	const closing = new Set(folds.map(f => f.thread));
	for (const node of upserts) if (isEndeavor(node) && node.state === "settled" && old.has(node.id) && old.get(node.id)!.state !== "settled") closing.add(node.id);
	// Only work that existed before this transaction can be lost by closing a scope; nodes first created here need no disposition.
	const required = new Set<string>(), scopesByNode = new Map<string, Set<string>>();
	for (const index of [old, proposed]) for (const node of index.values()) {
		if (!old.has(node.id) || (node.state !== "active" && node.state !== "parked")) continue;
		const seen = new Set<string>();
		let parent = node.parent;
		while (parent && !seen.has(parent)) {
			if (closing.has(parent)) {
				required.add(node.id);
				const scopes = scopesByNode.get(node.id) ?? new Set<string>();
				scopes.add(parent); scopesByNode.set(node.id, scopes);
			}
			seen.add(parent); parent = index.get(parent)?.parent ?? null;
		}
	}
	const parentTargets = new Set<string>(), landingByScope = new Map<string, string>();
	for (const key of closing) {
		const scope = proposed.get(key) ?? old.get(key);
		let target = scope?.parent ?? scope?.id;
		const seen = new Set<string>();
		while (target && !result.has(target) && !seen.has(target)) {
			seen.add(target); target = proposed.get(target)?.parent ?? old.get(target)?.parent ?? undefined;
		}
		if (target && result.has(target) && isEndeavor(result.get(target)!)) { parentTargets.add(target); landingByScope.set(key, target); }
	}
	const errors: string[] = [];
	if (!closing.size && items.length) errors.push("This transaction closes no endeavor. Set unfinished=[]; if completion was intended, settle or fold the endeavor in this transaction first.");
	const declared = new Set<string>();
	for (const item of items) {
		if (declared.has(item.node)) errors.push(`Duplicate unfinished disposition: ${item.node}.`);
		declared.add(item.node);
		const node = proposed.get(item.node) ?? old.get(item.node), live = result.get(item.node);
		if (!node) { errors.push(`Unknown unfinished disposition node: ${item.node}. Use an active/parked descendant of a closing endeavor.`); continue; }
		if (node.label !== item.label) errors.push(`Unfinished disposition label for ${item.node} must exactly match ${JSON.stringify(node.label)}; received ${JSON.stringify(item.label)}.`);
		if (!item.sources.length || new Set(item.sources).size !== item.sources.length) errors.push(`Unfinished disposition needs distinct sources: ${item.node}.`);
		for (const ref of item.sources) if (!known.has(ref)) {
			const suggestion = sourceSuggestion(ref, known);
			errors.push(`Unknown unfinished disposition source for ${item.node}: ${ref}.${suggestion ? ` Use the exact observed source ${suggestion}.` : ""}`);
		}
		if (item.disposition === "resolved") {
			// A folded endeavor retires its settled descendants, so a node with no surviving record is
			// the compliant case and cannot be state-checked. Only a surviving node can. Each half
				// reports separately: one message covering both cannot say which one was wrong.
			if (live && live.state !== "settled") errors.push(`Resolved disposition needs ${item.node} settled in this transaction; it is ${live.state}.`);
			if (item.target !== null) errors.push(`Resolved disposition needs ${item.node} target=null, closing its scope; it names surviving thread ${item.target}.`);
		} else {
			if (!item.target || !result.has(item.target) || !isEndeavor(result.get(item.target)!) || !live || !["active", "parked"].includes(live.state)) {
				errors.push(`${item.disposition} disposition needs ${item.node} active/parked under surviving thread ${item.target}.`);
				continue;
			}
			if (item.disposition === "carried") {
				const scopes = scopesByNode.get(item.node);
				if (scopes ? ![...scopes].some(scope => landingByScope.get(scope) === item.target) : !parentTargets.has(item.target)) errors.push(`Carried disposition needs ${item.node} in the closing thread's surviving parent/root account, not ${item.target}.`);
				let ancestor = live.parent;
				while (ancestor && ancestor !== item.target) ancestor = result.get(ancestor)?.parent ?? null;
				if (!ancestor) errors.push(`Carried disposition needs ${item.node} inside surviving thread ${item.target}, directly or in a retained cluster.`);
			} else if (live.parent !== item.target || old.get(item.node)?.parent === item.target) errors.push(`Reparented disposition needs ${item.node} moved to ${item.target}, not left in place.`);
		}
	}
	const missing = [...required].filter(id => !declared.has(id));
	if (missing.length) errors.push(`Missing unfinished disposition for ${missing.join(",")}: declare carried, reparented, or resolved with sources.`);
	if (errors.length) throw new Error(`Unfinished disposition defects:\n- ${errors.join("\n- ")}`);
}

/** Private maps prevent failed transactions or later updates from mutating published history. */
export function editGraph(previous: WorkGraph, revision: number, edits: readonly GraphEdit[], purpose: string | null, focus: string | null,
	known: ReadonlySet<string>, checkpoint?: string): WorkGraph {
	if (revision !== previous.revision) throw new Error(`Stale graph revision ${revision}; current revision is ${previous.revision}.`);
	if (previous.motherThread && purpose !== previous.motherThread) throw new Error(`Mother-thread root identity is stable: keep purpose=${previous.motherThread}.`);
	const nodes = new Map(previous.nodes.map(n => [n.id, n]));
	let edges = new Map(previous.edges.map(e => [edgeKey(e), e]));
	const oldIds = new Set(nodes.keys()), removed = new Set<string>(), updated = new Set<string>();
	const histories = new Map<string, NonNullable<GraphNode["history"]>>();
	const checkSources = (sources: readonly string[]) => {
		if (new Set(sources).size !== sources.length) throw new Error("Duplicate graph source reference.");
		for (const ref of sources) if (!known.has(ref)) {
			const suggestion = sourceSuggestion(ref, known);
			throw new Error(`Unknown or unobserved source: ${ref}.${suggestion ? ` Use the exact observed source ${suggestion}.` : ""}`);
		}
	};
	for (const edit of edits) {
		if (!Check(Edit, edit)) throw new Error("Invalid graph edit shape.");
		if (edit.op === "put_node") {
			if (removed.has(edit.node.id)) throw new Error(`Cannot reuse a removed node ID in the same transaction: ${edit.node.id}`);
			checkSources(edit.node.sources);
			const history = nodes.get(edit.node.id)?.history;
			nodes.set(edit.node.id, { ...edit.node, ...(history ? { history } : {}) }); updated.add(edit.node.id);
		} else if (edit.op === "put_edge") {
			checkSources(edit.edge.sources); edges.set(edgeKey(edit.edge), edit.edge);
		} else if (edit.op === "remove_edge") {
			if (!edges.delete(edgeKey(edit))) throw new Error(`Unknown connection: ${edgeKey(edit)}`);
		} else if (edit.op === "remove_node") {
			checkSources(edit.sources);
			if (!nodes.delete(edit.id)) throw new Error(`Unknown node: ${edit.id}`);
			removed.add(edit.id); // Any children and cross-links must be handled explicitly.
		} else {
			checkSources(edit.sources); checkForest(nodes);
			const source = nodes.get(edit.thread);
			if (!source || !isEndeavor(source) || !oldIds.has(source.id) || !checkpoint) throw new Error("Folding or merging needs an endeavor from the previous saved map.");
			const inside = subtree(nodes, source.id);
			const target = nodes.get(edit.op === "fold" ? source.parent ?? "" : edit.into);
			if (!target || !isEndeavor(target)) throw new Error("Fold needs its immediate parent endeavor; merge needs a surviving endeavor target.");
			if (inside.has(target.id)) throw new Error("Cannot merge a thread into itself or its descendant.");
			if (edit.op === "fold" && source.state !== "settled") throw new Error("Fold only a resolved thread; carry its unfinished descendants upward.");
			if (edit.op === "merge" && source.state !== "settled" && target.state === "settled") throw new Error("An unfinished thread needs an unfinished merge target.");
			const retiring = new Set<string>([source.id]);
			if (edit.op === "fold") {
				const keep = new Set<string>();
				for (const key of inside) {
					const node = nodes.get(key)!;
					if (node.state !== "settled") {
						keep.add(key);
						if (isEndeavor(node)) for (const child of subtree(nodes, key)) keep.add(child);
					}
				}
				for (const key of inside) if (!keep.has(key)) retiring.add(key);
			}
			for (const key of retiring) if (!oldIds.has(key) || histories.has(key)) throw new Error(`Cannot contract unpublished or newly contracted history: ${key}`);
			// Changing a governing endpoint can widen a scoped hold to unrelated siblings.
			for (const edge of edges.values()) if (edge.relation === "governs" && retiring.has(edge.from) !== retiring.has(edge.to)) {
				throw new Error("A governs connection needs explicit sourced handling before contraction; do not widen its scope automatically.");
			}
			// A fold archives settled detail with its provenance; it need not rewrite parent meaning.
			if (edit.op === "merge" && target.id !== source.parent && !updated.has(target.id))
				throw new Error(`merge across branches needs the destination target upserted in this batch: ${target.id}.`);
			const missing = edit.sources.filter(ref => !target.sources.includes(ref));
			const earlier = histories.get(target.id);
			const history: NonNullable<GraphNode["history"]> = {
				checkpoint, nodes: [...new Set([...(earlier?.nodes ?? (oldIds.has(target.id) ? [target.id] : [])), ...[...inside].filter(key => oldIds.has(key))])],
				reason: earlier ? `${earlier.reason}; ${edit.reason}` : edit.reason,
				sources: [...new Set([...(earlier?.sources ?? []), ...edit.sources,
					...previous.nodes.filter(node => retiring.has(node.id)).flatMap(node => node.sources),
					...[...retiring].flatMap(key => nodes.get(key)!.sources)])], returns: [...(earlier?.returns ?? [])],
			};
			for (const key of retiring) { nodes.delete(key); removed.add(key); }
			for (const node of nodes.values()) if (node.parent && retiring.has(node.parent)) nodes.set(node.id, { ...node, parent: target.id });
			const redirected = new Map<string, GraphEdge>();
			for (const edge of edges.values()) {
				const from = retiring.has(edge.from) ? target.id : edge.from, to = retiring.has(edge.to) ? target.id : edge.to;
				if (from === to) {
					if (edge.relation === "returns_to" && !history.returns.some(r => r.from === edge.from && r.to === edge.to)) history.returns.push({ from: edge.from, to: edge.to });
					continue;
				}
				const next = { ...edge, from, to }, key = edgeKey(next), existing = redirected.get(key);
				redirected.set(key, existing ? { ...next, sources: [...new Set([...existing.sources, ...next.sources])] } : next);
			}
			edges = redirected; histories.set(target.id, history);
			// The declared operation supplies provenance; retired exploration stays in history only.
			nodes.set(target.id, { ...nodes.get(target.id)!, ...(missing.length ? { sources: [...target.sources, ...missing] } : {}), history });
		}
	}
	const next: WorkGraph = { revision: previous.revision + (edits.length || purpose !== previous.purpose || focus !== previous.focus ? 1 : 0),
		motherThread: previous.motherThread ?? purpose, purpose, focus, nodes: [...nodes.values()], edges: [...edges.values()] };
	checkGraph(next);
	return next;
}

/** Neighborhoods retain the forest's orientation even at depth zero; cross-links remain separate. */
export function graphSlice(graph: WorkGraph, selected?: readonly string[], depth = 1) {
	if (!Number.isSafeInteger(depth) || depth < 0 || depth > 3) throw new Error("Graph depth must be 0..3.");
	const index = new Map<string, GraphNode>(graph.nodes.map(n => [n.id, n]));
	if (selected?.some(key => !index.has(key))) throw new Error("Unknown graph node in selection.");
	const path = (key: string | null) => {
		const result: string[] = [];
		while (key) { result.unshift(key); key = index.get(key)!.parent; }
		return result;
	};
	const roots = graph.nodes.filter(n => n.parent === null).map(n => n.id), focusPath = path(graph.focus);
	const included = new Set(selected ?? index.keys());
	let frontier = new Set(included);
	for (let hop = 0; selected && hop < depth; hop++) {
		const next = new Set<string>();
		for (const node of graph.nodes) if (node.parent) {
			if (frontier.has(node.parent)) next.add(node.id);
			if (frontier.has(node.id)) next.add(node.parent);
		}
		for (const edge of graph.edges) {
			if (frontier.has(edge.from)) next.add(edge.to);
			if (frontier.has(edge.to)) next.add(edge.from);
		}
		frontier = new Set([...next].filter(key => !included.has(key)));
		for (const key of frontier) included.add(key);
	}
	const edges = graph.edges.filter(e => included.has(e.from) || included.has(e.to));
	const boundary = new Set([...roots, ...focusPath, ...edges.flatMap(e => [e.from, e.to])]);
	for (const key of included) for (const ancestor of path(key)) boundary.add(ancestor);
	// Cross-link endpoints also need their ancestry, not orphaned labels.
	for (const key of boundary) for (const ancestor of path(key)) boundary.add(ancestor);
	// Ancestor context includes its attached rules, choices and observations, not just labels.
	const ancestorContext = new Set(boundary);
	for (const node of graph.nodes) if (node.parent && ancestorContext.has(node.parent) && !isEndeavor(node)) boundary.add(node.id);
	// Include direct children as boundaries so an endeavor doesn't look like a leaf.
	for (const node of graph.nodes) if (node.parent && included.has(node.parent)) boundary.add(node.id);
	for (const key of included) boundary.delete(key);
	return { revision: graph.revision, motherThread: graph.motherThread, purpose: graph.purpose, focus: graph.focus, roots, focusPath,
		nodes: graph.nodes.filter(n => included.has(n.id)), edges,
		boundaryNodes: graph.nodes.filter(n => boundary.has(n.id)),
		totalNodes: graph.nodes.length, omittedNodes: graph.nodes.length - included.size };
}
