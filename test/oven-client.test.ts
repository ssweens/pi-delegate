import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { callOven, OvenTransportError } from "../src/oven-client.ts";

const originalFetch = globalThis.fetch;
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const requestBody = (init: RequestInit | undefined) => JSON.parse(String(init?.body));

afterEach(() => { globalThis.fetch = originalFetch; });

test("calls a JSON response with the Oven tool name and token", async () => {
	let authorization = "";
	globalThis.fetch = async (_input, init) => {
		const request = requestBody(init);
		authorization = String(new Headers(init?.headers).get("authorization"));
		assert.equal(request.params.name, "oven_status");
		return jsonResponse({ result: { content: [{ text: JSON.stringify({ state: "idle" }) }] } });
	};
	const result = await callOven<{ state: string }>({ url: "http://oven.test///", token: "secret", tool: "status", args: {} });
	assert.deepEqual(result, { state: "idle" });
	assert.equal(authorization, "Bearer secret");
});

test("emits non-ping SSE progress and returns the matching result", async () => {
	const events: unknown[] = [];
	globalThis.fetch = async (_input, init) => {
		const request = requestBody(init);
		const progress = { jsonrpc: "2.0", method: "notifications/progress", params: { message: JSON.stringify({ type: "progress", stage: "working" }) } };
		const ping = { jsonrpc: "2.0", method: "notifications/progress", params: { message: JSON.stringify({ type: "ping" }) } };
		const result = { jsonrpc: "2.0", id: request.id, result: { content: [{ text: JSON.stringify("settled") }] } };
		const body = [progress, ping, result].map(message => `data: ${JSON.stringify(message)}\n\n`).join("");
		return new Response(body, { headers: { "content-type": "text/event-stream" } });
	};
	const result = await callOven<string>({ url: "http://oven.test", tool: "watch", args: {}, onEvent: event => events.push(event) });
	assert.equal(result, "settled");
	assert.deepEqual(events, [{ type: "progress", stage: "working" }]);
});

test("classifies HTTP, RPC, tool, and protocol failures at the transport boundary", async () => {
	const cases: { response: Response; kind: OvenTransportError["kind"] }[] = [
		{ response: jsonResponse({}, 401), kind: "unauthorized" },
		{ response: jsonResponse({}, 503), kind: "http" },
		{ response: jsonResponse({ error: { message: "bad request" } }), kind: "rpc" },
		{ response: jsonResponse({ result: { isError: true, content: [{ text: "tool failed" }] } }), kind: "tool" },
		{ response: new Response("not json", { headers: { "content-type": "application/json" } }), kind: "protocol" },
	];
	for (const { response, kind } of cases) {
		globalThis.fetch = async () => response;
		await assert.rejects(callOven({ url: "http://oven.test", tool: "status", args: {} }), error => error instanceof OvenTransportError && error.kind === kind);
	}
});

test("classifies a streaming response without a result as closed", async () => {
	globalThis.fetch = async () => new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream" } });
	await assert.rejects(callOven({ url: "http://oven.test", tool: "watch", args: {} }), error => error instanceof OvenTransportError && error.kind === "closed");
});

test("preserves an aborted fetch error", async () => {
	const controller = new AbortController();
	let rejectFetch!: (error: unknown) => void;
	globalThis.fetch = async (_input, init) => {
		await new Promise((_resolve, reject) => {
			rejectFetch = reject;
			init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
		});
		throw new Error("unreachable");
	};
	const pending = callOven({ url: "http://oven.test", tool: "watch", args: {}, signal: controller.signal });
	controller.abort();
	rejectFetch(new DOMException("aborted", "AbortError"));
	await assert.rejects(pending, error => error instanceof DOMException && error.name === "AbortError");
});
