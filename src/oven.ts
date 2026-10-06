import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A small MCP client for oven, only for `runtime: "oven"` children. pi-delegate does not depend on oven:
 * it calls oven's MCP tools (`oven_create`, `oven_send`, `oven_watch`, `oven_halt`) with a JSON-RPC POST
 * to OVEN_URL (else oven.json's `port`, else 6836 on 127.0.0.1) at `/mcp`, with the local token oven keeps
 * in its XDG config dir (or OVEN_TOKEN). It never starts oven.
 */

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
		super(`runtime "oven" needs oven, and nothing answers at ${url}. Start it with \`oven start\` or the oven tray app, or set OVEN_URL. The default runtime "in-process" needs nothing.`);
	}
}

/** What oven reports for a slice. */
export interface SliceView { id: string; state: "running" | "idle" | "failed" | "stopped"; stage?: string; reason?: string; turns: number; detail?: string; output?: string; cwd?: string }
export interface Settled { type: "settled"; slice: SliceView; output: string }

let id = 0;
/**
 * Call `oven_<tool>`. A streaming tool answers Server-Sent Events: progress notifications (each event as
 * JSON in their message, `ping`s skipped) go to `onEvent`, and the JSON-RPC result ends the call.
 */
export async function ovenCall<T = any>(tool: string, args: Record<string, unknown>, options: { signal?: AbortSignal; onEvent?: (event: any) => void } = {}): Promise<T> {
	const url = ovenUrl(), token = ovenToken(), call = ++id;
	let res: Response;
	try {
		res = await fetch(`${url}/mcp`, {
			method: "POST", signal: options.signal,
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
			body: JSON.stringify({ jsonrpc: "2.0", id: call, method: "tools/call", params: { name: `oven_${tool}`, arguments: args, _meta: { progressToken: call } } }),
		});
	} catch (error) {
		if (options.signal?.aborted) throw error;
		throw new OvenUnreachable(url);
	}
	if (res.status === 401) throw new Error(`oven at ${url} refused the token: pi-delegate reads ${join(ovenConfigDir(), "token")} (or OVEN_TOKEN).`);
	if (!res.ok) throw new Error(`oven at ${url} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
	let reply: any;
	if (res.headers.get("content-type")?.includes("text/event-stream")) {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
			buffer += decoder.decode(chunk, { stream: true });
			let end: number;
			while ((end = buffer.indexOf("\n\n")) >= 0) {
				const data = buffer.slice(0, end).split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
				buffer = buffer.slice(end + 2);
				if (!data) continue;
				const message = JSON.parse(data);
				if (message.method === "notifications/progress") {
					const event = JSON.parse(message.params.message);
					if (event.type !== "ping") options.onEvent?.(event);
				} else if (message.id === call) reply = message;
			}
		}
		if (!reply) throw new Error(`oven closed oven_${tool} before it answered`);
	} else reply = await res.json();
	if (reply.error) throw new Error(`oven: ${reply.error.message}`);
	const text = (reply.result?.content ?? []).map((c: any) => c.text).join("");
	if (reply.result?.isError) throw new Error(`oven: ${text}`);
	try { return JSON.parse(text) as T; } catch { return text as T; }
}
