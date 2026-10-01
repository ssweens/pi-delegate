import assert from "node:assert/strict";
import test from "node:test";
import { AmpPluginBridge, ampPluginBridgeFromEnvironment } from "../../src/acp/runtime/amp-plugin-bridge.ts";

test("Amp plugin bridge sends exact control identity and preserves bounded observation", async () => {
  let request: { url: string; init: RequestInit | undefined } | undefined;
  const bridge = new AmpPluginBridge({
    endpoint: "https://bridge.example.test/control",
    token: "secret",
    fetchImpl: async (url, init) => {
      request = { url: String(url), init };
      return new Response(JSON.stringify({
        requestId: "ctl_1",
        threadId: "T-00000000-0000-0000-0000-000000000001",
        action: "observe",
        delivery: "accepted",
        state: "running",
        messages: [{ role: "user", id: "M-1", content: [{ type: "text", text: "probe" }] }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await bridge.request({ requestId: "ctl_1", threadId: "T-00000000-0000-0000-0000-000000000001", action: "observe", limit: 20 });
  assert.equal(result.delivery, "accepted");
  assert.equal(result.state, "running");
  assert.equal(result.messages?.[0]?.id, "M-1");
  assert.equal(request?.url, "https://bridge.example.test/control");
  assert.ok(request?.init);
  assert.equal((request.init.headers as Record<string, string>).authorization, "Bearer secret");
  assert.deepEqual(JSON.parse(String(request.init.body)), {
    requestId: "ctl_1",
    threadId: "T-00000000-0000-0000-0000-000000000001",
    action: "observe",
    limit: 20,
  });
});

test("Amp plugin bridge keeps transport loss unknown and rejects unsafe configuration", async () => {
  const bridge = new AmpPluginBridge({
    endpoint: "https://bridge.example.test/control",
    token: "secret",
    fetchImpl: async () => { throw new Error("connection lost"); },
  });
  await assert.rejects(
    bridge.request({ requestId: "ctl_2", threadId: "T-00000000-0000-0000-0000-000000000001", action: "cancel" }),
    error => error instanceof Error && "code" in error && (error as { code: string }).code === "AMP_BRIDGE_DELIVERY_UNKNOWN",
  );
  assert.equal(ampPluginBridgeFromEnvironment({}), undefined);
  assert.throws(
    () => ampPluginBridgeFromEnvironment({ PI_STRINGS_AMP_BRIDGE_URL: "https://bridge.example.test/control" }),
    error => error instanceof Error && "code" in error && (error as { code: string }).code === "AMP_BRIDGE_CONFIG_INVALID",
  );
});
