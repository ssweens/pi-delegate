import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Coordinator } from "../../src/acp/orchestration/coordinator.ts";
import type { NativeSessionDescription, NormalizedEvent, RuntimeHandle, RuntimePort, RuntimeTerminal, RuntimeTurn } from "../../src/acp/domain/types.ts";
import { StateStore } from "../../src/acp/persistence/state-store.ts";

class Turn implements RuntimeTurn {
  requestId = "native-turn";
  cancelled = 0;
  private finishResult!: (result: RuntimeTerminal) => void;
  private finishEvents!: () => void;
  readonly result = new Promise<RuntimeTerminal>(resolve => { this.finishResult = resolve; });
  private readonly ended = new Promise<void>(resolve => { this.finishEvents = resolve; });
  readonly events: AsyncIterable<NormalizedEvent> = { [Symbol.asyncIterator]: async function* (this: Turn) { await this.ended; }.bind(this) };
  async cancel() { this.cancelled++; this.finish({ status: "cancelled" }); }
  async closeStream() { this.finishEvents(); }
  finish(result: RuntimeTerminal) { this.finishResult(result); this.finishEvents(); }
}
class NativeRuntime implements RuntimePort {
  creates = 0;
  opens = 0;
  disconnects = 0;
  closes = 0;
  prompt = "";
  turn?: Turn;
  wrongId = false;
  constructor(public native: NativeSessionDescription) {}
  async ensureSession(): Promise<RuntimeHandle> { this.creates++; throw new Error("native path must not create"); }
  async describeNativeSession(_agent: string, id: string) { if (id !== this.native.id) throw new Error("unknown native ID"); return { ...this.native }; }
  async openSession(): Promise<RuntimeHandle> { this.opens++; return { sessionKey: "native", backend: "fixture", runtimeSessionName: "native", backendSessionId: "adapter-id", agentSessionId: this.wrongId ? "wrong" : this.native.id }; }
  startTurn(input: { prompt: string }) { this.prompt = input.prompt; return this.turn = new Turn(); }
  async getStatus() { return { modelDiscoverySupported: false, availableModelIds: [] }; }
  async disconnect() { this.disconnects++; this.turn?.finish({ status: "failed", error: { message: "disconnected" } }); }
  async close() { this.closes++; }
}
async function harness() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-strings-native-contract-")));
  const native: NativeSessionDescription = { id: "external-native-id", scope: "fixture://account-a", cwd: root,
    executionEnvironment: "local", attachment: "stored-session", disconnectEffect: "stops-local-executor", concurrentNativeClients: "unsupported", activity: "unknown" };
  const runtime = new NativeRuntime(native);
  const options = { stateDir: join(root, "state"), profiles: {}, runtimeFactory: () => runtime };
  const coordinator = new Coordinator(root, options);
  const open = () => coordinator.execute({ action: "spawn", name: "external", agent: "pi", sessionId: native.id });
  return { root, native, runtime, options, coordinator, open, cleanup: async () => { await coordinator.shutdown(); await rm(root, { recursive: true, force: true }); } };
}

