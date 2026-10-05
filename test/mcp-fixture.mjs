// A stdio MCP server for tests: newline-delimited JSON-RPC with initialize, tools/list (one `echo`
// tool) and tools/call. It writes its pid to argv[2] on start and removes the file when stdin ends,
// which is how a client closes a stdio server, or on SIGTERM.
import { rmSync, writeFileSync } from "node:fs";

const pidFile = process.argv[2];
writeFileSync(pidFile, String(process.pid));
const exit = () => { rmSync(pidFile, { force: true }); process.exit(0); };
process.on("SIGTERM", exit);
process.stdin.on("end", exit);

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const ECHO = { name: "echo", description: "Returns its text.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (let newline; (newline = buffer.indexOf("\n")) >= 0;) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		if (!line) continue;
		const { id, method, params } = JSON.parse(line);
		if (id === undefined) continue; // notifications
		if (method === "initialize") send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } } });
		else if (method === "tools/list") send({ id, result: { tools: [ECHO] } });
		else if (method === "tools/call" && params.name === "echo") send({ id, result: { content: [{ type: "text", text: `echo: ${params.arguments?.text}` }] } });
		else if (method === "ping") send({ id, result: {} });
		else send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
	}
});
