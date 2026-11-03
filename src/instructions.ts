import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, matchesGlob, relative, resolve } from "node:path";
import { loadProjectContextFiles, parseFrontmatter, type InlineExtension } from "@earendil-works/pi-coding-agent";

export type InstructionFile = { path: string; content: string };
export interface InstructionState {
	cwd: string;
	omitAgentsMd?: boolean;
	contextFiles: InstructionFile[];
	inheritedContextFiles?: InstructionFile[];
	discoveredContextFiles?: InstructionFile[];
}
const canonical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
function ancestors(path: string): string[] {
	const dirs: string[] = [];
	for (let dir = canonical(path); ; dir = dirname(dir)) {
		dirs.unshift(dir);
		if (dirname(dir) === dir) return dirs;
	}
}
function file(path: string): InstructionFile | undefined {
	return statSync(path, { throwIfNoEntry: false })?.isFile() ? { path: canonical(path), content: readFileSync(path, "utf8").replace(/^\uFEFF/, "") } : undefined;
}
function rules(root: string): { file: InstructionFile; paths?: string[] }[] {
	if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) return [];
	return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
		const path = join(root, entry.name);
		if (entry.isDirectory()) return rules(path);
		if (!entry.isFile() || !entry.name.endsWith(".md")) return [];
		const found = file(path)!;
		const { frontmatter, body } = parseFrontmatter(found.content);
		const paths = frontmatter.paths;
		if (paths !== undefined && (!Array.isArray(paths) || paths.some((p) => typeof p !== "string"))) throw new Error(`${path}: paths must be a list of globs`);
		return [{ file: { ...found, content: body }, ...(paths !== undefined ? { paths: paths as string[] } : {}) }];
	});
}
function unique(files: (InstructionFile | undefined)[]): InstructionFile[] {
	const kept = new Map<string, InstructionFile>();
	for (const f of files) if (f && !kept.has(canonical(f.path))) kept.set(canonical(f.path), f);
	return [...kept.values()];
}
export function startupInstructions(cwd: string, agentDir: string): InstructionFile[] {
	const files: (InstructionFile | undefined)[] = loadProjectContextFiles({ cwd, agentDir }).map((f) => file(f.path));
	for (const dir of new Set([canonical(homedir()), ...ancestors(cwd)])) {
		files.push(...rules(join(dir, ".agents", "rules")).filter((r) => r.paths === undefined).map((r) => r.file));
	}
	files.push(file(join(homedir(), ".agents", "AGENTS.md")));
	return unique(files);
}
export function readInstructions(cwd: string, path: string, agentDir: string): InstructionFile[] {
	const startupDirs = new Set([canonical(homedir()), canonical(join(homedir(), ".agents")), canonical(agentDir), ...ancestors(cwd)]);
	const startupPaths = new Set([...startupDirs].map((dir) => canonical(join(dir, "AGENTS.md"))));
	const target = realpathSync(path);
	const files: InstructionFile[] = [];
	for (const dir of new Set([canonical(homedir()), ...ancestors(dirname(target))])) {
		if (!startupDirs.has(dir)) {
			const found = file(join(dir, "AGENTS.md"));
			if (found) files.push(found);
		}
		for (const rule of rules(join(dir, ".agents", "rules"))) {
			if (rule.paths ? rule.paths.some((p) => matchesGlob(relative(dir, target), p)) : !startupDirs.has(dir)) files.push(rule.file);
		}
	}
	return unique(files).filter((f) => !startupPaths.has(f.path));
}
export const instructionFiles = (state: InstructionState): InstructionFile[] => unique([
	...(state.inheritedContextFiles ?? []), ...state.contextFiles, ...(state.discoveredContextFiles ?? []),
]);
export function instructionMessage(files: InstructionFile[]): string {
	const global = canonical(join(homedir(), ".agents", "AGENTS.md"));
	const ordered = [...files.filter((f) => canonical(f.path) !== global), ...files.filter((f) => canonical(f.path) === global)];
	return `<system-reminder>\nApplicable instruction files (separate from the role prompt and task).\n${ordered.map((f) => `\n## ${f.path}${canonical(f.path) === global ? " (preferred global instructions; take precedence over conflicting agent, project, Pi or skill guidance)" : ""}\n\n${f.content}`).join("\n")}\n</system-reminder>`;
}

/** Run snapshots persist independently of the session's system prompt and survive compaction/reopen. */
export function childInstructionExtension(state: InstructionState, agentDir: string, save: () => void): InlineExtension {
	return { name: "delegate-instructions", factory: (pi) => {
		pi.on("before_agent_start", (event) => { event.systemPromptOptions.contextFiles = []; });
		pi.on("context", (event) => {
			const files = instructionFiles(state);
			if (!files.length) return;
			return { messages: [{ role: "user", content: [{ type: "text", text: instructionMessage(files) }], timestamp: 0 }, ...event.messages] };
		});
		pi.on("tool_result", (event) => {
			if (event.toolName !== "read" || event.isError || typeof event.input.path !== "string") return;
			const path = event.input.path.startsWith("~/") ? resolve(homedir(), event.input.path.slice(2)) : resolve(state.cwd, event.input.path);
			const seen = new Set(instructionFiles(state).map((f) => canonical(f.path)));
			const added = readInstructions(state.cwd, path, agentDir).filter((f) => !seen.has(f.path));
			if (!added.length) return;
			(state.discoveredContextFiles ??= []).push(...added);
			save();
		});
	} };
}
