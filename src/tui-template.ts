import { readFileSync } from "node:fs";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { Role, TuiAgent } from "./roles.ts";

/**
 * The oven agent template a tui child is created from, built from its role file. A role's top-level model,
 * thinking and tools are Pi's (pi-delegate roles are Pi roles), so only a Pi child gets them; Claude and Amp
 * get their own `claude:` / `amp:` sections. Every agent gets the role's description, env and secret names (their values come from the environment at create). Amp
 * takes no system prompt: its instructions lead the first message instead (`taskPrefix`). Oven validates the
 * result and refuses what an agent cannot take, so nothing is dropped silently here.
 */
export function tuiTemplate(role: Role, agent: TuiAgent, instructions: string): { template: Record<string, unknown>; taskPrefix?: string } {
	const { frontmatter: fm } = parseFrontmatter<Record<string, unknown>>(readFileSync(role.file, "utf8"));
	const object = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
	const common: Record<string, unknown> = { name: role.name, ...(role.description ? { description: role.description } : {}),
		...(object(fm.env) ? { env: fm.env } : {}), ...(Array.isArray(fm.secrets) ? { secrets: fm.secrets } : {}) };
	const own = object(fm[agent]);
	switch (agent) {
		case "pi": return { template: { ...common, body: instructions, ...(role.model ? { model: role.model } : {}), ...(role.thinking ? { thinking: role.thinking } : {}),
			...(role.tools && !role.tools.includes("*") ? { tools: role.tools } : {}), ...(own ? { pi: own } : {}) } };
		case "claude": return { template: { ...common, body: instructions, ...(own ? { claude: own } : {}) } };
		case "amp": return { template: { ...common, ...(own ? { amp: own } : {}) }, taskPrefix: instructions };
	}
}
