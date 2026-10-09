import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { callOven, OvenTransportError } from "./oven-client.js";

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

export function ovenToken(): string | undefined {
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

/** Call `oven_<tool>` with delegate-specific configuration and error wording. */
export async function ovenCall<T = any>(tool: string, args: Record<string, unknown>, options: { signal?: AbortSignal; onEvent?: (event: any) => void } = {}): Promise<T> {
	const url = ovenUrl();
	try {
		return await callOven<T>({ url, token: ovenToken(), tool, args, ...options });
	} catch (error) {
		if (!(error instanceof OvenTransportError)) throw error;
		switch (error.kind) {
			case "unreachable": throw new OvenUnreachable(url);
			case "unauthorized": throw new Error(`oven at ${url} refused the token: pi-delegate reads ${join(ovenConfigDir(), "token")} (or OVEN_TOKEN).`);
			case "http": throw new Error(`oven at ${url} answered ${error.status}: ${error.message}`);
			case "closed": throw new Error(`oven closed oven_${tool} before it answered`);
			case "rpc":
			case "tool":
			case "protocol": throw new Error(`oven: ${error.message}`);
		}
	}
}
