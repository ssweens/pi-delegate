/**
 * mcp.json for a child, read and validated as Pi 1.0.2 reads it (extensions/mcp/config.js and
 * core/mcp-servers.js). Pi exports neither its loader nor its validator, so both are mirrored here,
 * and a child's servers are loaded by this one path whether its role lists `mcp` or `mcp:<server>`.
 *
 * Where Pi 0.99.1 differs, this follows 1.0.2: a project entry without `command`, `url` or `type`
 * overrides a global server's `enabled`, `exposure` and `toolExposure` (0.99.1 rejects it), the
 * `codemode-deferred` exposure is read as `codemode`, names differing only in `-` and `_` clash,
 * `description` must be a string, and `auth` needs a provider and an https or loopback URL.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadedMcpConfig, McpServerConfig, McpServerEntry } from "@earendil-works/pi-coding-agent";

const MCP_EXPOSURES = ["codemode", "deferred", "direct", "hidden"];
const MCP_EXPOSURE_ALIASES: Record<string, string> = { "codemode-deferred": "codemode" };
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"];

const isRecord = (value: unknown): value is Record<string, any> => typeof value === "object" && value !== null && !Array.isArray(value);
const isStringRecord = (value: unknown) => isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
const isExposure = (value: unknown) => typeof value === "string" && MCP_EXPOSURES.includes(value);
const alias = (value: unknown) => typeof value === "string" ? (MCP_EXPOSURE_ALIASES[value] ?? value) : value;
/** Namespace of a server's tools, `mcp__<server>` with `-` read as `_`. */
const mcpNamespace = (server: string) => `mcp__${server.replace(/-/g, "_")}`;
const isOverride = (value: Record<string, any>) => value.command === undefined && value.url === undefined && value.type === undefined;

function isLoopbackRedirectUri(value: string): boolean {
	if (!URL.canParse(value)) return false;
	const url = new URL(value);
	return url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname) && url.search === "" && url.hash === "";
}

function validateOAuth(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return "oauth must be an object";
	if (value.clientId !== undefined && typeof value.clientId !== "string") return "oauth.clientId must be a string";
	if (value.clientSecret !== undefined && typeof value.clientSecret !== "string") return "oauth.clientSecret must be a string";
	const port = value.callbackPort;
	if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) return "oauth.callbackPort must be a port number";
	if (value.callbackUrl !== undefined) {
		if (typeof value.callbackUrl !== "string" || !isLoopbackRedirectUri(value.callbackUrl)) return "oauth.callbackUrl must be an http URI on localhost, 127.0.0.1, or [::1] without query or fragment";
		const urlPort = new URL(value.callbackUrl).port;
		if (urlPort && port !== undefined && Number(urlPort) !== port) return "oauth.callbackUrl and oauth.callbackPort name different ports";
	}
	if (value.scope !== undefined && typeof value.scope !== "string") return "oauth.scope must be a string";
	if (value.clientName !== undefined && (typeof value.clientName !== "string" || !value.clientName.trim())) return "oauth.clientName must be a non-empty string";
	if (value.clientRegistration !== undefined && value.clientRegistration !== "dcr") {
		if (value.clientRegistration !== "cimd") return 'oauth.clientRegistration must be "dcr" or "cimd"';
		if (value.clientId !== undefined || value.clientName !== undefined) return 'oauth.clientRegistration "cimd" cannot be combined with oauth.clientId or oauth.clientName';
		const callback = typeof value.callbackUrl === "string" ? new URL(value.callbackUrl) : undefined;
		if (callback && (callback.hostname === "[::1]" || callback.pathname !== "/callback")) return 'oauth.clientRegistration "cimd" requires oauth.callbackUrl on localhost or 127.0.0.1 with path /callback';
	}
	const metadataUrl = value.authServerMetadataUrl;
	if (metadataUrl !== undefined) {
		const url = typeof metadataUrl === "string" && URL.canParse(metadataUrl) ? new URL(metadataUrl) : undefined;
		if (!url || !(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname)))) return "oauth.authServerMetadataUrl must be an https URL, or http on localhost, 127.0.0.1, or [::1]";
	}
	return undefined;
}

