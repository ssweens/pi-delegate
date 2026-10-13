import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IsolationMode, Profile, WorkerKind, WorkerRole } from "./types.js";
import { errorMessage } from "../../util/text.ts";

import { StringsError } from "./errors.js";
import { agentDir } from "../persistence/home.js";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const KINDS = new Set(["oracle", "finder", "worker", "free"]);
const ISOLATION_MODES = new Set(["shared", "worktree"]);
/** The bounds of a profile that sets none, and the short bound (a wait's default; a finder's turn limit). */
export const ACP_DEFAULTS = { timeoutMs: 900_000, cancellationGraceMs: 5_000, maxOutputBytes: 256_000, shortTimeoutMs: 300_000 } as const;

/** A profile with the default bounds: a direct (agent-named) worker, or a stored worker whose profile is gone. */
export function defaultProfile(agent: string, role: WorkerRole, tools: readonly string[] = []): Profile {
  return { agent, role, tools: [...tools], timeoutMs: ACP_DEFAULTS.timeoutMs, cancellationGraceMs: ACP_DEFAULTS.cancellationGraceMs, maxOutputBytes: ACP_DEFAULTS.maxOutputBytes };
}

const DEFAULTS: Record<string, Profile> = {
  "pi-reviewer": { ...defaultProfile("pi", "read-only", [...READ_ONLY_TOOLS]), kind: "free" },
  "pi-writer": { agent: "pi", role: "writer", kind: "worker", tools: ["read", "grep", "find", "ls", "bash", "edit", "write"], isolation: "shared", timeoutMs: 1_800_000, cancellationGraceMs: 10_000, maxOutputBytes: 512_000 },
  "pi-oracle": { ...defaultProfile("pi", "read-only", [...READ_ONLY_TOOLS]), kind: "oracle" },
  "pi-finder": { ...defaultProfile("pi", "read-only", [...READ_ONLY_TOOLS]), kind: "finder", timeoutMs: ACP_DEFAULTS.shortTimeoutMs, maxTurns: 12 },
};

/** A config file's profiles; undefined when there is no file. */
async function readConfig(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { profiles?: Record<string, unknown> };
    return parsed.profiles ?? {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new StringsError("CONFIG_INVALID", `Cannot load ${path}: ${errorMessage(error)}`);
  }
}

function parseProfile(name: string, raw: unknown): Profile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new StringsError("PROFILE_INVALID", `Profile ${name} must be an object.`);
  const value = raw as Record<string, unknown>;
  const role = value.role;
  const agent = value.agent;
  const tools = value.tools;
  if ((role !== "read-only" && role !== "writer") || typeof agent !== "string" || !Array.isArray(tools) || !tools.every((v) => typeof v === "string")) {
    throw new StringsError("PROFILE_INVALID", `Profile ${name} requires agent, role, and string tools.`);
  }
  if (role === "read-only" && tools.some((tool) => !READ_ONLY_TOOLS.has(tool))) {
    throw new StringsError("POLICY_UNENFORCEABLE", `Read-only profile ${name} contains mutation-capable tool(s).`);
  }
  const kind = value.kind;
  if (kind !== undefined && !KINDS.has(kind as string)) throw new StringsError("PROFILE_INVALID", `Profile ${name} kind must be one of oracle, finder, worker, free.`);
  const isolation = value.isolation;
  if (isolation !== undefined && !ISOLATION_MODES.has(isolation as string)) throw new StringsError("PROFILE_INVALID", `Profile ${name} isolation must be shared or worktree.`);
  const fallbackModels = value.fallbackModels;
  if (fallbackModels !== undefined && (!Array.isArray(fallbackModels) || !fallbackModels.every((v) => typeof v === "string"))) {
    throw new StringsError("PROFILE_INVALID", `Profile ${name} fallbackModels must be a string array.`);
  }
  return {
    agent,
    role,
    ...(kind !== undefined ? { kind: kind as WorkerKind } : {}),
    tools,
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(typeof value.thinking === "string" ? { thinking: value.thinking } : {}),
    ...(fallbackModels !== undefined ? { fallbackModels: fallbackModels as string[] } : {}),
    ...(isolation !== undefined ? { isolation: isolation as IsolationMode } : {}),
    timeoutMs: boundedInteger(value.timeoutMs, ACP_DEFAULTS.timeoutMs, "timeoutMs", 1_000, 86_400_000),
    cancellationGraceMs: boundedInteger(value.cancellationGraceMs, ACP_DEFAULTS.cancellationGraceMs, "cancellationGraceMs", 100, 60_000),
    maxOutputBytes: boundedInteger(value.maxOutputBytes, ACP_DEFAULTS.maxOutputBytes, "maxOutputBytes", 1_024, 10_485_760),
    ...(value.maxTurns !== undefined ? { maxTurns: boundedInteger(value.maxTurns, undefined, "maxTurns", 1, 100) } : {}),
    ...(value.maxAttempts !== undefined ? { maxAttempts: boundedInteger(value.maxAttempts, undefined, "maxAttempts", 1, 5) } : {}),
  };
}

function boundedInteger(value: unknown, fallback: number | undefined, field: string, minimum: number, maximum: number): number {
  if (value === undefined) {
    if (fallback === undefined) throw new StringsError("PROFILE_INVALID", `${field} is required.`);
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new StringsError("PROFILE_INVALID", `${field} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

export async function loadProfiles(cwd: string): Promise<Record<string, Profile>> {
  // User profiles live in Pi's agent dir. Deprecated: ~/.pi/agent/pi-strings.json, where they were
  // before, still loads when the agent dir has none (the two differ only when PI_CODING_AGENT_DIR
  // or PI_AGENT_DIR moves the agent dir). Move the file into the agent dir.
  const user = await readConfig(join(agentDir(), "pi-strings.json")) ?? await readConfig(join(homedir(), ".pi", "agent", "pi-strings.json")) ?? {};
  const project = await readConfig(join(cwd, ".pi", "pi-strings.json")) ?? {};
  const merged: Record<string, unknown> = { ...DEFAULTS, ...user, ...project };
  return Object.fromEntries(Object.entries(merged).map(([name, value]) => [name, parseProfile(name, value)]));
}
