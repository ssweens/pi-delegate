// No-prompt opening experiment against the real Pi CLI and vendored ACP adapter.
// Run after npm run build: node --import tsx scripts/probe-native-pi-opening.mjs
// Uses synthetic transcripts and isolated HOME/config/state; never sends a prompt.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AcpxRuntime, createAgentRegistry, createFileSessionStore } from "../dist/acpx-runtime/runtime.js";
import { Coordinator } from "../src/acp/orchestration/coordinator.ts";

const { stdout } = await promisify(execFile)("pi", ["--version"], { timeout: 10_000, maxBuffer: 32_768 });
const piVersion = stdout.trim();
const adapter = fileURLToPath(new URL("../dist/pi-acp.js", import.meta.url));

for (const thinking of [undefined, "off"]) {
  const root = await mkdtemp(join(tmpdir(), "pi-strings-native-pi-probe-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const sessionDir = join(agentDir, "sessions", "probe");
  await mkdir(cwd, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  const file = join(sessionDir, `${id}.jsonl`);
  const entries = [{ type: "session", version: 3, id, timestamp, cwd }];
  if (thinking !== undefined) entries.push({ type: "thinking_level_change", id: "00000001", parentId: null, timestamp, thinkingLevel: thinking });
  entries.push({ type: "message", id: "00000002", parentId: thinking === undefined ? null : "00000001", timestamp, message: { role: "user", content: "Synthetic native-opening probe; no inference requested.", timestamp: Date.now() } });
  const seed = entries.map(entry => JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(file, seed);

  const overrides = { HOME: root, XDG_CONFIG_HOME: join(root, "config"), PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
  // Do not inherit an unrelated fake-Pi test command or owned-worker launch policy.
  const removed = ["PI_ACP_PI_COMMAND", "PI_STRINGS_WORKER", "PI_STRINGS_PI_TOOLS", "PI_STRINGS_PI_THINKING"];
  const prior = new Map([...Object.keys(overrides), ...removed].map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  for (const key of removed) delete process.env[key];
  const runtime = new AcpxRuntime({
    cwd,
    sessionStore: createFileSessionStore({ stateDir: join(root, "acpx") }),
    agentRegistry: createAgentRegistry({ overrides: { pi: [process.execPath, adapter] } }),
    permissionMode: "deny-all", nonInteractivePermissions: "deny", timeoutMs: 15_000,
  });
  let handle;
  const coordinator = new Coordinator(cwd, { stateDir: join(root, 'coordinator'), profiles: {} });
  try {
    const opened = await coordinator.execute({ action: 'spawn', name: 'native', agent: 'pi', sessionId: id });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    assert.equal(opened.details.origin, 'opened');
    assert.equal(opened.details.nativeSessionId, id);
    assert.equal(opened.details.native.disconnectEffect, 'stops-local-executor');
    const closed = await coordinator.execute({ action: 'close', name: 'native' });
    assert.equal(closed.ok, true, JSON.stringify(closed));
    const missing = await coordinator.execute({ action: 'spawn', name: 'missing', agent: 'pi', sessionId: randomUUID() });
    assert.equal(missing.ok, false, JSON.stringify(missing));
    await coordinator.shutdown();
    handle = await runtime.ensureSession({ sessionKey: "native-opening-probe", agent: "pi", mode: "persistent", cwd, resumeSessionId: id });
    const reportedBackendIdMatches = handle.backendSessionId === id;
    const mapping = JSON.parse(await readFile(join(root, ".pi", "pi-acp", "session-map.json"), "utf8"));
    assert.equal(reportedBackendIdMatches, true);
    assert.equal(await realpath(mapping.sessions[id]?.sessionFile), await realpath(file));
    await runtime.close({ handle, reason: "idle probe complete", discardPersistentState: false });
    handle = undefined;
    const actual = await readFile(file, "utf8");
    const after = actual.trim().split("\n").map(line => JSON.parse(line));
    const seedEntriesPreserved = entries.every((entry, index) => JSON.stringify(entry) === JSON.stringify(after[index]));
    assert.equal(seedEntriesPreserved, true);
    const appended = after.slice(entries.length).map(entry => ({ type: entry.type, thinkingLevel: entry.thinkingLevel }));
    const recordedThinking = after.filter(entry => entry.type === "thinking_level_change").at(-1)?.thinkingLevel;
    if (thinking !== undefined) assert.equal(recordedThinking, thinking, "Opening changed a recorded thinking setting");

    const missingId = randomUUID();
    let missingRejected = false;
    try {
      const unexpected = await runtime.ensureSession({ sessionKey: "missing-native-probe", agent: "pi", mode: "persistent", cwd, resumeSessionId: missingId });
      handle = unexpected;
    } catch (error) {
      assert.equal(error.code, -32602, "Expected Pi's unknown-session error, not a transport failure");
      assert.equal(error.data, `Unknown sessionId: ${missingId}`);
      missingRejected = true;
    }
    assert.equal(missingRejected, true, "Unknown native ID was accepted");
    const files = (await readdir(join(agentDir, "sessions"), { recursive: true })).filter(path => path.endsWith(".jsonl"));
    assert.deepEqual(files, [join("probe", `${id}.jsonl`)]);
    console.log(JSON.stringify({
      piVersion, commonToolOpenAndDisconnect: true, syntheticTranscript: true, promptSent: false,
      seededThinking: thinking ?? "absent", reportedBackendIdMatches,
      mappingPointsToSeed: true, seedEntriesPreserved,
      byteIdenticalAfterIdleClose: actual === seed, appended,
      recordedThinkingPreserved: thinking === undefined ? "not applicable" : recordedThinking === thinking,
      unknownIdRejected: missingRejected, unknownIdErrorCode: -32602, nativeSessionFileCount: files.length,
    }));
  } finally {
    try {
      await coordinator.shutdown();
      if (handle) await runtime.close({ handle, reason: "probe cleanup", discardPersistentState: false });
    } finally {
      for (const [key, value] of prior) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  }
}
