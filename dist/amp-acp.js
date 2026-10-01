#!/usr/bin/env node

// vendor/amp-acp/src/index.ts
import { realpath } from "node:fs/promises";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentSideConnection,
  RequestError,
  ndJsonStream
} from "@agentclientprotocol/sdk";
var NATIVE_SESSION_CAPABILITY = "pi-strings/native-session";
var NATIVE_SESSION_DESCRIBE = "pi-strings/session/describe";
var EXECUTION_CONFIG = "execution-environment";
var PERMISSION_CONFIG = "permission";
var MODE_CONFIG = "amp-mode";
var EXECUTORS = ["local", "orb"];
var AMP_THREAD_ID = /^T-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var ACP_SESSION_ID = /^S-[a-z0-9]+-[a-z0-9]{6}$/i;
var AMP_MODES = ["low", "medium", "high", "ultra"];
function isAmpThreadId(value) {
  return typeof value === "string" && AMP_THREAD_ID.test(value);
}
function isExecutor(value) {
  return value === "local" || value === "orb";
}
function stateDir() {
  return process.env.AMP_ACP_STATE_DIR?.trim() || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "amp-acp");
}
function mappingPath(sessionId2) {
  return join(stateDir(), "sessions", `${sessionId2}.json`);
}
function sessionId() {
  return `S-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function accountScope() {
  return `amp://account/${process.env.AMP_ACCOUNT_SCOPE?.trim() || "authenticated"}`;
}
function configOptions(state) {
  return [
    {
      type: "select",
      id: EXECUTION_CONFIG,
      name: "Execution Environment",
      description: "Choose whether Amp runs locally or in an Amp Orb.",
      category: "mode",
      currentValue: state.executor,
      options: EXECUTORS.map((value) => ({ value, name: value === "orb" ? "Orb" : "Local" }))
    },
    {
      type: "select",
      id: PERMISSION_CONFIG,
      name: "Permissions",
      description: "Controls Amp tool permissions.",
      category: "mode",
      currentValue: state.mode,
      options: [{ value: "default", name: "Default" }, { value: "bypass", name: "Bypass" }]
    },
    {
      type: "select",
      id: MODE_CONFIG,
      name: "Amp Mode",
      description: "Select the Amp agent mode.",
      category: "model",
      currentValue: state.model || "unknown",
      options: AMP_MODES.map((value) => ({ value, name: value[0].toUpperCase() + value.slice(1) }))
    }
  ];
}
async function saveMapping(mapping) {
  if (!ACP_SESSION_ID.test(mapping.sessionId) || !isAmpThreadId(mapping.threadId)) throw new Error("Invalid Amp mapping identity");
  const dir = join(stateDir(), "sessions");
  await mkdir(dir, { recursive: true, mode: 448 });
  const destination = mappingPath(mapping.sessionId);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(mapping)}
