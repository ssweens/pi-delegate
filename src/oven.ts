import { readFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A small client for oven's HTTP API, only for `runtime: "oven"` children. pi-delegate does not depend on
 * oven: it reaches a running oven at OVEN_URL, else oven's default URL (oven.json's `port`, else 6836 on
 * 127.0.0.1), with the local token oven keeps in its XDG config dir (or OVEN_TOKEN), and checks oven's
 * protocol version once. It never starts oven: pi-tether does, and on macOS oven then stays on as a login item.
 */

/** oven's protocol this client speaks. */
export const OVEN_PROTOCOL = 1;
const DEFAULT_PORT = 6836;

const ovenConfigDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "oven");

export function ovenUrl(): string {
	if (process.env.OVEN_URL) return process.env.OVEN_URL.replace(/\/+$/, "");
	let port = DEFAULT_PORT;
	try { const configured = JSON.parse(readFileSync(join(ovenConfigDir(), "oven.json"), "utf8")).port; if (Number.isInteger(configured)) port = configured; } catch { /* default */ }
	return `http://127.0.0.1:${port}`;
}

function ovenToken(): string | undefined {
	if (process.env.OVEN_TOKEN) return process.env.OVEN_TOKEN;
	try { return readFileSync(join(ovenConfigDir(), "token"), "utf8").trim() || undefined; } catch { return undefined; }
}

export class OvenUnreachable extends Error {
	constructor(url: string) {
		super(`runtime "oven" needs oven, and nothing answers at ${url}. Start it with \`oven start\` (pi-tether starts it for you), or set OVEN_URL. The default runtime "in-process" needs nothing.`);
	}
}

function send(method: string, path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<{ status: number; response: IncomingMessage }> {
	const base = ovenUrl();
	return new Promise((resolve, reject) => {
		const target = new URL(path, `${base}/`);
		const text = body === undefined ? undefined : JSON.stringify(body);
		const token = ovenToken();
		const req = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, { method, signal,
			headers: { ...(text ? { "content-type": "application/json", "content-length": Buffer.byteLength(text) } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } });
		const timer = timeoutMs > 0 ? setTimeout(() => req.destroy(new Error(`oven did not answer within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs) : undefined;
		req.on("response", (response) => { clearTimeout(timer); resolve({ status: response.statusCode ?? 0, response }); });
		req.on("error", (error: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			reject(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENOTFOUND", "EADDRNOTAVAIL"].includes(error.code ?? "") ? new OvenUnreachable(base) : error);
		});
		req.end(text);
	});
}

async function read(response: IncomingMessage): Promise<string> {
	let out = "";
	response.setEncoding("utf8");
	for await (const chunk of response) out += chunk;
	return out;
}

let checked: Promise<void> | undefined;
/** Rejects when nothing answers, or when oven speaks another protocol. Checked once per process. */
function checkProtocol(): Promise<void> {
	checked ??= (async () => {
		const { status, response } = await send("GET", "health", undefined, 5_000);
		let health: any = {};
		try { health = JSON.parse(await read(response)); } catch { /* not oven */ }
		if (status !== 200 || health.oven !== true) throw new OvenUnreachable(ovenUrl());
		if (health.protocol !== OVEN_PROTOCOL) throw new Error(`oven at ${ovenUrl()} speaks protocol ${health.protocol}; pi-delegate speaks ${OVEN_PROTOCOL}. Update the older one.`);
	})();
	checked.catch(() => { checked = undefined; });
	return checked;
}

async function post(op: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<IncomingMessage> {
	await checkProtocol();
	const { status, response } = await send("POST", `api/${op}`, params, timeoutMs, signal);
	if (status === 200) return response;
	const body = await read(response);
	let message = body;
	try { message = JSON.parse(body).error ?? body; } catch { /* plain text */ }
	throw new Error(`oven: ${message}`);
}

/** One request to oven. */
export async function ovenRequest<T = any>(op: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
	const reply = JSON.parse(await read(await post(op, params, timeoutMs)));
	if (!reply.ok) throw new Error(`oven: ${reply.error}`);
	return reply.value as T;
}

/** What oven reports for a slice: its state, turns, and once settled its last answer. */
export interface SliceView { id: string; state: "running" | "idle" | "failed" | "stopped"; turns: number; detail?: string; output?: string; cwd?: string }
export type WatchEvent = { type: "settled"; slice: SliceView; output: string } | { type: "snapshot" | "message" | "partial" | "tool" | "state"; [key: string]: unknown };

/** oven's watch stream for a slice, until it settles (Server-Sent Events, one JSON event each). */
export async function* ovenWatch(slice: string, signal?: AbortSignal): AsyncGenerator<WatchEvent> {
	const response = await post("watch", { slice, untilSettled: true }, 0, signal);
	response.setEncoding("utf8");
	let buffer = "";
	try {
		for await (const chunk of response) {
			buffer += chunk;
			let end: number;
			while ((end = buffer.indexOf("\n\n")) >= 0) {
				const frame = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				const event = /^event: (.*)$/m.exec(frame)?.[1] ?? "message";
				const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
				if (event === "end") return;
				if (event === "error") throw new Error(`oven: ${JSON.parse(data).error}`);
				if (data) yield JSON.parse(data);
			}
		}
	} finally { response.destroy(); }
}
