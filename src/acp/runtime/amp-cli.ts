/**
 * How pi-delegate runs the installed Amp CLI. One definition for the vendored adapter
 * (vendor/amp-acp, bundled into dist/amp-acp.js: executions and the native-opening identity check)
 * and the delegate backend (on-demand observation of an opened thread, todo 044; labels and cost
 * of Amp threads, todo 058).
 *
 * AMP_CLI_PATH selects the binary; a .js/.cjs/.mjs path runs under this Node.
 */
import { spawn } from "node:child_process";

export function ampCommand(): { command: string; prefix: string[] } {
  const configured = process.env.AMP_CLI_PATH?.trim() || "amp";
  return /\.(?:c|m)?js$/i.test(configured)
    ? { command: process.execPath, prefix: [configured] }
    : { command: configured, prefix: [] };
}

export interface AmpRun {
  /** Exit code; null when the process ended by signal (including the timeout). */
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
}

/**
 * One Amp CLI command in `cwd`. Rejects only when the process cannot start. With timeoutMs the
 * process is killed after that long and timedOut is set.
 */
export async function runAmp(args: readonly string[], cwd: string, options: { timeoutMs?: number } = {}): Promise<AmpRun> {
  const selected = ampCommand();
  const child = spawn(selected.command, [...selected.prefix, ...args], {
    cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  let timedOut = false;
  const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode: number | null) => resolve(exitCode));
    });
    return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString().trim(), timedOut };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One `amp threads export <id>`: a full JSON dump of the thread. */
export function ampThreadExport(id: string, cwd: string, options: { timeoutMs?: number } = {}): Promise<AmpRun> {
  return runAmp(["threads", "export", id], cwd, options);
}

/** One `amp threads label <id> <labels...>`: adds labels, keeping the ones the thread has. */
export function ampThreadLabel(id: string, labels: readonly string[], cwd: string, options: { timeoutMs?: number } = {}): Promise<AmpRun> {
  return runAmp(["threads", "label", id, ...labels], cwd, options);
}

/** One `amp threads usage <id>`: the thread's display cost (`Cost: $…`) and other usage lines. */
export function ampThreadUsage(id: string, cwd: string, options: { timeoutMs?: number } = {}): Promise<AmpRun> {
  return runAmp(["threads", "usage", id], cwd, options);
}

/** The amount on the `Cost: $X` line of `amp threads usage`, or undefined when there is none. */
export function parseAmpCost(text: string): number | undefined {
  const match = /^\s*Cost:\s*\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*$/m.exec(text.replace(/\x1b\[[0-9;]*m/g, ""));
  if (!match) return undefined;
  const amount = Number(match[1]!.replaceAll(",", ""));
  return Number.isFinite(amount) ? amount : undefined;
}

/** An Amp thread ID (T-ID). */
export const AMP_THREAD_ID = /^T-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Amp's label rules (the CLI's own errors): lowercase alphanumerics and hyphens, starting with an
 * alphanumeric, at most 32 characters.
 */
export const AMP_LABEL = /^[a-z0-9][a-z0-9-]{0,31}$/;
