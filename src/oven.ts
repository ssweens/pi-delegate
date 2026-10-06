import { execFile } from "node:child_process";
import { connect } from "node:net";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

/**
 * The oven CLI, as a command: OVEN_CLI, else the `oven` dependency this package installs (run with this
 * node), else `oven` on PATH. Nothing has to be linked or configured. oven owns its paths, so its socket
 * is read from it, never guessed.
 */
export function ovenCli(): { command: string; args: string[] } {
	if (process.env.OVEN_CLI) return { command: process.env.OVEN_CLI, args: [] };
	try {
		const bin = join(dirname(createRequire(import.meta.url).resolve("oven/package.json")), "bin", "oven.mjs");
		if (existsSync(bin)) return { command: process.execPath, args: [bin] };
	} catch { /* not installed */ }
	return { command: "oven", args: [] };
}
const run = (args: string[], options: { timeout: number }) => { const cli = ovenCli(); return execute(cli.command, [...cli.args, ...args], options); };
let socket: string | undefined;

async function socketPath(): Promise<string> {
	if (process.env.OVEN_SOCKET) return process.env.OVEN_SOCKET;
	if (socket) return socket;
	const { stdout } = await run(["paths", "--json"], { timeout: 30_000 });
	return socket = JSON.parse(stdout).socket;
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
		await run(["start"], { timeout: 90_000 });
		return send<T>(path, req, timeoutMs);
	}
}

/** What oven reports for a slice: its state, turns, and once settled its last answer. */
export interface SliceView { id: string; state: "running" | "idle" | "failed" | "stopped"; turns: number; detail?: string; output?: string }
