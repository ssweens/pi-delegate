/** Path renders the post-compaction continuity anchor from its saved map; never a model call. */
import { oneLine } from "../util/text.ts";
import { isEndeavor, type GraphNode } from "./graph.ts";
import type { FeedEvent } from "./feed.ts";
import type { Checkpoint } from "./checkpoint.ts";

export const ANCHOR = "pi-tether.mom-anchor";

const MAX_RULES = 5;
const MAX_PARKED = 6;
const MAX_EFFECTS = 3;
const MAX_COMMAND_CHARS = 160;
const MAX_INTENT_CHARS = 200;

export type SideEffectKind = "commit" | "test";

const COMMIT_COMMAND = /(?:^|[\s;&|])(?:git|hg)\s+[^&|;]*\bcommit\b(?!-)/;
const TEST_COMMAND = /(?:^|[\s;&|])(?:npm|npx|yarn|pnpm|bun)\s+(?:run\s+)?(?:test|check)\b|(?:^|[\s;&|])(?:pytest|jest|vitest|mocha|bats)\b|(?:^|[\s;&|])(?:cargo|go)\s+test\b|(?:^|[\s;&|])tsx\s+[^&|;]*--test\b/;

/** A commit outranks a test check in one compound command; the rendered line keeps the raw command. */
export function classifyCommand(command: string): SideEffectKind | undefined {
	if (COMMIT_COMMAND.test(command)) return "commit";
	if (TEST_COMMAND.test(command)) return "test";
	return undefined;
}

/** The recorded command string from a page of a bashExecution entry's JSON. */
export function commandFromJson(text: string): string | undefined {
	const match = /"command"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
	if (!match) return undefined;
	try { return JSON.parse(`"${match[1]}"`) as string; } catch { return undefined; }
}

/** The pieces of a live feed the anchor reads; kept minimal for bounded offline tests. */
export interface AnchorFeed {
	events: readonly FeedEvent[];
	lookup(ref: string, offset?: number, limit?: number): Promise<{ text: string; totalChars: number }>;
}

const effectLine = (command: string, status?: string): string => {
	const clipped = oneLine(command, MAX_COMMAND_CHARS);
	return status ? `${clipped} — ${status}` : clipped;
};

/** Recent recorded state-changing shell commands — commits and test runs — oldest first, newest last. */
export async function collectSideEffects(feed: AnchorFeed, limit = MAX_EFFECTS): Promise<string[]> {
	const effects: string[] = [];
	let examined = 0;
	for (let i = feed.events.length - 1; i >= 0 && effects.length < limit; i--) {
		if (++examined > 600) break; // side effects outside the recent window are stale, not missing
		const event = feed.events[i];
		if (event.kind !== "shell_result") continue;
		let page: { text: string } | undefined;
		try { page = await feed.lookup(event.ref, 0, 700); } catch { continue; }
		const command = commandFromJson(page.text);
		if (!command || !classifyCommand(command)) continue;
		effects.unshift(effectLine(command, event.status));
	}
	return effects;
}

const intentLine = (text: string): string => oneLine(text, MAX_INTENT_CHARS);

/** The anchor is a sourced interpretation, never verbatim authority or new direction. */
export function renderAnchor(checkpoint: Checkpoint, effects: readonly string[], savedAgo?: string): string {
	const graph = checkpoint.graph;
	const nodes = new Map(graph.nodes.map(node => [node.id, node] as const));
	const cite = (node: GraphNode) => node.purposeSource ?? node.sources[0];
	const lines: string[] = [
		`Path — continuity anchor after the compaction summary (from its last saved map${savedAgo ? `, saved ${savedAgo} ago` : ""}; not the summary; descriptive, not new direction):`,
	];
	const root = graph.motherThread ? nodes.get(graph.motherThread) : undefined;
	if (root) lines.push(`Mother thread — “${root.label}”: “${root.intent.trim() || root.label}”${cite(root) ? ` [src:${cite(root)}]` : ""}`);
	const rules = graph.nodes.filter(node => node.kind === "rule" && node.state === "active").slice(0, MAX_RULES);
	if (rules.length) {
		lines.push("Recorded constraints (Path's interpretation; check cited user direction and scope):");
		for (const rule of rules) {
			const owner = rule.parent ? nodes.get(rule.parent) : undefined;
			lines.push(`- “${rule.intent.trim() || rule.label}”${cite(rule) ? ` [src:${cite(rule)}]` : ""}${owner ? ` — under “${owner.label}”` : ""}`);
		}
	}
	const focus = graph.focus ? nodes.get(graph.focus) : undefined;
	if (focus) {
		const intent = intentLine(focus.intent);
		if (isEndeavor(focus)) lines.push(`Current — “${focus.label}”${intent ? `: ${intent}` : ""}`);
		else {
			const owner = focus.parent ? nodes.get(focus.parent) : undefined;
			const ownerIntent = owner ? intentLine(owner.intent) : "";
			lines.push(owner ? `Current — “${owner.label}”${ownerIntent ? `: ${ownerIntent}` : ""} (attention on “${focus.label}”)`
				: `Current — “${focus.label}”${intent ? `: ${intent}` : ""}`);
		}
	}
	const parked = graph.nodes.filter(node => isEndeavor(node) && node.state === "parked").slice(0, MAX_PARKED);
	if (parked.length) lines.push(`Parked — ${parked.map(node => `“${node.label}”`).join("; ")}`);
	if (effects.length) {
		lines.push("Recent side effects:");
		for (const effect of effects) lines.push(`- ${effect}`);
	}
	return lines.join("\n");
}
