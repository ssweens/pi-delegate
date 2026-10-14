/**
 * This process's identity and the one liveness rule, shared by everything that records an owner: a
 * delegate run record (storage.ts), the Coordinator's state dir and its machine-wide claims (src/acp/persistence).
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

/** This process, as records name it. The token tells a reused PID from its earlier owner. */
export interface ProcessIdentity { pid: number; host: string; token: string; startedAt: string }

/**
 * One identity per process, stable across extension reloads. The slot keeps the key the Coordinator's identity had
 * (its state dir, proc/<pid>-<token>, is named by it), so a reload onto this version keeps finding that dir. A record
 * written with an older, longer token (a run record's full UUID) still reads correctly: tokens are only ever compared
 * for equality with this process's own.
 */
const IDENTITY = Symbol.for("@ssweens/pi-delegate/acp-process/1");
/** ACP worker and opened-session processes must not install root-only interactive extensions. */
export function isPiStringsWorkerProcess(): boolean {
	return process.env.PI_STRINGS_WORKER === "1" || process.env.PI_STRINGS_OPENED === "1";
}

export function processIdentity(): ProcessIdentity {
	const g = globalThis as typeof globalThis & { [IDENTITY]?: ProcessIdentity };
	return g[IDENTITY] ??= { pid: process.pid, host: hostname(), token: randomUUID().replaceAll("-", "").slice(0, 12), startedAt: new Date().toISOString() };
}

/** Whether a process with this PID runs on this host. One we may not signal still runs. */
export function pidAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * Whether the process that recorded this identity is still running. This process is. Another host cannot be probed,
 * so its owner counts as alive. Our PID with another token is an earlier process that reused it, so it is gone.
 */
export function ownerAlive(owner: { pid?: number | undefined; host?: string | undefined; token?: string | undefined }): boolean {
	const me = processIdentity();
	if (owner.token === me.token) return true;
	if (owner.host !== me.host) return true;
	if (!Number.isInteger(owner.pid) || owner.pid === me.pid) return false;
	return pidAlive(owner.pid!);
}
