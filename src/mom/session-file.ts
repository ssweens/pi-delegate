import { readFileSync } from "node:fs";
import { completeLines } from "../util/jsonl.ts";
import type { Entry, SessionReader } from "./feed.ts";

/**
 * A lead session read from its JSONL file, on the branch that ends at `leaf`: what Path's tools see in
 * oven, where there is no live session. Pi writes each entry as it happens; a half-written last line is
 * not read yet.
 */
export function sessionFromFile(file: string, leaf: string | null): SessionReader {
	const lines = completeLines(readFileSync(file)).map(({ line }) => line);
	const header = JSON.parse(lines[0] ?? "{}");
	if (header.type !== "session" || typeof header.id !== "string") throw new Error(`Not a Pi session file: ${file}`);
	const entries = new Map<string, Entry & { id: string }>();
	for (const line of lines.slice(1)) {
		const entry = JSON.parse(line);
		if (typeof entry?.id === "string") entries.set(entry.id, entry);
	}
	if (leaf !== null && !entries.has(leaf)) throw new Error(`Path's session file does not have entry ${leaf} yet: ${file}`);
	const branch: (Entry & { id: string })[] = [];
	for (let id = leaf; id !== null && id !== undefined;) {
		const entry = entries.get(id);
		if (!entry) throw new Error(`Missing session entry: ${id}`);
		branch.push(entry);
		id = entry.parentId ?? null;
	}
	branch.reverse();
	return {
		getSessionId: () => header.id, getSessionFile: () => file, getCwd: () => header.cwd,
		getLeafId: () => leaf, getEntry: (id) => entries.get(id), getBranch: () => branch,
	};
}

/** The ID of the file's last complete entry: Pi's current leaf, since Pi appends to the leaf. */
export function lastLeaf(file: string): string | null {
	const lines = completeLines(readFileSync(file)).map(({ line }) => line);
	for (let i = lines.length - 1; i > 0; i--) {
		try { const entry = JSON.parse(lines[i]); if (typeof entry?.id === "string" && entry.type !== "session") return entry.id; } catch { /* a torn line */ }
	}
	return null;
}

/** The lead session as its file stands now: its current branch, ending at the last entry. */
export function currentSession(file: string): SessionReader { return sessionFromFile(file, lastLeaf(file)); }

const RUNNING_WINDOW_MS = 15 * 60_000;
/**
 * Whether the lead is working, from its file: its branch ends in a user message, a tool call or a tool
 * result that has no answer yet, and it changed recently. An answered or aborted turn is idle.
 */
export function leadRunning(reader: SessionReader, modifiedAt = Date.now()): boolean {
	const last = [...reader.getBranch()].reverse().find(entry => entry.type === "message");
	const m = last?.message;
	if (!m || Date.now() - modifiedAt > RUNNING_WINDOW_MS) return false;
	if (m.role === "user" || m.role === "toolResult") return true;
	if (m.role !== "assistant") return false;
	const calls = Array.isArray(m.content) && m.content.some((block: any) => block?.type === "toolCall");
	return (m.stopReason === "toolUse" || calls) && m.stopReason !== "aborted" && m.stopReason !== "error";
}
