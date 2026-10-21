import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { callOven, OvenTransportError } from "./oven-client.js";
import { errorMessage } from "./util/text.ts";

/**
 * A small MCP client for oven, only for `runtime: "oven"` children. pi-delegate does not depend on oven:
 * it calls oven's MCP tools (`oven_create`, `oven_send`, `oven_watch`, `oven_halt`, `oven_expires`) with a JSON-RPC POST
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

/** A browser URL for the same Oven endpoint the MCP client uses. */
export function ovenSliceUrl(slice: string): string {
	return `${ovenUrl()}/slice/${encodeURIComponent(slice)}`;
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

/**
 * When every slice pi-delegate makes expires: an hour after the last call on it, so a child never outlives its parent
 * by more than that. While its parent has the run, it renews it (oven_expires, pi-backend's ovenHeartbeat); an open watch holds it too.
 */
export const OVEN_EXPIRES = { idle: "1h" } as const;

/** How often a parent renews the slices it keeps (delegate runs, Path), well inside OVEN_EXPIRES. A test may shorten it before its first beat. */
export const ovenHeartbeat = { everyMs: 10 * 60_000 };

/** An oven older than slice expiry answered a create without the `expires` it was sent: its slices would never expire. */
export class OvenIgnoresExpiry extends Error {
	constructor(readonly url: string, readonly slice: string, message: string) {
		super(message);
		this.name = "OvenIgnoresExpiry";
	}
}

/**
 * The slice oven just made must keep OVEN_EXPIRES, for delegate runs and Path alike. When it doesn't, the slice is
 * stopped and retired with `call` (`retired` runs once it is), and this throws OvenIgnoresExpiry naming the oven.
 */
export async function requireExpiry(slice: { id: string; expires?: unknown }, call: (tool: string, args: Record<string, unknown>) => Promise<unknown>, retired?: () => void): Promise<void> {
	if (isDeepStrictEqual(slice.expires, OVEN_EXPIRES)) return;
	const cleanup = await call("stop", { slice: slice.id }).then(() => call("retire", { slices: [slice.id] })).then(
		() => { retired?.(); return `its slice ${slice.id} was stopped and retired`; },
		(error) => `stopping and retiring its slice ${slice.id} failed (${errorMessage(error)}); retire it with \`oven retire ${slice.id}\``);
	const url = ovenUrl();
	throw new OvenIgnoresExpiry(url, slice.id, `oven at ${url} did not keep expires ${JSON.stringify(OVEN_EXPIRES)} (it answered ${slice.expires === undefined ? "no expires" : JSON.stringify(slice.expires)}): it predates slice expiry and needs updating, or its slices never expire. ${cleanup}.`);
}

/** An oven call answered that its slice expired. The message is oven's own: `No slice <id>: expired (<why>) at <time>`. */
export class SliceExpired extends Error {
	constructor(readonly slice: string, message: string) {
		super(message);
		this.name = "SliceExpired";
	}
}
/** An oven call answered plain `No slice <id>`: the slice was retired, or expired so long ago that oven forgot it. */
export class SliceGone extends Error {
	constructor(readonly slice: string, message: string) {
		super(message);
		this.name = "SliceGone";
	}
}
/** A watch or wait on a slice that expired ends with this event; it says what oven's later calls on the slice answer. */
export const expiredEvent = (slice: string, event: any): SliceExpired | undefined =>
	event?.type === "expired" ? new SliceExpired(slice, `No slice ${slice}: expired (${event.reason}) at ${event.at}`) : undefined;

/** What oven reports for a slice. */
export interface SliceView { id: string; state: "running" | "idle" | "failed" | "stopped"; stage?: string; reason?: string; turns: number; detail?: string; output?: string; cwd?: string;
	/** As oven keeps it; an oven older than slice expiry has none. */
	expires?: unknown;
	/** A slice waiting to retry stays running with stage "retrying" (newer oven; absent from older ones). */
	retry?: { attempt: number; of: number; at: number; error?: string };
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number };
	changedFiles?: string[] }
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
			case "tool": {
				const expired = /^No slice (\S+): expired \(/.exec(error.message);
				if (expired) throw new SliceExpired(expired[1], error.message);
				const gone = /^No slice (\S+)$/.exec(error.message);
				if (gone) throw new SliceGone(gone[1], `oven: ${error.message}`);
				throw new Error(`oven: ${error.message}`);
			}
			case "protocol": throw new Error(`oven: ${error.message}`);
		}
	}
}
