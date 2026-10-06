import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

/**
 * The oven CLI, as a command: OVEN_CLI, else `oven` on PATH. pi-delegate does not depend on oven; only a
 * `runtime: "oven"` child needs it, and pi-tether, which does depend on it, usually has it running already.
 */
export function ovenCli(): { command: string; args: string[] } {
	return process.env.OVEN_CLI ? { command: process.env.OVEN_CLI, args: [] } : { command: "oven", args: [] };
}
const run = (args: string[], options: { timeout: number }) => { const cli = ovenCli(); return execute(cli.command, [...cli.args, ...args], options); };
const missingCli = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
let socket: string | undefined;

/** Where oven listens by its own convention (oven's src/paths.ts): $XDG_RUNTIME_DIR/oven, else its XDG state dir. */
export function defaultOvenSocket(): string {
	const runtime = process.env.XDG_RUNTIME_DIR
		? join(process.env.XDG_RUNTIME_DIR, "oven")
		: join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "oven");
	const path = join(runtime, "oven.sock");
	if (Buffer.byteLength(path) <= 100) return path;
	return join("/tmp", `oven-${process.getuid?.() ?? "u"}-${createHash("sha256").update(path).digest("hex").slice(0, 12)}.sock`);
}

/** oven's socket: OVEN_SOCKET, else what the CLI reports, else oven's default location (no CLI installed). */
async function socketPath(): Promise<string> {
	if (process.env.OVEN_SOCKET) return process.env.OVEN_SOCKET;
	if (socket) return socket;
	try {
		const { stdout } = await run(["paths", "--json"], { timeout: 30_000 });
		return socket = JSON.parse(stdout).socket;
	} catch (error) {
		if (!missingCli(error)) throw error;
		return defaultOvenSocket();
	}
}

class NotRunning extends Error {}

function send<T>(path: string, req: Record<string, unknown>, timeoutMs: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const conn = connect(path);
		let buffer = "";
		const timer = setTimeout(() => { conn.destroy(); reject(new Error(`oven did not answer within ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
		conn.setEncoding("utf8");
		conn.on("connect", () => conn.write(`${JSON.stringify(req)}\n`));
		conn.on("data", (chunk: string) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			clearTimeout(timer); conn.end();
			const reply = JSON.parse(buffer.slice(0, newline));
			if (reply.ok) resolve(reply.value); else reject(new Error(`oven: ${reply.error}`));
		});
		conn.on("error", (error: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			reject(error.code === "ENOENT" || error.code === "ECONNREFUSED" ? new NotRunning() : error);
		});
	});
}

/** One request to the oven daemon; starts it with `oven start` when it is not running, then retries once. */
export async function ovenRequest<T = any>(req: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
	const path = await socketPath();
	try { return await send<T>(path, req, timeoutMs); }
	catch (error) {
		if (!(error instanceof NotRunning)) throw error;
		try { await run(["start"], { timeout: 90_000 }); }
		catch (startError) {
			if (!missingCli(startError)) throw startError;
			throw new Error('runtime "oven" needs oven: it is not running and its CLI is not installed. pi-tether starts it; or install oven (github.com/ssweens/oven) and set OVEN_CLI or put `oven` on PATH. The default runtime "in-process" needs nothing.');
		}
		return send<T>(path, req, timeoutMs);
	}
}

/** What oven reports for a slice: its state, turns, and once settled its last answer. */
export interface SliceView { id: string; state: "running" | "idle" | "failed" | "stopped"; turns: number; detail?: string; output?: string }