test("adapters without native identity fail explicitly instead of creating", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-strings-native-unsupported-")));
  const runtime: RuntimePort = {
    async ensureSession() { throw new Error("must not create"); },
    startTurn() { throw new Error("must not send"); },
    async close() {},
  };
  const coordinator = new Coordinator(root, { stateDir: join(root, "state"), profiles: {}, runtimeFactory: () => runtime });
  try {
    const opened = await coordinator.execute({ action: "spawn", name: "external", agent: "codex", sessionId: "thread-1" });
    assert.equal(opened.ok, false);
    if (!opened.ok) assert.equal(opened.error.code, "NATIVE_OPEN_UNSUPPORTED");
  } finally { await coordinator.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test("native opening verifies identity, rejects overrides/duplicates, and sends undecorated text", async () => {
  const h = await harness();
  try {
    for (const field of ["profile", "role", "tools", "model", "thinking", "executionEnvironment"]) {
      const rejected = await h.coordinator.execute({ action: "spawn", name: "forbidden", sessionId: h.native.id, [field]: "override" });
      assert.equal(rejected.ok, false);
      if (!rejected.ok) assert.equal(rejected.error.code, "OPEN_OVERRIDE_FORBIDDEN");
    }
    assert.equal(h.runtime.opens, 0);
    const opened = await h.open();
    assert.equal(opened.ok, true, JSON.stringify(opened));
    if (opened.ok) { assert.equal(opened.details.origin, "opened"); assert.equal(opened.details.nativeSessionId, h.native.id); assert.equal(opened.details.role, undefined); }
    const duplicate = await h.coordinator.execute({ action: "spawn", name: "duplicate", sessionId: h.native.id });
    assert.equal(duplicate.ok, false);
    if (!duplicate.ok) assert.equal(duplicate.error.code, "SESSION_IN_USE");
    const blank = await h.coordinator.execute({ action: "send", name: "external", prompt: "   " });
    assert.equal(blank.ok, false);
    const padded = await h.coordinator.execute({ action: "send", name: "external", prompt: "  exact text  " });
    assert.equal(padded.ok, true);
    assert.equal(h.runtime.prompt, "  exact text  ");
    h.runtime.turn!.finish({ status: "completed" });
    if (padded.ok) {
      await h.coordinator.execute({ action: "wait", requestId: padded.details.requestId });
      const result = await h.coordinator.execute({ action: "result", requestId: padded.details.requestId });
      assert.equal(result.ok && result.details.status, "completed");
      assert.equal(result.ok && result.details.delivery, "accepted");
      assert.equal(result.ok && result.details.acceptance, undefined);
    }
    assert.equal(h.runtime.creates, 0);
  } finally { await h.cleanup(); }
});

test("native deadline ends observation without cancelling or allowing a second turn", async () => {
  const h = await harness();
  try {
    assert.equal((await h.open()).ok, true);
    const sent = await h.coordinator.execute({ action: "send", name: "external", prompt: "wait", requestTimeoutMs: 5 });
    assert.equal(sent.ok, true);
    if (!sent.ok) return;
    const wait = await h.coordinator.execute({ action: "wait", requestId: sent.details.requestId, waitTimeoutMs: 1000 });
    assert.equal(wait.ok && wait.details.timedOut, false);
    const result = await h.coordinator.execute({ action: "result", requestId: sent.details.requestId });
    assert.equal(result.ok && result.details.status, "timed_out");
    assert.equal(result.ok && result.details.delivery, "unknown");
    assert.equal(h.runtime.turn!.cancelled, 0);
    assert.equal(h.runtime.disconnects, 0);
    const duplicate = await h.coordinator.execute({ action: "send", name: "external", prompt: "must not run" });
    assert.equal(duplicate.ok, false);
    h.runtime.turn!.finish({ status: "completed" });
  } finally { await h.cleanup(); }
});

test("opened close and shutdown disconnect without cancel/archive/discard", async () => {
  for (const shutdown of [false, true]) {
    const h = await harness();
    try {
      assert.equal((await h.open()).ok, true);
      const sent = await h.coordinator.execute({ action: "send", name: "external", prompt: "running" });
      const discard = await h.coordinator.execute({ action: "close", name: "external", discardPersistentState: true });
      assert.equal(discard.ok, false);
      if (shutdown) await h.coordinator.shutdown();
      else assert.equal((await h.coordinator.execute({ action: "close", name: "external" })).ok, true);
      assert.equal(h.runtime.turn!.cancelled, 0);
      assert.equal(h.runtime.closes, 0);
      assert.equal(h.runtime.disconnects, 1);
      assert.equal(sent.ok, true);
    } finally { await h.cleanup(); }
  }
});

test("explicit native cancellation requests stop, unlike close", async () => {
  const h = await harness();
  try {
    await h.open();
    await h.coordinator.execute({ action: "send", name: "external", prompt: "running" });
    assert.equal((await h.coordinator.execute({ action: "cancel", name: "external" })).ok, true);
    assert.equal(h.runtime.turn!.cancelled, 1);
    assert.equal(h.runtime.closes, 0);
    assert.equal(h.runtime.disconnects, 0);
  } finally { await h.cleanup(); }
});

test("native identity mismatch disconnects without registration or creation", async () => {
  const h = await harness();
  try {
    h.runtime.wrongId = true;
    const opened = await h.open();
    assert.equal(opened.ok, false);
    assert.equal(h.runtime.disconnects, 1);
    assert.equal(h.runtime.creates, 0);
    const list = await h.coordinator.execute({ action: "list" });
    assert.deepEqual(list.ok && list.details.workers, []);
  } finally { await h.cleanup(); }
});

test("opened restart preserves scope and never replays creation defaults", async () => {
  const h = await harness();
  let second: Coordinator | undefined;
  try {
    await h.open();
    await h.coordinator.shutdown();
    second = new Coordinator(h.root, h.options);
    const list = await second.execute({ action: "list" });
    assert.equal(list.ok, true, JSON.stringify(list));
    assert.equal(h.runtime.opens, 2);
    assert.equal(h.runtime.creates, 0);
    const stored = JSON.parse(await readFile(join(h.options.stateDir, "state.json"), "utf8"));
    assert.equal(stored.version, 2);
    assert.equal(stored.workers[0].native.scope, h.native.scope);
    assert.equal(stored.workers[0].origin, "opened");
  } finally { await second?.shutdown(); await h.cleanup(); }
});

test("native account/storage changes reject sending without a new prompt", async () => {
  const h = await harness();
  try {
    await h.open();
    h.runtime.native = { ...h.native, scope: "fixture://different-account" };
    const sent = await h.coordinator.execute({ action: "send", name: "external", prompt: "must not send" });
    assert.equal(sent.ok, false);
    if (!sent.ok) assert.equal(sent.error.code, "SESSION_IDENTITY_CHANGED");
    assert.equal(h.runtime.turn, undefined);
  } finally { await h.cleanup(); }
});

test("v1 migration remains created-only and v2 opened records require native identity", async () => {
  const h = await harness();
  const store = new StateStore(h.options.stateDir);
  await store.acquire();
  try {
    const now = new Date().toISOString();
    const worker = { name: "legacy", profileName: "direct:pi", role: "read-only", status: "idle", cwd: h.root,
      handle: { sessionKey: "legacy", backend: "fixture", runtimeSessionName: "legacy", agent: "pi" }, createdAt: now, updatedAt: now };
    await writeFile(join(h.options.stateDir, "state.json"), JSON.stringify({ version: 1, workers: [worker], requests: [] }));
    const migrated = await store.load();
    assert.equal(migrated.version, 2);
    assert.equal(migrated.workers[0]!.origin, "created");
    assert.equal(migrated.workers[0]!.native, undefined);
    await writeFile(join(h.options.stateDir, "state.json"), JSON.stringify({ version: 2, workers: [{ ...worker, origin: "opened" }], requests: [] }));
    await assert.rejects(store.load(), /Opened workers require native identity/);
  } finally { await store.close(); await rm(h.root, { recursive: true, force: true }); }
});
