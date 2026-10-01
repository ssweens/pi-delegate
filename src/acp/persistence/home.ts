/**
 * Where Coordinators keep state (ADR 0001: one Coordinator per Pi process).
 *
 * <agentDir>/pi-strings/                  the Coordinator home, shared by every Pi process
 *   proc/<pid>-<token>/                    one process's state dir: state.json, requests/, acpx/, owner.json
 *   locks/                                 machine-wide claims: one live writer per cwd, one live binding per native session
 *
 * The agent dir is Pi's (its getAgentDir(): PI_CODING_AGENT_DIR, else ~/.pi/agent). PI_AGENT_DIR, which
 * the Coordinator read before, still overrides it.
 *
 * The legacy single state dir, from before per-process state, is read only to adopt from. It is
 * where that Coordinator kept it: <PI_AGENT_DIR, else ~/.pi/agent>/pi-strings/state.json, which is
 * the home above unless PI_CODING_AGENT_DIR moves Pi's agent dir.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";

/**
 * Pi's getAgentDir(), copied (test/acp-processes.test.ts checks they agree; Windows shell paths
 * aside). Importing it would load all of @earendil-works/pi-coding-agent into every module here,
 * and that measurably slowed the Coordinator's event handling in tests.
 */
function piAgentDir(): string {
  const dir = process.env.PI_CODING_AGENT_DIR;
  if (!dir) return join(homedir(), ".pi", "agent");
  if (dir === "~") return homedir();
  if (dir.startsWith("~/")) return join(homedir(), dir.slice(2));
  return dir.startsWith("file://") ? fileURLToPath(dir) : dir;
}

export function agentDir(): string { return process.env.PI_AGENT_DIR || piAgentDir(); }

export function coordinatorHome(): string { return join(agentDir(), "pi-strings"); }

/** The agent dir as the Coordinator read it before per-process state, which ignored PI_CODING_AGENT_DIR. */
export function legacyAgentDir(): string { return process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent"); }

/** The single state dir from before per-process state. */
export function legacyStateDir(): string { return join(legacyAgentDir(), "pi-strings"); }

/** This process, as its state dir and its claims name it. The token tells a reused PID from its earlier owner. */
export interface ProcessIdentity { pid: number; host: string; token: string; startedAt: string }

const IDENTITY = Symbol.for("@ssweens/pi-delegate/acp-process/1");
export function processIdentity(): ProcessIdentity {
  const g = globalThis as typeof globalThis & { [IDENTITY]?: ProcessIdentity };
  return g[IDENTITY] ??= { pid: process.pid, host: hostname(), token: randomUUID().replaceAll("-", "").slice(0, 12), startedAt: new Date().toISOString() };
}

/** This process's own state dir. Stable for the process, so a Coordinator rebuilt after a shutdown finds its state. */
export function processStateDir(home: string): string {
  const me = processIdentity();
  return join(home, "proc", `${me.pid}-${me.token}`);
}

export const OWNER_FILE = "owner.json";
/** The state dir lock's staleness, as StateStore takes it: refreshed every 10 s by a live owner. */
export const STATE_LOCK_STALE_MS = 30_000;

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * Whether a process that recorded this identity is still running. Another host cannot be probed,
 * so its owner counts as alive. Our PID with another token is an earlier process that reused it.
 */
export function ownerAlive(owner: Pick<ProcessIdentity, "pid" | "host" | "token">): boolean {
  const me = processIdentity();
  if (owner.token === me.token) return true;
  if (owner.host !== me.host) return true;
  if (!Number.isInteger(owner.pid) || owner.pid === me.pid) return false;
  return pidAlive(owner.pid);
}

export async function readOwner(stateDir: string): Promise<ProcessIdentity | undefined> {
  try {
    const owner = JSON.parse(await readFile(join(stateDir, OWNER_FILE), "utf8")) as Partial<ProcessIdentity>;
    return typeof owner.pid === "number" && typeof owner.host === "string" && typeof owner.token === "string" ? owner as ProcessIdentity : undefined;
  } catch { return undefined; }
}

/** Whether a state dir's lock is held and fresh. */
export async function stateDirLocked(stateDir: string): Promise<boolean> {
  return lockfile.check(stateDir, { realpath: false, stale: STATE_LOCK_STALE_MS }).catch(() => false);
}

/**
 * Who holds a state dir now. With an owner file: its process, while it runs and keeps the lock
 * fresh (so a PID reused by an unrelated process does not count). Without one (the legacy dir, or
 * a dir an older version wrote): a fresh lock, whose holder is unknown.
 */
export async function stateDirHolder(stateDir: string): Promise<{ live: boolean; owner?: ProcessIdentity }> {
  const owner = await readOwner(stateDir);
  if (!owner) return { live: await stateDirLocked(stateDir) };
  if (owner.token === processIdentity().token) return { live: true, owner };
  return { live: ownerAlive(owner) && await stateDirLocked(stateDir), owner };
}

export function describeOwner(owner: ProcessIdentity | undefined): string {
  return owner ? `Pi process ${owner.pid} on ${owner.host}` : "another Pi process (PID unknown)";
}