/** One `mcpServers` entry: a copy with exposure aliases resolved, or why Pi would refuse it. */
export function validateMcpServerConfig(name: string, raw: unknown): McpServerConfig | string {
	if (!SERVER_NAME.test(name)) return `invalid server name "${name}" (use letters, digits, "_" and "-")`;
	if (!isRecord(raw)) return `server "${name}" must be an object`;
	const value: Record<string, any> = { ...raw };
	if (value.exposure !== undefined) value.exposure = alias(value.exposure);
	if (isRecord(value.toolExposure)) value.toolExposure = Object.fromEntries(Object.entries(value.toolExposure).map(([tool, entry]) => [tool, alias(entry)]));
	const { type, exposure, enabled, timeout, toolExposure, description } = value;
	const exposures = MCP_EXPOSURES.map((entry) => `"${entry}"`).join(", ");
	if (exposure !== undefined && !isExposure(exposure)) return `server "${name}": exposure must be one of ${exposures}`;
	if (toolExposure !== undefined) {
		if (!isRecord(toolExposure)) return `server "${name}": toolExposure must map tool names to exposures`;
		for (const [tool, entry] of Object.entries(toolExposure)) if (!isExposure(entry)) return `server "${name}": toolExposure "${tool}" must be one of ${exposures}`;
	}
	if (enabled !== undefined && typeof enabled !== "boolean") return `server "${name}": enabled must be a boolean`;
	if (description !== undefined && typeof description !== "string") return `server "${name}": description must be a string`;
	if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0))) return `server "${name}": timeout must be a positive number of seconds`;
	if (type === "sse") return `server "${name}": legacy SSE transport is not supported; use the streamable HTTP URL`;
	if (typeof value.url === "string" && (type === undefined || type === "http" || type === "streamable-http")) {
		if (!URL.canParse(value.url) || !/^https?:$/.test(new URL(value.url).protocol)) return `server "${name}": url must be an http or https URL`;
		if (value.headers !== undefined && !isStringRecord(value.headers)) return `server "${name}": headers must map names to strings`;
		const oauthError = validateOAuth(value.oauth);
		if (oauthError) return `server "${name}": ${oauthError}`;
		if (value.auth !== undefined) {
			if (!isRecord(value.auth) || typeof value.auth.provider !== "string" || !value.auth.provider) return `server "${name}": auth.provider must be a provider name`;
			const url = new URL(value.url);
			if (url.protocol !== "https:" && !LOOPBACK_HOSTS.includes(url.hostname)) return `server "${name}": auth requires an https URL, or http on localhost, 127.0.0.1, or [::1]`;
		}
		return value as McpServerConfig;
	}
	if (typeof value.command === "string" && (type === undefined || type === "stdio")) {
		if (value.args !== undefined && !(Array.isArray(value.args) && value.args.every((arg: unknown) => typeof arg === "string"))) return `server "${name}": args must be an array of strings`;
		if (value.env !== undefined && !isStringRecord(value.env)) return `server "${name}": env must map names to strings`;
		if (value.cwd !== undefined && typeof value.cwd !== "string") return `server "${name}": cwd must be a string`;
		return value as McpServerConfig;
	}
	return `server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`;
}

/** A child's servers and the problems that kept others out, each problem naming its server when it has one. */
export interface ChildMcpConfig extends LoadedMcpConfig { problems: { server?: string; message: string }[] }

/**
 * The agent directory's mcp.json, then the project's `.pi/mcp.json` when the project is trusted. A
 * project entry replaces the global one of the same name, or, without `command`, `url` or `type`,
 * overrides only its `enabled`, `exposure` and `toolExposure`; a project entry cannot set `auth`.
 * Every entry is validated as Pi validates it, and an invalid one is never started. With `names`
 * (a role's `mcp:<server>` list) only those servers are returned, and only their problems reported.
 */
export function loadChildMcpConfig(agentDir: string, cwd: string, projectTrusted: boolean, names?: readonly string[]): ChildMcpConfig {
	const servers = new Map<string, McpServerEntry>();
	const problems: ChildMcpConfig["problems"] = [];
	let autoEnableCodemode: boolean | undefined;
	const read = (path: string, scope: "global" | "project") => {
		if (!existsSync(path)) return;
		const fail = (message: string, server?: string) => problems.push({ ...(server === undefined ? {} : { server }), message: `${path}: ${message}` });
		let parsed: unknown;
		try { parsed = JSON.parse(readFileSync(path, "utf8")); }
		catch (error) { fail(error instanceof Error ? error.message : String(error)); return; }
		if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) { fail(`expected an object with an "mcpServers" object`); return; }
		if (typeof parsed.autoEnableCodemode === "boolean") autoEnableCodemode = parsed.autoEnableCodemode;
		else if (parsed.autoEnableCodemode !== undefined) fail("autoEnableCodemode must be a boolean");
		for (const [name, value] of Object.entries(parsed.mcpServers ?? {})) {
			if (scope === "project" && isRecord(value) && isOverride(value)) {
				const base = servers.get(name);
				if (!base) fail(`server "${name}" needs "command" or "url", or a global server to override`, name);
				else if (Object.keys(value).some((key) => !OVERRIDE_KEYS.includes(key))) fail(`server "${name}": an override can only set ${OVERRIDE_KEYS.join(", ")}`, name);
				else {
					const config = validateMcpServerConfig(name, { ...base.config, ...value });
					if (typeof config === "string") fail(config, name);
					else servers.set(name, { ...base, config, override: path } as McpServerEntry);
				}
				continue;
			}
			const config = validateMcpServerConfig(name, value);
			if (typeof config === "string") { fail(config, name); continue; }
			const clash = [...servers.keys()].find((other) => other !== name && mcpNamespace(other) === mcpNamespace(name));
			if (clash) { fail(`server "${name}" conflicts with "${clash}"`, name); continue; }
			if (scope === "project" && "url" in config && (config as any).auth) { fail(`server "${name}": auth is only allowed in the global mcp.json`, name); continue; }
			servers.set(name, { name, config, source: path, scope });
		}
	};
	read(join(agentDir, "mcp.json"), "global");
	const projectConfig = projectTrusted ? join(cwd, ".pi", "mcp.json") : undefined;
	if (projectConfig) read(projectConfig, "project");
	const wanted = (server?: string) => !names || server === undefined || names.includes(server);
	const kept = problems.filter((problem) => wanted(problem.server));
	return {
		servers: [...servers.values()].filter((server) => wanted(server.name)),
		errors: kept.map((problem) => problem.message),
		problems: kept,
		...(autoEnableCodemode === undefined ? {} : { autoEnableCodemode }),
		...(projectConfig ? { projectConfig } : {}),
	};
}
