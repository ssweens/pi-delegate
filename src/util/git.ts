/** git, run one way everywhere: in `cwd` (`git -C`), bounded by one timeout, its output as text. */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const GIT_TIMEOUT_MS = 10_000;
const execFileAsync = promisify(execFile);

/** git's stdout. Rejects when git fails, times out or is missing; the error carries its stderr. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS });
	return stdout;
}

/** The same, synchronously, for a caller that cannot await. Throws as `git` rejects; nothing reaches this process's stderr. */
export function gitSync(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
}
