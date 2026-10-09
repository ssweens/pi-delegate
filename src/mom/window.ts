/** Mom watches the first settled lead turns after a compaction; she corrects one misalignment. */
import type { Message } from "@earendil-works/pi-ai";
import { isEndeavor, type GraphNode } from "./graph.ts";
import { commandFromJson } from "./anchor.ts";
import { isUserDirection, renderEvents, type FeedEvent } from "./feed.ts";
import type { Checkpoint } from "./checkpoint.ts";
import { isStatusPing } from "./status.ts";

/** The correction rides the session as a custom message; Mom's feed skips her own injections. */
export const WINDOW_CORRECTION = "pi-tether.mom-correction";
/** The stage-two request body's task marker; tests key on it and nothing else. */
export const WINDOW_TASK = "Post-compaction continuity check: does this settled turn continue the recorded line of work?";
/** The window closes after three settled lead turns. */
export const MAX_WINDOW_TURNS = 3;
/** At most three one-shot model checks inside one window. */
export const MAX_WINDOW_CHECKS = 3;
/** Flag classes stage one can emit; also the sidecar's validation list. */
export const WINDOW_FLAG_CLASSES = ["parked", "settled", "folded", "rule", "off-goal"] as const;
export type WindowFlagClass = typeof WINDOW_FLAG_CLASSES[number];

export interface TurnSignal { key: string; kind: "path" | "command"; ref: string; op?: string }
export interface WindowFlag { class: WindowFlagClass; node: string; label: string; intent: string; matched: string[]; sources: string[] }
export interface WindowDirection { text: string; ref: string }
export interface WindowVerdict { continues: boolean; citation: string; reason?: string }

/** The pieces of a live feed the window reads; kept minimal for bounded offline tests. */
export interface WindowFeed {
	events: readonly FeedEvent[];
	lookup(ref: string, offset?: number, limit?: number): Promise<{ text: string; totalChars: number }>;
}

const COMMAND_CHARS = 700;
const NODE_SOURCE_CHARS = 1200;
const NODE_SOURCES = 3;
const MAX_NODES_PER_CLASS = 24;
const MAX_LOOKUPS = 48;
const DIRECTION_CHARS = 200;

const flatCommand = (command: string): string => command.replace(/\s+/g, " ").trim();

/** Path-shaped tokens from prose: a letter-stemmed basename and a letter-starting extension. */
const PATH_TOKEN = /[A-Za-z0-9_.\-\/]{2,240}/g;
export function pathTokens(text: string): string[] {
	const tokens: string[] = [];
	for (const candidate of text.match(PATH_TOKEN) ?? []) if (isPathToken(candidate)) tokens.push(candidate);
	return [...new Set(tokens)];
}
const isPathToken = (token: string): boolean => {
	if (!token.includes(".") || token.includes("..") || token.startsWith(".") || token.startsWith("/")
		|| token.endsWith("/") || token.includes("//")) return false;
	const base = token.slice(token.lastIndexOf("/") + 1);
	const cut = base.lastIndexOf(".");
	if (cut <= 0) return false;
	const stem = base.slice(0, cut), extension = base.slice(cut + 1);
	return /^[A-Za-z]/.test(extension) && /^[A-Za-z0-9]+$/.test(extension) && extension.length <= 11 && /[A-Za-z]/.test(stem);
};

/** This turn's activity keys, from tool metadata only: file paths and shell commands. */
export async function collectTurnSignals(feed: WindowFeed, events: readonly FeedEvent[], lookups: { count: number } = { count: 0 }): Promise<TurnSignal[]> {
	const signals: TurnSignal[] = [];
	for (const event of events) {
		if (event.kind === "file_op" && event.text) signals.push({ key: event.text, kind: "path", ref: event.ref, ...(event.name ? { op: event.name } : {}) });
		else if (event.kind === "shell_result" && lookups.count < MAX_LOOKUPS) {
			lookups.count++;
			try {
				const page = await feed.lookup(event.ref, 0, COMMAND_CHARS);
				const command = commandFromJson(page.text);
				if (command && flatCommand(command)) signals.push({ key: flatCommand(command), kind: "command", ref: event.ref });
			} catch { /* an unreadable page never blocks the check */ }
		}
	}
	return signals;
}

/** Recorded keys for one node, from a bounded prefix of its source pages. */
async function nodeKeys(feed: WindowFeed, sources: readonly string[], lookups: { count: number }): Promise<Map<string, string>> {
	const keys = new Map<string, string>();
	for (const ref of sources.slice(0, NODE_SOURCES)) {
		if (lookups.count >= MAX_LOOKUPS) break;
		lookups.count++;
		try {
			const page = await feed.lookup(ref, 0, NODE_SOURCE_CHARS);
			for (const token of pathTokens(page.text)) if (!keys.has(token)) keys.set(token, ref);
			const command = commandFromJson(page.text);
			const flat = command ? flatCommand(command) : "";
			if (flat && !keys.has(flat)) keys.set(flat, ref);
		} catch { /* an unreadable source contributes no keys */ }
	}
	return keys;
}

