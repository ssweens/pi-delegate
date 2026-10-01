import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import type { PiRpcEvent, PiRpcProcess } from "../../vendor/pi-acp/src/pi-rpc/process.ts";

// The vendored session module is type-checked by tsconfig.vendor.json, not by the stricter root
// config that covers tests, so load it through a non-literal specifier to keep each scope intact.
const sessionModulePath: string = "../../vendor/pi-acp/src/acp/session.ts";
const { PiAcpSession } = (await import(sessionModulePath)) as {
  PiAcpSession: new (opts: { sessionId: string; cwd: string; mcpServers: []; proc: PiRpcProcess; conn: AgentSideConnection }) => object;
};

function harness(): { emit: (event: PiRpcEvent) => void; updates: SessionNotification["update"][]; settle: () => Promise<void> } {
  let handler: ((event: PiRpcEvent) => void) | undefined;
  const updates: SessionNotification["update"][] = [];
  const proc = { onEvent: (cb: (event: PiRpcEvent) => void) => { handler = cb; return () => undefined; } } as unknown as PiRpcProcess;
  const conn = { sessionUpdate: async (notification: SessionNotification) => { updates.push(notification.update); } } as unknown as AgentSideConnection;
  new PiAcpSession({ sessionId: "s1", cwd: "/work", mcpServers: [], proc, conn });
  return {
    emit: event => { assert.ok(handler); handler(event); },
    updates,
    settle: () => new Promise(resolve => setImmediate(resolve)),
  };
}

test("delta-only Pi >=0.99 RPC toolcall stream surfaces the tool call at toolcall_start and attributes argument deltas", async () => {
  const { emit, updates, settle } = harness();
  // Wire shape documented in pi-coding-agent docs/json.md "Reconstruct streaming messages":
  // toolcall_start -> contentIndex, id, toolName; toolcall_delta -> contentIndex, delta; toolcall_end -> contentIndex, toolCall.
  emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "call_1", toolName: "read" } });
  emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: "{\"path\":\"src/" } });
  emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: "a.ts\"}" } });
  emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: { type: "toolCall", id: "call_1", name: "read", arguments: { path: "src/a.ts" } } } });
  await settle();

  assert.deepEqual(updates.map(update => [update.sessionUpdate, (update as { toolCallId?: string }).toolCallId, (update as { status?: string }).status]), [
    ["tool_call", "call_1", "pending"],
    ["tool_call_update", "call_1", "pending"],
    ["tool_call_update", "call_1", "pending"],
    ["tool_call_update", "call_1", "pending"],
  ]);
  const first = updates[0] as { title?: string; kind?: string };
  assert.equal(first.title, "read");
  assert.equal(first.kind, "read");
  assert.deepEqual((updates[1] as { rawInput?: unknown }).rawInput, { partialArgs: "{\"path\":\"src/" });
  assert.deepEqual((updates[2] as { rawInput?: unknown }).rawInput, { path: "src/a.ts" });
  assert.deepEqual((updates[3] as { rawInput?: unknown }).rawInput, { path: "src/a.ts" });
});

test("legacy cumulative partial toolcall stream is still understood", async () => {
  const { emit, updates, settle } = harness();
  const partial = { role: "assistant", content: [{ type: "text", text: "" }, { type: "toolCall", id: "call_2", name: "read", arguments: { path: "b.ts" } }] };
  emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, partial } });
  await settle();
  assert.equal(updates[0]?.sessionUpdate, "tool_call");
  assert.equal((updates[0] as { toolCallId?: string }).toolCallId, "call_2");
  assert.deepEqual((updates[0] as { rawInput?: unknown }).rawInput, { path: "b.ts" });
});

test("argument buffers do not leak across assistant messages that reuse a content index", async () => {
  const { emit, updates, settle } = harness();
  emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "call_a", toolName: "read" } });
  emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "{\"path\":" } });
  emit({ type: "message_end", message: { role: "assistant", stopReason: "aborted", content: [] } });
  emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "\"orphan\"}" } });
  emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "call_b", toolName: "read" } });
  emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "{\"path\":\"c.ts\"}" } });
  await settle();
  assert.deepEqual(updates.map(update => (update as { toolCallId?: string }).toolCallId), ["call_a", "call_a", "call_b", "call_b"]);
  assert.deepEqual((updates[3] as { rawInput?: unknown }).rawInput, { path: "c.ts" });
});
