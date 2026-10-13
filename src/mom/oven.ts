import { callOven, OvenTransportError } from "../oven-client.js";
import { ovenToken, ovenUrl } from "../oven.js";

/** Path's caller-specific Oven error. The transport remains shared with delegate runs. */
export class OvenUnreachable extends Error {
	constructor(readonly url: string) {
		super(`Path needs oven: nothing answers at ${url}. Start it with \`oven start\` (or the oven tray app); Path reconnects by itself.`);
	}
}

export { ovenUrl, ovenSliceUrl } from "../oven.js";

export async function oven<T = any>(tool: string, args: Record<string, unknown>, options: { onEvent?: (event: any) => void; signal?: AbortSignal } = {}): Promise<T> {
	const url = ovenUrl();
	try {
		return await callOven<T>({ url, token: ovenToken(), tool, args, ...options });
	} catch (error) {
		if (!(error instanceof OvenTransportError)) throw error;
		switch (error.kind) {
			case "unreachable":
			case "closed": throw new OvenUnreachable(url);
			case "unauthorized": throw new Error(`Path's oven at ${url} refused the token.`);
			case "http": throw new Error(`oven answered ${error.status}: ${error.message}`);
			case "rpc":
			case "tool":
			case "protocol": throw new Error(error.message);
		}
	}
}

/** The daemon's `/health` document. */
export async function ovenHealth(): Promise<{ pid: number }> {
	return (await fetch(`${ovenUrl()}/health`)).json() as Promise<{ pid: number }>;
}