/** Stage one is free: deterministic flags from the saved map plus the turn's tool metadata. */
export async function stageOne(feed: WindowFeed, checkpoint: Checkpoint, signals: readonly TurnSignal[], lookups: { count: number } = { count: 0 }): Promise<WindowFlag[]> {
	const graph = checkpoint.graph;
	const nodes = new Map(graph.nodes.map(node => [node.id, node] as const));
	const turn = new Map(signals.map(signal => [signal.key, signal] as const));
	// The current line of work: the focus node, its ancestors, and its descendants.
	const line = new Set<string>();
	if (graph.focus && nodes.has(graph.focus)) {
		for (let id: string | null = graph.focus; id; id = nodes.get(id)?.parent ?? null) line.add(id);
		const stack = [graph.focus];
		while (stack.length) for (const child of graph.nodes.filter(node => node.parent === stack.pop())) {
			if (!line.has(child.id)) { line.add(child.id); stack.push(child.id); }
		}
	}
	// The current line's recorded keys bound what off-goal means: a turn wholly outside them.
	const lineKeys = new Set<string>();
	for (const id of line) for (const [key] of await nodeKeys(feed, nodes.get(id)!.sources, lookups)) lineKeys.add(key);
	const matchedOn = (keys: ReadonlyMap<string, string>): { key: string; ref: string }[] =>
		[...keys].filter(([key]) => turn.has(key)).map(([key, ref]) => ({ key, ref }));
	const flag = (flagClass: WindowFlagClass, node: GraphNode, matched: { key: string; ref: string }[]): WindowFlag =>
		({ class: flagClass, node: node.id, label: node.label, intent: node.intent.trim() || node.label,
			matched: [...new Set(matched.map(item => item.key))], sources: [...new Set(matched.map(item => item.ref))] });
	const flags: WindowFlag[] = [];
	// Rules are never suppressed by the current line: a standing constraint holds anywhere.
	for (const node of graph.nodes.filter(node => node.kind === "rule" && node.state === "active").slice(0, MAX_NODES_PER_CLASS)) {
		const text = `${node.label} ${node.intent}`;
		const matched = [...turn.keys()].filter(key => turn.get(key)!.kind === "path" && pathTokens(text).includes(key)
			|| turn.get(key)!.kind === "command" && text.includes(key));
		if (matched.length) flags.push(flag("rule", node, matched.map(key => ({ key, ref: turn.get(key)!.ref }))));
	}
	// Parked, settled, and folded work outside the current line: over-inclusive by design. A shared
	// source page can carry both lines' tokens, so stage one never suppresses these — stage two adjudicates.
	const offGoal: { node: GraphNode; matched: { key: string; ref: string }[] }[] = [];
	for (const node of graph.nodes.filter(isEndeavor).slice(0, MAX_NODES_PER_CLASS)) {
		if (line.has(node.id)) continue;
		const matched = matchedOn(await nodeKeys(feed, node.sources, lookups));
		if (!matched.length) continue;
		if (node.state === "parked" || node.state === "settled") flags.push(flag(node.state, node, matched));
		else if (node.state === "active" || node.state === "proposed" || node.state === "unknown") offGoal.push({ node, matched });
	}
	for (const node of graph.nodes.filter(node => node.history).slice(0, MAX_NODES_PER_CLASS)) {
		const keys = await nodeKeys(feed, node.history!.sources, lookups);
		for (const token of pathTokens(node.history!.reason)) if (!keys.has(token)) keys.set(token, node.history!.sources[0]!);
		const matched = matchedOn(keys);
		if (matched.length) flags.push(flag("folded", node, matched));
	}
	// Off-goal needs the whole turn outside the current line; mixed activity still continues the line.
	if (offGoal.length && ![...turn.keys()].some(key => lineKeys.has(key)))
		for (const { node, matched } of offGoal) flags.push(flag("off-goal", node, matched));
	return flags;
}

const oneLine = (text: string): string => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > DIRECTION_CHARS ? `${flat.slice(0, DIRECTION_CHARS).trimEnd()}…` : flat;
};

