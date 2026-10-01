/**
 * How pi-delegate runs the installed Amp CLI. One definition for the vendored adapter
 * (vendor/amp-acp, bundled into dist/amp-acp.js: executions and the native-opening identity check)
 * and the delegate backend (on-demand observation of an opened thread, todo 044).
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

export interface AmpExportRun {
  /** Exit code; null when the process ended by signal (including the timeout). */
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
}

/**
 * One `amp threads export <id>` in `cwd`: a full JSON dump of the thread. Rejects only when the
 * process cannot start. With timeoutMs the process is killed after that long and timedOut is set.
 */
export async function ampThreadExport(id: string, cwd: string, options: { timeoutMs?: number } = {}): Promise<AmpExportRun> {
  const selected = ampCommand();
  const child = spawn(selected.command, [...selected.prefix, "threads", "export", id], {
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
