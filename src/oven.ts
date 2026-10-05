import { execFile } from "node:child_process";
import { connect } from "node:net";
import { promisify } from "node:util";

const run = promisify(execFile);
/** The oven CLI: OVEN_CLI, else `oven` on PATH. It owns oven's paths, so its socket is read from it, never guessed. */
const cli = () => process.env.OVEN_CLI || "oven";
let socket: string | undefined;

async function socketPath(): Promise<string> {
	if (process.env.OVEN_SOCKET) return process.env.OVEN_SOCKET;
	if (socket) return socket;
	const { stdout } = await run(cli(), ["paths", "--json"], { timeout: 30_000 });
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
		await run(cli(), ["start"], { timeout: 90_000 });
		return send<T>(path, req, timeoutMs);
	}
}

/** What oven reports for a slice: its state, turns, and once settled its last answer. */
export interface SliceView { id: string; state: "running" | "idle" | "failed" | "stopped"; turns: number; detail?: string; output?: string }