`, { mode: 384 });
  await rename(temporary, destination);
}
async function loadMapping(id) {
  if (!ACP_SESSION_ID.test(id)) return null;
  try {
    const raw = JSON.parse(await readFile(mappingPath(id), "utf8"));
    if (raw.sessionId !== id || !isAmpThreadId(raw.threadId) || !isExecutor(raw.executor) || raw.mode !== "default" && raw.mode !== "bypass" || typeof raw.model !== "string" || typeof raw.cwd !== "string") {
      throw new Error(`Invalid persisted Amp mapping for ${id}`);
    }
    return raw;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function paramsMeta(params) {
  const value = params;
  return value && value._meta && typeof value._meta === "object" && !Array.isArray(value._meta) ? value._meta : void 0;
}
function nativeBinding(params) {
  const raw = paramsMeta(params)?.[NATIVE_SESSION_CAPABILITY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return void 0;
  const value = raw;
  if (typeof value.id !== "string" || typeof value.scope !== "string" || typeof value.cwd !== "string") {
    throw RequestError.invalidParams("Invalid native session binding");
  }
  return {
    id: value.id,
    scope: value.scope,
    cwd: value.cwd,
    ...typeof value.execution_environment === "string" ? { execution_environment: value.execution_environment } : {},
    ...typeof value.model === "string" ? { model: value.model } : {}
  };
}
function ampCommand() {
  const configured = process.env.AMP_CLI_PATH?.trim() || "amp";
  return /\.(?:c|m)?js$/i.test(configured) ? { command: process.execPath, prefix: [configured] } : { command: configured, prefix: [] };
}
function ampArgs(options) {
  const args = options.continue ? ["threads", "continue", options.continue] : [];
  args.push("--execute", "--stream-json", "--no-archive-after-execute");
  if (options.executor === "orb") args.push("--orb-execute");
  if (options.mode) args.push("--mode", options.mode);
  if (options.dangerouslyAllowAll) args.push("--dangerously-allow-all");
  return args;
}
async function* executeAmp(prompt, options, signal) {
  signal.throwIfAborted();
  const selected = ampCommand();
  const child = spawn(selected.command, [...selected.prefix, ...ampArgs(options)], {
    cwd: options.cwd,
    env: { ...process.env, TERM: "dumb" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, processSignal) => resolve({ code, signal: processSignal }));
  });
  const abort = () => child.kill(process.platform === "win32" ? "SIGKILL" : "SIGTERM");
  signal.addEventListener("abort", abort, { once: true });
  child.stdin.end(prompt);
  try {
    const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line);
      } catch {
        throw new Error(`Amp returned a non-JSON stream line: ${line}`);
      }
    }
    const result = await completion;
    if (signal.aborted) throw new Error("Amp execution aborted");
    if (result.code !== 0) {
      const details = Buffer.concat(stderr).toString().trim();
      throw new Error(`Amp exited with code ${result.code ?? `signal ${result.signal ?? "unknown"}`}${details ? `: ${details}` : ""}`);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    if (!child.killed && child.exitCode === null) child.kill();
  }
}
async function lookupAmpThread(id, cwd) {
  const selected = ampCommand();
  const child = spawn(selected.command, [...selected.prefix, "threads", "export", id], {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode));
  });
  if (code !== 0) {
    const details = Buffer.concat(stderr).toString().trim();
    throw RequestError.invalidParams(`Amp thread lookup failed${details ? `: ${details}` : ""}`);
  }
  let exported;
  try {
    exported = JSON.parse(Buffer.concat(stdout).toString("utf8"));
  } catch {
    throw RequestError.invalidParams("Amp thread lookup returned invalid export data");
  }
  if (!exported || typeof exported !== "object" || Array.isArray(exported)) throw RequestError.invalidParams("Amp thread lookup returned invalid export data");
  const record = exported;
  const meta = record.meta && typeof record.meta === "object" && !Array.isArray(record.meta) ? record.meta : {};
  const env = record.env && typeof record.env === "object" && !Array.isArray(record.env) ? record.env : {};
  const initial = env.initial && typeof env.initial === "object" && !Array.isArray(env.initial) ? env.initial : {};
  const trees = Array.isArray(initial.trees) ? initial.trees : [];
  const tree = trees.find((value) => value && typeof value === "object" && typeof value.uri === "string");
  const rawExecutor = typeof meta.executorType === "string" ? meta.executorType.toLowerCase() : "";
  const executor = rawExecutor.includes("orb") || rawExecutor.includes("remote") || rawExecutor.includes("sandbox") ? "orb" : rawExecutor.includes("local") ? "local" : void 0;
  const rawCwd = typeof initial.workingDirectory === "string" ? initial.workingDirectory : tree?.uri;
  const localCwd = rawCwd?.startsWith("file://") ? fileURLToPath(rawCwd) : rawCwd?.startsWith("/") ? rawCwd : void 0;
  return {
    ...typeof record.creatorUserID === "string" ? { owner: record.creatorUserID } : {},
    ...localCwd ? { cwd: await realpath(localCwd).catch(() => void 0) } : {},
    ...executor ? { executor } : {},
    ...typeof meta.agentMode === "string" && meta.agentMode.trim() ? { model: meta.agentMode.trim() } : {}
  };
}
async function nativeDescription(id, requestedCwd, requestedExecutor) {
  if (!isAmpThreadId(id)) throw RequestError.invalidParams(`Unknown Amp thread ID: ${id}`);
  if (requestedExecutor !== void 0 && !isExecutor(requestedExecutor)) throw RequestError.invalidParams("Amp executionEnvironment must be local or orb");
  const requestedPath = requestedCwd?.trim() ? await realpath(requestedCwd) : void 0;
  const lookup = await lookupAmpThread(id, requestedPath || process.cwd());
  const executionEnvironment = requestedExecutor || lookup.executor || "unknown";
  if (requestedExecutor && lookup.executor && requestedExecutor !== lookup.executor) throw RequestError.invalidParams("Amp thread executor does not match the requested executionEnvironment");
  if (requestedPath && lookup.cwd && requestedPath !== lookup.cwd) throw RequestError.invalidParams("Amp thread workspace does not match cwd");
  if (executionEnvironment === "local" && !lookup.cwd) throw RequestError.invalidParams("Amp local thread workspace metadata is unavailable; original cwd cannot be verified");
  const cwd = lookup.cwd || requestedPath || await realpath(process.cwd());
  const owner = lookup.owner || process.env.AMP_ACCOUNT_SCOPE?.trim() || "authenticated";
  return {
    id,
    scope: `amp://account/${owner}`,
    cwd,
    executionEnvironment,
    ...lookup.model ? { model: lookup.model } : {},
    attachment: "shared-session",
    disconnectEffect: executionEnvironment === "local" ? "stops-local-executor" : executionEnvironment === "orb" ? "unknown" : "unknown",
    concurrentNativeClients: "unknown",
    activity: "unknown"
  };
}
async function bindingDescription(binding, sessionIdValue, cwd) {
  if (binding.id !== sessionIdValue || binding.cwd !== cwd || !isExecutor(binding.execution_environment)) {
    throw RequestError.invalidParams("Native Amp identity, account scope, workspace, or executor changed");
  }
  const described = await nativeDescription(binding.id, cwd, binding.execution_environment);
  if (described.scope !== binding.scope || described.cwd !== binding.cwd || described.executionEnvironment !== binding.execution_environment || binding.model !== void 0 && described.model !== binding.model) {
    throw RequestError.invalidParams("Native Amp identity changed during opening");
  }
  return described;
}
async function promptText(params) {
  let text = "";
  for (const chunk of params.prompt) {
    if (chunk.type === "text") text += chunk.text;
    else if (chunk.type === "resource_link") text += `
${chunk.uri}
`;
    else if (chunk.type === "resource" && "text" in chunk.resource) text += `
${chunk.resource.text}
`;
  }
  return text;
}
var AmpAcpAgent = class {
  constructor(client) {
    this.client = client;
  }
  sessions = /* @__PURE__ */ new Map();
  async initialize(_params) {
    return {
      protocolVersion: 1,
      agentInfo: { name: "amp-acp", title: "Amp ACP adapter", version: "pi-strings" },
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: {} },
        promptCapabilities: { image: true, embeddedContext: true },
        _meta: { [NATIVE_SESSION_CAPABILITY]: 1 }
      },
      authMethods: []
    };
  }
  async newSession(params) {
    const state = {
      threadId: null,
      scope: accountScope(),
      mode: "default",
      model: "medium",
      executor: "local",
      cwd: params.cwd,
      native: false,
      controller: null,
      cancelled: false
    };
    const id = sessionId();
    this.sessions.set(id, state);
    return { sessionId: id, configOptions: configOptions(state) };
  }
  async authenticate(_params) {
    return {};
  }
  async restore(params) {
    const binding = nativeBinding(params);
    const cwd = await realpath(params.cwd);
    if (binding) {
      const native = await bindingDescription(binding, params.sessionId, cwd);
      const state2 = {
        threadId: native.id,
        scope: native.scope,
        mode: "default",
        model: native.model ?? "",
        executor: native.executionEnvironment,
        cwd,
        native: true,
        controller: null,
        cancelled: false
      };
      this.sessions.set(params.sessionId, state2);
      return { state: state2, nativeBinding: binding };
    }
    const mapping = await loadMapping(params.sessionId);
    if (!mapping) throw RequestError.invalidParams(`No durable Amp thread mapping for ACP session ${params.sessionId}`);
    const state = { ...mapping, scope: accountScope(), native: false, controller: null, cancelled: false };
    this.sessions.set(params.sessionId, state);
    return { state };
  }
  async loadSession(params) {
    const { state, nativeBinding: nativeBinding2 } = await this.restore(params);
    return {
      configOptions: configOptions(state),
      _meta: {
        agentSessionId: params.sessionId,
        ...nativeBinding2 ? { [NATIVE_SESSION_CAPABILITY]: nativeBinding2 } : {}
      }
    };
  }
  async resumeSession(params) {
    const { state, nativeBinding: nativeBinding2 } = await this.restore(params);
    return {
      configOptions: configOptions(state),
      _meta: {
        agentSessionId: params.sessionId,
        ...nativeBinding2 ? { [NATIVE_SESSION_CAPABILITY]: nativeBinding2 } : {}
      }
    };
  }
  async prompt(params) {
    const state = this.sessions.get(params.sessionId);
    if (!state) throw RequestError.invalidParams("Session not found");
    state.cancelled = false;
    const controller = new AbortController();
    state.controller = controller;
    const options = {
      cwd: state.cwd,
      env: { TERM: "dumb" },
      executor: state.executor,
      continue: state.threadId || void 0,
      noArchiveAfterExecute: true,
      ...state.model ? { mode: state.model } : {},
      ...state.executor === "local" && state.mode === "bypass" ? { dangerouslyAllowAll: true } : {}
    };
    try {
      for await (const stream of executeAmp(await promptText(params), options, controller.signal)) {
        if (stream.session_id !== void 0) {
          if (!isAmpThreadId(stream.session_id)) throw new Error(`Amp returned an invalid thread ID: ${String(stream.session_id)}`);
          if (state.threadId && state.threadId !== stream.session_id) throw new Error("Amp changed the native thread ID");
          state.threadId = stream.session_id;
          if (!state.native) await saveMapping({ sessionId: params.sessionId, threadId: state.threadId, mode: state.mode, model: state.model, executor: state.executor, cwd: state.cwd });
        }
        if (stream.type === "assistant" || stream.type === "user") {
          const content = stream.message?.content;
          const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((item) => typeof item === "object" && item !== null && item.type === "text" && typeof item.text === "string").map((item) => item.text).join("") : "";
          if (text) await this.client.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: stream.type === "assistant" ? "agent_message_chunk" : "user_message_chunk", content: { type: "text", text } } });
        }
        if (stream.type === "result" && stream.is_error) throw new Error(typeof stream.error === "string" ? stream.error : "Amp returned an error result");
      }
      const nativeSession = state.threadId ? {
        id: state.threadId,
        scope: state.scope,
        cwd: state.cwd,
        execution_environment: state.executor,
        ...state.model ? { model: state.model } : {}
      } : void 0;
      return {
        stopReason: state.cancelled ? "cancelled" : "end_turn",
        ...nativeSession ? { _meta: { [NATIVE_SESSION_CAPABILITY]: nativeSession } } : {}
      };
    } catch (error) {
      if (state.cancelled || error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message))) return { stopReason: "cancelled" };
      throw error;
    } finally {
      state.controller = null;
      state.cancelled = false;
    }
  }
  async cancel(params) {
    const state = this.sessions.get(params.sessionId);
    if (!state?.controller) return;
    state.cancelled = true;
    state.controller.abort();
  }
  async setSessionConfigOption(params) {
    const state = this.sessions.get(params.sessionId);
    if (!state) throw RequestError.invalidParams("Session not found");
    if (params.configId === EXECUTION_CONFIG && isExecutor(params.value)) state.executor = params.value;
    else if (params.configId === PERMISSION_CONFIG && (params.value === "default" || params.value === "bypass")) state.mode = params.value;
    else if (params.configId === MODE_CONFIG && params.value.trim()) state.model = params.value.trim();
    else throw RequestError.invalidParams(`Unsupported Amp config option: ${params.configId}`);
    if (!state.native) await saveMappingIfReady(params.sessionId, state);
    return { configOptions: configOptions(state) };
  }
  async setSessionMode(params) {
    return await this.setSessionConfigOption({ sessionId: params.sessionId, configId: PERMISSION_CONFIG, value: params.modeId });
  }
  async extMethod(method, params) {
    if (method !== NATIVE_SESSION_DESCRIBE || typeof params.sessionId !== "string") throw RequestError.methodNotFound(method);
    return await nativeDescription(params.sessionId, typeof params.cwd === "string" ? params.cwd : void 0, typeof params.executionEnvironment === "string" ? params.executionEnvironment : void 0);
  }
  async readTextFile(params) {
    return await this.client.readTextFile(params);
  }
  async writeTextFile(params) {
    return await this.client.writeTextFile(params);
  }
};
async function saveMappingIfReady(id, state) {
  if (!state.threadId || state.native) return;
  await saveMapping({ sessionId: id, threadId: state.threadId, mode: state.mode, model: state.model, executor: state.executor, cwd: state.cwd });
}
var input = new WritableStream({
  write(chunk) {
    return new Promise((resolve) => {
      process.stdout.write(chunk, () => resolve());
    });
  }
});
var output = new ReadableStream({
  start(controller) {
    process.stdin.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk)));
    process.stdin.on("end", () => controller.close());
    process.stdin.on("error", (error) => controller.error(error));
  }
});
new AgentSideConnection((connection) => new AmpAcpAgent(connection), ndJsonStream(input, output));
process.stdin.resume();
