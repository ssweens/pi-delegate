import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Coordinator } from "../../src/acp/orchestration/coordinator.ts";

const fakeAmp = new URL("./fixtures/fake-amp.mjs", import.meta.url).pathname;
const localThread = "T-00000000-0000-0000-0000-000000000001";
const orbThread = "T-00000000-0000-0000-0000-000000000002";
const localWithoutCwdThread = "T-00000000-0000-0000-0000-000000000003";

async function waitResult(coordinator: Coordinator, requestId: string) {
  const waited = await coordinator.execute({ action: "wait", requestId, waitTimeoutMs: 10_000 });
  assert.equal(waited.ok, true, JSON.stringify(waited));
  const result = await coordinator.execute({ action: "result", requestId });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

test("Amp creates local and Orb sessions through the common op_* path", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-strings-amp-create-")));
  const stateDir = join(root, "state");
  const workspace = join(root, "workspace");
  await chmod(fakeAmp, 0o755);
  const previous = new Map([
    ["AMP_CLI_PATH", process.env.AMP_CLI_PATH],
    ["AMP_ACP_STATE_DIR", process.env.AMP_ACP_STATE_DIR],
  ]);
  process.env.AMP_CLI_PATH = fakeAmp;
  process.env.AMP_ACP_STATE_DIR = join(root, "amp-state");
  const coordinator = new Coordinator(workspace, { stateDir, profiles: {} });
  try {
    const local = await coordinator.execute({ action: "spawn", name: "amp-local", agent: "amp", cwd: root });
    assert.equal(local.ok, true, JSON.stringify(local));
    assert.equal(local.ok, true);
    const localSend = await coordinator.execute({ action: "send", name: "amp-local", prompt: "local" });
    assert.equal(localSend.ok, true, JSON.stringify(localSend));
    if (localSend.ok) {
      const result = await waitResult(coordinator, String(localSend.details.requestId));
      assert.match(String(result.ok ? result.details.output : ""), /AMP_LOCAL_OK/);
    }

    const modeled = await coordinator.execute({ action: "spawn", name: "amp-modeled", agent: "amp", cwd: root, model: "high" });
    assert.equal(modeled.ok, true, JSON.stringify(modeled));
    const modeledStatus = await coordinator.execute({ action: "status", name: "amp-modeled" });
    assert.equal(modeledStatus.ok, true, JSON.stringify(modeledStatus));
    if (modeledStatus.ok) assert.equal(modeledStatus.details.currentModelId, "high");

    const orb = await coordinator.execute({ action: "spawn", name: "amp-orb", agent: "amp", cwd: root, executionEnvironment: "orb" });
    assert.equal(orb.ok, true, JSON.stringify(orb));
    assert.equal(orb.ok, true);
    const orbSend = await coordinator.execute({ action: "send", name: "amp-orb", prompt: "orb" });
    assert.equal(orbSend.ok, true, JSON.stringify(orbSend));
    if (orbSend.ok) {
      const result = await waitResult(coordinator, String(orbSend.details.requestId));
      assert.match(String(result.ok ? result.details.output : ""), /AMP_ORB_OK/);
    }
    const orbStatus = await coordinator.execute({ action: "status", name: "amp-orb" });
    assert.equal(orbStatus.ok, true, JSON.stringify(orbStatus));
    if (orbStatus.ok) {
      assert.equal(orbStatus.details.nativeSessionId, orbThread);
      assert.equal((orbStatus.details.native as { executionEnvironment?: string }).executionEnvironment, "orb");
    }
  } finally {
    await coordinator.shutdown();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("Amp opens the exact native T-ID with an explicit executor hint and never reports is_error as success", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-strings-amp-open-")));
  const stateDir = join(root, "state");
  const previous = new Map([
    ["AMP_CLI_PATH", process.env.AMP_CLI_PATH],
    ["AMP_ACP_STATE_DIR", process.env.AMP_ACP_STATE_DIR],
    ["AMP_FAKE_ARGS_LOG", process.env.AMP_FAKE_ARGS_LOG],
  ]);
  process.env.AMP_CLI_PATH = fakeAmp;
  process.env.AMP_ACP_STATE_DIR = join(root, "amp-state");
  process.env.AMP_FAKE_ARGS_LOG = join(root, "amp-args.ndjson");
  const coordinator = new Coordinator(root, { stateDir, profiles: {} });
  try {
    const opened = await coordinator.execute({ action: "spawn", name: "existing", agent: "amp", sessionId: localThread, cwd: root });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    if (opened.ok) {
      assert.equal(opened.details.nativeSessionId, localThread);
      assert.equal((opened.details.native as { executionEnvironment?: string }).executionEnvironment, "local");
    }
    const sent = await coordinator.execute({ action: "send", name: "existing", prompt: "exact" });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    if (sent.ok) {
      const result = await waitResult(coordinator, String(sent.details.requestId));
      assert.match(String(result.ok ? result.details.output : ""), /AMP_LOCAL_OK/);
    }

    const duplicate = await coordinator.execute({ action: "spawn", name: "duplicate", agent: "amp", sessionId: localThread, cwd: root, executionEnvironment: "local" });
    assert.equal(duplicate.ok, false);
    if (!duplicate.ok) assert.equal(duplicate.error.code, "SESSION_IN_USE");

    const failed = await coordinator.execute({ action: "send", name: "existing", prompt: "FAIL" });
    assert.equal(failed.ok, true, JSON.stringify(failed));
    if (failed.ok) {
      const result = await waitResult(coordinator, String(failed.details.requestId));
      assert.equal(result.ok && result.details.status, "failed");
    }

    const orb = await coordinator.execute({ action: "spawn", name: "existing-orb", agent: "amp", sessionId: orbThread, cwd: root, executionEnvironment: "orb" });
    assert.equal(orb.ok, true, JSON.stringify(orb));
    if (orb.ok) assert.equal((orb.details.native as { disconnectEffect?: string }).disconnectEffect, "unknown");
    const orbSent = await coordinator.execute({ action: "send", name: "existing-orb", prompt: "orb exact" });
    assert.equal(orbSent.ok, true, JSON.stringify(orbSent));
    if (orbSent.ok) {
      const result = await waitResult(coordinator, String(orbSent.details.requestId));
      assert.match(String(result.ok ? result.details.output : ""), /AMP_ORB_OK/);
    }
    const ampArgs = (await readFile(join(root, "amp-args.ndjson"), "utf8"))
      .trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const orbContinuation = ampArgs.find(args => args[0] === "threads" && args[1] === "continue" && args[2] === orbThread);
    assert.ok(orbContinuation, JSON.stringify(ampArgs));
    assert.equal(orbContinuation.includes("--orb-execute"), true);
    assert.equal(orbContinuation[orbContinuation.indexOf("--mode") + 1], "high");

    const missingCwd = await coordinator.execute({ action: "spawn", name: "missing-cwd", agent: "amp", sessionId: localWithoutCwdThread });
    assert.equal(missingCwd.ok, false, JSON.stringify(missingCwd));
    if (!missingCwd.ok) assert.equal(missingCwd.error.code, "NATIVE_LOOKUP_FAILED");
  } finally {
    await coordinator.shutdown();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
