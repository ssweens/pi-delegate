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
	source: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** Tools a pi child can have from its own session. Anything else a role lists is dropped. */
export const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
/** The pair a role opts into by listing `delegate`. Without it a child cannot start another agent. */
export const DELEGATION_TOOLS = ["delegate", "delegate_ctl"];

/** A role entry naming one MCP server, `mcp:<server>`. The name follows mcp.json's server-name rule. */
const MCP_SERVER_ENTRY = /^mcp:([A-Za-z0-9_-]+)$/;
const isMcpEntry = (t: string) => t === "mcp" || MCP_SERVER_ENTRY.test(t);

/**
 * What a child running this role actually gets. Listing `delegate` (or `delegate_ctl`) opts into
 * both delegation tools, unless `canDelegate` is false: a child at the depth cap gets neither. Listing `mcp` opts into every configured MCP server, and `mcp:<server>`
 * into that server only; `mcp` wins over named servers. Nothing else outside the built-ins is
 * available, and is reported as dropped.
 */
export function roleTools(wanted: readonly string[] | undefined, canDelegate = true): { tools: string[]; dropped: string[]; delegates: boolean; mcp: boolean | string[] } {
	const list = wanted ?? BUILTIN_TOOLS;
	const tools = list.filter((t) => BUILTIN_TOOLS.includes(t));
	if (!tools.length) tools.push("read");
	const delegates = canDelegate && list.some((t) => DELEGATION_TOOLS.includes(t));
	if (delegates) tools.push(...DELEGATION_TOOLS);
	const servers = [...new Set(list.flatMap((t) => MCP_SERVER_ENTRY.exec(t)?.[1] ?? []))];
	const mcp = list.includes("mcp") ? true : servers.length ? servers : false;
	return { tools, dropped: list.filter((t) => !BUILTIN_TOOLS.includes(t) && !DELEGATION_TOOLS.includes(t) && !isMcpEntry(t)), delegates, mcp };
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
				source: file.replace(homedir(), "~"),
			});
		}
	}
	return roles;
}
