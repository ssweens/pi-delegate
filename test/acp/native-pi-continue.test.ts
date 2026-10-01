import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Coordinator } from "../../src/acp/orchestration/coordinator.ts";
import { AcpxRuntimePort } from "../../src/acp/runtime/acpx-runtime.ts";
import type { Profile } from "../../src/acp/domain/types.ts";

const fakePi = new URL("./fixtures/fake-pi.mjs", import.meta.url).pathname;

function restore(env: Map<string, string | undefined>): void {
  for (const [key, value] of env) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

test("Coordinator opens a native Pi session through fake-pi and continues the same ID", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-strings-native-continue-")));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const sessionDir = join(agentDir, "sessions", "probe");
  await mkdir(cwd, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  const id = "fake-session";
  const sessionFile = join(sessionDir, `${id}.jsonl`);
  await writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd })}\n`);
  const nonceFile = join(root, "nonce.txt");
  const keys = ["HOME", "XDG_CONFIG_HOME", "PI_CODING_AGENT_DIR", "PI_ACP_PI_COMMAND", "FAKE_PI_STATE_FILE", "FAKE_PI_SESSION_FILE", "PI_STRINGS_WORKER", "PI_STRINGS_PI_TOOLS", "PI_STRINGS_PI_THINKING", "PI_STRINGS_OPENED"];
  const prior = new Map(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { HOME: root, XDG_CONFIG_HOME: join(root, "config"), PI_CODING_AGENT_DIR: agentDir, PI_ACP_PI_COMMAND: fakePi, FAKE_PI_STATE_FILE: nonceFile, FAKE_PI_SESSION_FILE: sessionFile });
  for (const key of ["PI_STRINGS_WORKER", "PI_STRINGS_PI_TOOLS", "PI_STRINGS_PI_THINKING", "PI_STRINGS_OPENED"]) delete process.env[key];
  const options = { stateDir: join(root, "coordinator"), profiles: {}, runtimeFactory: (runtimeCwd: string, stateDir: string, next: Profile, origin?: "created" | "opened") => new AcpxRuntimePort(runtimeCwd, stateDir, next, origin) };
  const first = new Coordinator(cwd, options);
  try {
    const missing = await first.execute({ action: "spawn", name: "missing", agent: "pi", sessionId: "missing-native-id" });
    assert.equal(missing.ok, false);
    const opened = await first.execute({ action: "spawn", name: "native", agent: "pi", sessionId: id });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    if (opened.ok) {
      assert.equal(opened.details.origin, "opened");
      assert.equal(opened.details.nativeSessionId, id);
    }
    const sent = await first.execute({ action: "send", name: "native", prompt: "SET:nonce-99" });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    if (sent.ok) {
      await first.execute({ action: "wait", requestId: sent.details.requestId, waitTimeoutMs: 8_000 });
      const result = await first.execute({ action: "result", requestId: sent.details.requestId });
      assert.equal(result.ok && result.details.status, "completed");
    }
    assert.equal((await first.execute({ action: "close", name: "native" })).ok, true);
  } finally { await first.shutdown(); }
  const second = new Coordinator(cwd, options);
  try {
    const reopened = await second.execute({ action: "spawn", name: "native", agent: "pi", sessionId: id });
    assert.equal(reopened.ok, true, JSON.stringify(reopened));
    const got = await second.execute({ action: "send", name: "native", prompt: "GET" });
    assert.equal(got.ok, true, JSON.stringify(got));
    if (got.ok) {
      await second.execute({ action: "wait", requestId: got.details.requestId, waitTimeoutMs: 8_000 });
      const result = await second.execute({ action: "result", requestId: got.details.requestId });
      assert.equal(result.ok && result.details.status, "completed");
      assert.match(String(result.ok ? result.details.output : ""), /NONCE:nonce-99/);
      assert.equal(result.ok && result.details.acceptance, undefined);
    }
    assert.equal(await readFile(nonceFile, "utf8"), "nonce-99");
  } finally {
    await second.shutdown();
    restore(prior);
    await rm(root, { recursive: true, force: true });
  }
});
