/**
 * Machine-wide claims, under <home>/locks/. Each Pi process has its own Coordinator and state dir,
 * so what one Coordinator's in-memory checks enforced for the whole machine is claimed here:
 * one live writer per canonical cwd (and per linked worktree), and one live binding per native
 * session. A claim is a small file naming its holder (PID, host, process token, state dir).
 * proper-lockfile serializes the read-check-write of one claim. It is held for milliseconds, so
 * its staleness is the shortest proper-lockfile allows, and a lock attempt waits longer than that:
 * a process killed inside the window delays the claim by seconds, never blocks it.
 *
 * A claim is stale once its holder is gone: its PID no longer runs, or its state dir lock is no
 * longer fresh (the PID was reused). This process's own claims are always takeable: within one
 * process the Coordinator's in-memory checks decide, and a process has one Coordinator. Workers in
 * one process can share a claim (a shared writer and a worktree writer in one linked worktree both
 * hold its cwd), so each acquisition is counted, and the file goes with the last release.
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

/** The claim mutex's staleness: its critical section takes milliseconds, and its holder refreshes it every second. */
const MUTEX_STALE_MS = 2_000;

interface ClaimFile { version: 1; key: string; holder: string; pid: number; host: string; token: string; stateDir: string; subject: string; at: string }

export const writerClaims = (cwd: string, worktree?: WorktreeIdentity): Claim[] => [
  { key: `cwd:${cwd}`, code: "WRITER_CWD_OWNED", subject: `A writer in ${cwd}` },
  ...(worktree ? [{ key: `worktree:${worktree.gitDir}`, code: "WRITER_WORKTREE_OWNED", subject: `A writer of worktree ${worktree.worktreeRoot}` }] : []),
];

export const sessionClaim = (agent: string, sessionId: string): Claim =>
  ({ key: `session:${agent.toLowerCase()}:${sessionId}`, code: "SESSION_IN_USE", subject: `Native session ${sessionId} (${agent})` });

export class Claims {
  /** This holder's ID in every claim file it writes: a file with another ID was taken over. */
  private readonly holder = randomUUID();
  /** key -> how many acquisitions of it this holder has not released. */
  private readonly held = new Map<string, number>();

  constructor(private readonly dir: string, private readonly stateDir: string) {}

  private path(key: string): string { return join(this.dir, `${createHash("sha256").update(key).digest("hex").slice(0, 40)}.json`); }

  private async exclusive<T>(path: string, work: () => Promise<T>): Promise<T> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    let release: () => Promise<void>;
    try {
      // Stale after 2 s (proper-lockfile's minimum); about 5.6 s of retries outlast a dead holder's lock.
      release = await lockfile.lock(path, { realpath: false, stale: MUTEX_STALE_MS, retries: { retries: 60, minTimeout: 5, maxTimeout: 100 }, onCompromised: () => undefined });
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

  /** Take a claim, or count one more holder of a claim this process has. Each acquire needs its own release. */
  async acquire(claim: Claim): Promise<void> {
    const count = this.held.get(claim.key);
    if (count) { this.held.set(claim.key, count + 1); return; }
    const path = this.path(claim.key);
    const holder = this.holder;
    await this.exclusive(path, async () => {
      const other = await this.liveHolder(await this.read(path));
      if (other) throw new StringsError(claim.code, `${claim.subject} is held by Pi process ${other.pid} on ${other.host} (its Coordinator state: ${other.stateDir}).`);
      const me = processIdentity();
      const file: ClaimFile = { version: 1, key: claim.key, holder, pid: me.pid, host: me.host, token: me.token, stateDir: this.stateDir, subject: claim.subject, at: new Date().toISOString() };
      await writeFileAtomic(path, `${JSON.stringify(file)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(path, 0o600);
    });
    this.held.set(claim.key, (this.held.get(claim.key) ?? 0) + 1);
  }

  /** All or none: a claim that fails releases the ones this call took. Returns the keys this call holds, to release once. */
  async acquireAll(claims: readonly Claim[]): Promise<string[]> {
    const taken: string[] = [];
    try {
      for (const claim of claims) {
        await this.acquire(claim);
        taken.push(claim.key);
      }
    } catch (error) {
      await this.release(taken);
      throw error;
    }
    return taken;
  }

  /** Release one acquisition of each key. The last one removes the claim, unless another holder took it over. */
  async release(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      const count = this.held.get(key);
      if (!count) continue;
      if (count > 1) { this.held.set(key, count - 1); continue; }
      this.held.delete(key);
      const path = this.path(key);
      await this.exclusive(path, async () => {
        if ((await this.read(path))?.holder === this.holder) await rm(path, { force: true });
      }).catch(() => undefined);
    }
  }

  releaseAll(): Promise<void> {
    for (const key of this.held.keys()) this.held.set(key, 1);
    return this.release([...this.held.keys()]);
  }
}