/** The current line, mirroring the anchor's Current rendering so the check and the correction agree. */
export function windowPurpose(checkpoint: Checkpoint): string {
	const graph = checkpoint.graph;
	const nodes = new Map(graph.nodes.map(node => [node.id, node] as const));
	const focus = graph.focus ? nodes.get(graph.focus) : undefined;
	if (!focus) return "Current line — not recorded yet.";
	const cite = focus.purposeSource ?? focus.sources[0];
	const intent = oneLine(focus.intent);
	if (isEndeavor(focus)) return `Current line — “${focus.label}”${intent ? `: ${intent}` : ""} [src:${cite}]`;
	const owner = focus.parent ? nodes.get(focus.parent) : undefined;
	if (!owner) return `Current line — “${focus.label}”${intent ? `: ${intent}` : ""} [src:${cite}]`;
	const ownerIntent = oneLine(owner.intent);
	return `Current line — “${owner.label}”${ownerIntent ? `: ${ownerIntent}` : ""} (attention on “${focus.label}”) [src:${cite}]`;
}

/** The user's last recorded direction, clipped; a bare status ping is a query, not direction. */
export function lastDirectionOf(feed: { events: readonly FeedEvent[] }): WindowDirection | null {
	for (let i = feed.events.length - 1; i >= 0; i--) {
		const event = feed.events[i];
		if (isUserDirection(event) && event.text && !isStatusPing(event.text)) return { text: oneLine(event.text), ref: event.ref };
	}
	return null;
}

/** One bounded model check: does this settled turn continue the recorded line of work? */
export function windowMessages(input: { flags: readonly WindowFlag[]; turnEvents: readonly FeedEvent[]; purpose: string; lastUserDirection: WindowDirection | null }): Message[] {
	return [{ role: "user", timestamp: Date.now(), content: JSON.stringify({
		task: WINDOW_TASK,
		turnEvents: renderEvents(input.turnEvents),
		flags: input.flags,
		flagClasses: { parked: "interrupted work she recorded as parked", settled: "work she recorded as done",
			folded: "work folded away into history", rule: "a standing constraint", "off-goal": "a different goal than the current line" },
		purpose: input.purpose,
		lastUserDirection: input.lastUserDirection ? { text: input.lastUserDirection.text, ref: input.lastUserDirection.ref } : null,
		reply: `Reply with only JSON: {"continues": boolean, "citation": one offered ref, "reason": short sentence}. continues=false only if the turn departs from the recorded line of work; a user direction after the compaction supersedes the record.`,
	}) }];
}

/** Every ref the model may legitimately cite: turn events, flag sources, and the last direction. */
export function offeredRefs(input: { flags: readonly WindowFlag[]; turnEvents: readonly FeedEvent[]; lastUserDirection: WindowDirection | null }): Set<string> {
	const refs = new Set<string>();
	for (const event of input.turnEvents) refs.add(event.ref);
	for (const flag of input.flags) for (const ref of flag.sources) refs.add(ref);
	if (input.lastUserDirection) refs.add(input.lastUserDirection.ref);
	return refs;
}

/** A verdict counts only with a cited offered ref; anything else is indeterminate and corrects nothing. */
export function parseWindowVerdict(text: string, refs: ReadonlySet<string>): WindowVerdict | undefined {
	let parsed: unknown;
	try { parsed = JSON.parse(text); } catch { return undefined; }
	const strip = (ref: string) => ref.replace(/(:[^:]+):b\d+$/, "$1");
	const stripped = new Set([...refs].map(strip));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const d = parsed as Record<string, unknown>;
	if (typeof d.continues !== "boolean" || typeof d.citation !== "string" || !d.citation) return undefined;
	if (!refs.has(d.citation) && !stripped.has(strip(d.citation))) return undefined;
	if (d.reason !== undefined && typeof d.reason !== "string") return undefined;
	return { continues: d.continues, citation: d.citation, ...(d.reason ? { reason: d.reason } : {}) };
}

/** The correction orients; it never directs. One per compaction, at the settled boundary. */
export function renderCorrection(input: { signals: readonly TurnSignal[]; flags: readonly WindowFlag[]; purpose: string; lastUserDirection: WindowDirection | null }): string {
	const activity = input.signals.length
		? input.signals.map(signal => `- ${signal.op ?? (signal.kind === "command" ? "run" : "touch")} ${signal.key} [src:${signal.ref}]`).join("\n")
		: "- no recorded file or shell activity";
	const records = input.flags.map(flag => `- ${flag.class}: “${flag.label}” — ${flag.intent || flag.label}${flag.sources.map(ref => ` [src:${ref}]`).join("")}`).join("\n");
	const lines = [
		"Mom — continuity correction after the compaction (from her saved map; descriptive, not new direction):",
		"This turn:",
		activity,
		"It matches work she recorded before the compaction:",
		records,
		input.purpose,
		...(input.lastUserDirection ? [`Last user direction — “${input.lastUserDirection.text}” [src:${input.lastUserDirection.ref}]`] : []),
		"If the user's direction has changed since the compaction, follow the user. Otherwise return to the current line above — this is her record, not a new direction.",
	];
	return lines.join("\n");
}
