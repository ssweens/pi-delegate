import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Role {
	name: string;
	description: string;
	systemPrompt: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	context?: "fork" | "fresh";
	timeoutMs?: number;
	/** Where its children run by default: in this Pi process, or as an oven slice. A delegate call can override it. */
	runtime?: "in-process" | "oven";
	/** oven only: the Pi-package and Durable extensions the slice selects (oven's are off by default). */
	extensions?: string[];
	source: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** A role without a `tools` line: every tool the child's session can load. */
export const EVERY_TOOL = ["*"];
/** The delegation pair. A child at the depth cap is never given either. */
export const DELEGATION_TOOLS = ["delegate", "delegate_ctl"];
/** Tools whose contract is to mutate files. bash is not one: read-only roles use it for grep, git diff and tests. */
export const WRITE_TOOLS = ["edit", "write"];

/** A `tools` entry is a tool name, or a prefix followed by `*`. */
const matches = (entry: string, name: string) => entry.endsWith("*") ? name.startsWith(entry.slice(0, -1)) : name === entry;
/**
 * What a role's `tools` line lets a child have, decided by name over every tool the child's session offers
 * (built-ins, extension tools, the parent's MCP tools, delegate and delegate_ctl): a listed name or `*`
 * pattern, and never a `withheld` name (the delegation pair at the depth cap).
 */
export function toolAllowlist(entries: readonly string[], withheld: readonly string[] = []) {
	return { allows: (name: string) => !withheld.includes(name) && entries.some((entry) => matches(entry, name)) };
}

/** Entries that matched none of the tools a child was offered. A withheld name is not reported. */
export function droppedTools(entries: readonly string[], offered: Iterable<string>, withheld: readonly string[] = []): string[] {
	const names = [...offered];
	return entries.filter((entry) => !withheld.includes(entry) && !names.some((name) => matches(entry, name)));
}

/**
 * A project's roles, relative to its folder, read only when the project is trusted. It is Pi's
 * CONFIG_DIR_NAME, `.pi`, written out: this module is loaded outside Pi too, where the peer dependency
 * does not resolve. test/trust.test.ts checks the two agree.
 */
export const PROJECT_ROLES_DIR = join(".pi", "agents");

/** Lowest → highest priority; later dirs override same-named roles. */
export function roleDirs(cwd: string, projectTrusted: boolean): string[] {
	const home = homedir();
	const dirs = [
		join(HERE, "..", "roles"),
		join(home, ".pi", "agent", "agents"),
		join(home, ".agents", "agents"),
	];
	if (projectTrusted) dirs.push(join(cwd, PROJECT_ROLES_DIR));
	return dirs;
}

function* mdFiles(dir: string): Generator<string> {
	if (!existsSync(dir)) return;
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		let st;
		try {
			st = statSync(p);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			if (!name.startsWith("_") && !name.startsWith(".")) yield* mdFiles(p);
		} else if (name.endsWith(".md")) yield p;
	}
}

export function parseFrontmatter(text: string): { fm: Record<string, string>; body: string } {
	if (!text.startsWith("---")) return { fm: {}, body: text };
	const end = text.indexOf("\n---", 3);
	if (end < 0) return { fm: {}, body: text };
	const fmText = text.slice(3, end);
	const body = text.slice(end + 4).replace(/^\r?\n/, "");
	const fm: Record<string, string> = {};
	let key: string | undefined;
	for (const line of fmText.split(/\r?\n/)) {
		const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
		if (m) {
			key = m[1];
			fm[key] = m[2].trim();
		} else if (key && /^\s+\S/.test(line)) {
			fm[key] = `${fm[key]} ${line.trim()}`.trim();
		}
	}
	return { fm, body };
}

export function toolList(v: string | undefined): string[] | undefined {
	if (!v) return undefined;
	const list = v
		.replace(/^\[|\]$/g, "")
		.split(/[,\s]+/)
		.map((s) => s.trim())
		.filter(Boolean);
	return list.length ? list : undefined;
}

export function loadRoles(cwd: string, projectTrusted: boolean): Map<string, Role> {
	const roles = new Map<string, Role>();
	for (const dir of roleDirs(cwd, projectTrusted)) {
		for (const file of mdFiles(dir)) {
			let text: string;
			try {
				text = readFileSync(file, "utf8");
			} catch {
				continue;
			}
			const { fm, body } = parseFrontmatter(text);
			if (!fm.name) continue;
			const ctx = (fm.context ?? fm.defaultContext) as string | undefined;
			roles.set(fm.name, {
				name: fm.name,
				description: fm.description ?? "",
				systemPrompt: body.trim(),
				model: fm.model && fm.model !== "inherit" ? fm.model : undefined,
				thinking: fm.thinking && fm.thinking !== "default" ? fm.thinking : undefined,
				tools: toolList(fm.tools),
				context: ctx === "fresh" || ctx === "fork" ? ctx : undefined,
				timeoutMs: fm.timeoutMs ? Number(fm.timeoutMs) || undefined : undefined,
				runtime: fm.runtime === "oven" || fm.runtime === "in-process" ? fm.runtime : undefined,
				extensions: toolList(fm.extensions),
				source: file.replace(homedir(), "~"),
			});
		}
	}
	return roles;
}
