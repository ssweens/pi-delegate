/**
 * Machine-wide claims, under <home>/locks/. Each Pi process has its own Coordinator and state dir,
 * so what one Coordinator's in-memory checks enforced for the whole machine is claimed here:
 * one live writer per canonical cwd (and per linked worktree), and one live binding per native
 * session. A claim is a small file naming its holder (PID, host, process token, state dir).
 * proper-lockfile serializes the read-check-write of one claim; it is held for milliseconds, so
 * its own mtime staleness only matters if a process dies inside that window.
 *
 * A claim is stale once its holder is gone: its PID no longer runs, or its state dir lock is no
 * longer fresh (the PID was reused). This process's own claims are always takeable: within one
 * process the Coordinator's in-memory checks decide, and a process has one Coordinator.
 */
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";
import type { WorktreeIdentity } from "../domain/types.js";
import { StringsError } from "../domain/errors.js";
import { ownerAlive, processIdentity, stateDirLocked, type ProcessIdentity } from "./home.js";

export interface Claim { key: string; code: string; subject: string }

interface ClaimFile { version: 1; key: string; holder: string; pid: number; host: string; token: string; stateDir: string; subject: string; at: string }

export const writerClaims = (cwd: string, worktree?: WorktreeIdentity): Claim[] => [
  { key: `cwd:${cwd}`, code: "WRITER_CWD_OWNED", subject: `A writer in ${cwd}` },
  ...(worktree ? [{ key: `worktree:${worktree.gitDir}`, code: "WRITER_WORKTREE_OWNED", subject: `A writer of worktree ${worktree.worktreeRoot}` }] : []),
];

export const sessionClaim = (agent: string, sessionId: string): Claim =>
  ({ key: `session:${agent.toLowerCase()}:${sessionId}`, code: "SESSION_IN_USE", subject: `Native session ${sessionId} (${agent})` });

export class Claims {
  /** key -> this holder's ID, for the claims held now. */
  private readonly held = new Map<string, string>();

  constructor(private readonly dir: string, private readonly stateDir: string) {}

  private path(key: string): string { return join(this.dir, `${createHash("sha256").update(key).digest("hex").slice(0, 40)}.json`); }

  private async exclusive<T>(path: string, work: () => Promise<T>): Promise<T> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(path, { realpath: false, stale: 10_000, retries: { retries: 40, minTimeout: 5, maxTimeout: 100 }, onCompromised: () => undefined });
    } catch (error) {
      throw new StringsError("CLAIM_BUSY", `Cannot take the machine-wide claim ${path}: ${error instanceof Error ? error.message : String(error)}`, true);
    }
    try { return await work(); } finally { await release().catch(() => undefined); }
  }

  private async read(path: string): Promise<ClaimFile | undefined> {
    try {
      const claim = JSON.parse(await readFile(path, "utf8")) as Partial<ClaimFile>;
      return claim.version === 1 && typeof claim.holder === "string" && typeof claim.pid === "number" ? claim as ClaimFile : undefined;
    } catch { return undefined; }
  }

  /** The claim's holder, when another live process holds it. */
  private async liveHolder(claim: ClaimFile | undefined): Promise<ClaimFile | undefined> {
    if (!claim) return undefined;
    const me: ProcessIdentity = processIdentity();
    if (claim.token === me.token) return undefined;
    if (!ownerAlive(claim)) return undefined;
    // Another host cannot be probed; its claim stands. Here, a live PID must still hold its state dir.
    if (claim.host === me.host && !await stateDirLocked(claim.stateDir)) return undefined;
    return claim;
  }

  async acquire(claim: Claim): Promise<void> {
    if (this.held.has(claim.key)) return;
    const path = this.path(claim.key);
    const holder = randomUUID();
    await this.exclusive(path, async () => {
      const other = await this.liveHolder(await this.read(path));
      if (other) throw new StringsError(claim.code, `${claim.subject} is held by Pi process ${other.pid} on ${other.host} (its Coordinator state: ${other.stateDir}).`);
      const me = processIdentity();
      const file: ClaimFile = { version: 1, key: claim.key, holder, pid: me.pid, host: me.host, token: me.token, stateDir: this.stateDir, subject: claim.subject, at: new Date().toISOString() };
      await writeFileAtomic(path, `${JSON.stringify(file)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(path, 0o600);
    });
    this.held.set(claim.key, holder);
  }

  /** All or none: a claim that fails releases the ones this call took. Returns the keys this call took. */
  async acquireAll(claims: readonly Claim[]): Promise<string[]> {
    const taken: string[] = [];
    try {
      for (const claim of claims) {
        if (this.held.has(claim.key)) continue;
        await this.acquire(claim);
        taken.push(claim.key);
      }
    } catch (error) {
      await this.release(taken);
      throw error;
    }
    return taken;
  }

  /** Remove a claim this holder still has. One another holder took over is left alone. */
  async release(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      const holder = this.held.get(key);
      if (!holder) continue;
      this.held.delete(key);
      const path = this.path(key);
      await this.exclusive(path, async () => {
        if ((await this.read(path))?.holder === holder) await rm(path, { force: true });
      }).catch(() => undefined);
    }
  }

  releaseAll(): Promise<void> { return this.release([...this.held.keys()]); }
}
