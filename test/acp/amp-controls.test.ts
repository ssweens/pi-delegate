import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Coordinator } from "../../src/acp/orchestration/coordinator.ts";

const fakeAmp = new URL("./fixtures/fake-amp.mjs", import.meta.url).pathname;
const threadId = "T-00000000-0000-0000-0000-000000000001";

async function listen(server: ReturnType<typeof createServer>): Promise<{ url: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/control`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

test("Amp work controls use one exact opened T-ID and keep remote cancellation explicit", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-strings-amp-controls-"));
  await chmod(fakeAmp, 0o755);
  const received: Array<{ body: Record<string, unknown>; authorization: string | undefined }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      received.push({ body, authorization: request.headers.authorization });
      const action = body.action;
      const result = {
        requestId: body.requestId,
        threadId: body.threadId,
        action,
        delivery: "accepted",
        ...(action === "observe" ? { state: "idle", messages: [{ role: "user", id: "M-1", content: [{ type: "text", text: "bounded" }] }] } : {}),
        ...(action === "cancel" ? { remoteStop: "requested" } : {}),
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    });
  });
  const endpoint = await listen(server);
  const previous = new Map([
    ["AMP_CLI_PATH", process.env.AMP_CLI_PATH],
    ["AMP_ACP_STATE_DIR", process.env.AMP_ACP_STATE_DIR],
    ["PI_STRINGS_AMP_BRIDGE_URL", process.env.PI_STRINGS_AMP_BRIDGE_URL],
    ["PI_STRINGS_AMP_BRIDGE_TOKEN", process.env.PI_STRINGS_AMP_BRIDGE_TOKEN],
  ]);
  process.env.AMP_CLI_PATH = fakeAmp;
  process.env.AMP_ACP_STATE_DIR = join(root, "amp-state");
  process.env.PI_STRINGS_AMP_BRIDGE_URL = endpoint.url;
  process.env.PI_STRINGS_AMP_BRIDGE_TOKEN = "scratch-token";
  const coordinator = new Coordinator(root, { stateDir: join(root, "state"), profiles: {} });
  try {
    const opened = await coordinator.execute({ action: "spawn", name: "existing", agent: "amp", sessionId: threadId, cwd: root });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const observed = await coordinator.execute({ action: "observe", name: "existing", limit: 20 });
    assert.equal(observed.ok, true, JSON.stringify(observed));
    if (observed.ok) {
      assert.equal(observed.details.threadId, threadId);
      assert.equal(observed.details.delivery, "accepted");
      assert.equal((observed.details.messages as Array<{ id: string }>)[0]?.id, "M-1");
    }
    const appended = await coordinator.execute({ action: "append", name: "existing", text: "append marker" });
    assert.equal(appended.ok, true, JSON.stringify(appended));
    const steered = await coordinator.execute({ action: "steer", name: "existing", text: "steer marker" });
    assert.equal(steered.ok, true, JSON.stringify(steered));
    const cancelled = await coordinator.execute({ action: "cancel_remote", name: "existing", reason: "explicit scratch stop" });
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    if (cancelled.ok) assert.equal(cancelled.details.remoteStop, "requested");
    assert.deepEqual(received.map(item => item.body.action), ["observe", "append", "steer", "cancel"]);
    assert.ok(received.every(item => item.body.threadId === threadId));
    assert.ok(received.every(item => item.authorization === "Bearer scratch-token"));
    assert.equal(received[1]?.body.text, "append marker");
    assert.equal(received[2]?.body.text, "steer marker");
    const listed = await coordinator.execute({ action: "list" });
    assert.equal(listed.ok, true, JSON.stringify(listed));
    if (listed.ok) assert.equal((listed.details.controls as Array<{ action: string }>).length, 4);
  } finally {
    await coordinator.shutdown();
    await endpoint.close();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
