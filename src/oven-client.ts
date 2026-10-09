export type OvenTransportFailure = "unreachable" | "unauthorized" | "http" | "closed" | "rpc" | "tool" | "protocol";

export class OvenTransportError extends Error {
	constructor(readonly kind: OvenTransportFailure, message: string, readonly status?: number) {
		super(message);
		this.name = "OvenTransportError";
	}
}

export interface OvenCall {
	url: string;
	token?: string;
	tool: string;
	args: Record<string, unknown>;
	signal?: AbortSignal;
	onEvent?: (event: any) => void;
}

let id = 0;

/** Call an Oven MCP tool without deciding how the caller presents failures. */
export async function callOven<T = unknown>({ url, token, tool, args, signal, onEvent }: OvenCall): Promise<T> {
	const call = ++id;
	let response: Response;
	try {
		response = await fetch(`${url.replace(/\/+$/, "")}/mcp`, {
			method: "POST",
			signal,
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
			body: JSON.stringify({ jsonrpc: "2.0", id: call, method: "tools/call", params: { name: `oven_${tool}`, arguments: args, _meta: { progressToken: call } } }),
		});
	} catch (error) {
		if (signal?.aborted) throw error;
		throw new OvenTransportError("unreachable", String(error));
	}

	if (response.status === 401) throw new OvenTransportError("unauthorized", "the Oven token was refused", response.status);
	if (!response.ok) throw new OvenTransportError("http", (await response.text()).slice(0, 300), response.status);

	let reply: any;
	if (response.headers.get("content-type")?.includes("text/event-stream")) {
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
				buffer += decoder.decode(chunk, { stream: true });
				for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
					const data = buffer.slice(0, end).split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("");
					buffer = buffer.slice(end + 2);
					if (!data) continue;
					let message: any;
					try { message = JSON.parse(data); } catch { throw new OvenTransportError("protocol", "Oven returned malformed SSE JSON"); }
					if (message.method === "notifications/progress") {
						let event: any;
						try { event = JSON.parse(message.params.message); } catch { throw new OvenTransportError("protocol", "Oven returned malformed progress JSON"); }
						if (event.type !== "ping") onEvent?.(event);
					} else if (message.id === call) reply = message;
				}
			}
		} catch (error) {
			if (signal?.aborted) throw error;
			if (error instanceof OvenTransportError) throw error;
			throw new OvenTransportError("unreachable", String(error));
		}
		if (!reply) throw new OvenTransportError("closed", `Oven closed oven_${tool} before it answered`);
	} else {
		try { reply = await response.json(); }
		catch { throw new OvenTransportError("protocol", "Oven returned malformed JSON"); }
	}

	if (reply.error) throw new OvenTransportError("rpc", String(reply.error.message ?? reply.error));
	const text = (reply.result?.content ?? []).map((part: any) => part.text).join("");
	if (reply.result?.isError) throw new OvenTransportError("tool", text);
	try { return JSON.parse(text) as T; }
	catch { return text as T; }
}
