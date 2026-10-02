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
  ndJsonStream,
  type Agent,
  type AgentSideConnection as AgentSideConnectionType,
  type AuthenticateRequest,
  type CancelNotification,
  type InitializeRequest,
  type LoadSessionRequest,
  type NewSessionRequest,
  type PromptRequest,
  type ResumeSessionRequest,
  type SetSessionConfigOptionRequest,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";
// Shared with the delegate backend's observation so both run the Amp CLI the same way.
import { AMP_THREAD_ID, ampCommand, ampThreadExport } from "../../../src/acp/runtime/amp-cli.js";

const NATIVE_SESSION_CAPABILITY = "pi-strings/native-session";
const NATIVE_SESSION_DESCRIBE = "pi-strings/session/describe";
const EXECUTION_CONFIG = "execution-environment";
const PERMISSION_CONFIG = "permission";
const MODE_CONFIG = "amp-mode";
const EXECUTORS = ["local", "orb"] as const;
type Executor = (typeof EXECUTORS)[number];
const ACP_SESSION_ID = /^S-[a-z0-9]+-[a-z0-9]{6}$/i;
const AMP_MODES = ["low", "medium", "high", "ultra"] as const;
/**
 * Set by the embedder for a session it creates: the title of the new thread (`--title` on its first
 * execution). Lowercase because ACPX persists session env under a snake_case key policy.
 */
const THREAD_TITLE_ENV = "amp_acp_thread_title";

type NativeBinding = {
  id: string;
  scope: string;
  cwd: string;
  execution_environment?: string;
  model?: string;
};

type NativeDescription = NativeBinding & {
  attachment: "stored-session" | "shared-session";
  disconnectEffect: "stops-local-executor" | "remote-work-continues" | "unknown";
  concurrentNativeClients: "unsupported" | "supported" | "unknown";
  activity: "idle" | "running" | "unknown";
  model?: string;
};

type SessionState = {
  threadId: string | null;
  scope: string;
  mode: "default" | "bypass";
  model: string;
  executor: Executor;
  cwd: string;
  native: boolean;
  controller: AbortController | null;
  cancelled: boolean;
};

type Mapping = {
  sessionId: string;
  threadId: string;
  mode: "default" | "bypass";
  model: string;
  executor: Executor;
  cwd: string;
};

function isAmpThreadId(value: unknown): value is string { return typeof value === "string" && AMP_THREAD_ID.test(value); }
function isExecutor(value: unknown): value is Executor { return value === "local" || value === "orb"; }
function stateDir(): string {
  return process.env.AMP_ACP_STATE_DIR?.trim() || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "amp-acp");
}
function mappingPath(sessionId: string): string { return join(stateDir(), "sessions", `${sessionId}.json`); }
function sessionId(): string { return `S-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
function accountScope(): string { return `amp://account/${process.env.AMP_ACCOUNT_SCOPE?.trim() || "authenticated"}`; }

function configOptions(state: Pick<SessionState, "mode" | "model" | "executor">): SessionConfigOption[] {
  return [
    {
      type: "select", id: EXECUTION_CONFIG, name: "Execution Environment",
      description: "Choose whether Amp runs locally or in an Amp Orb.", category: "mode",
      currentValue: state.executor, options: EXECUTORS.map(value => ({ value, name: value === "orb" ? "Orb" : "Local" })),
    },
    {
      type: "select", id: PERMISSION_CONFIG, name: "Permissions",
      description: "Controls Amp tool permissions.", category: "mode", currentValue: state.mode,
      options: [{ value: "default", name: "Default" }, { value: "bypass", name: "Bypass" }],
    },
    {
      type: "select", id: MODE_CONFIG, name: "Amp Mode",
      description: "Select the Amp agent mode.", category: "model", currentValue: state.model || "unknown",
      options: AMP_MODES.map(value => ({ value, name: value[0]!.toUpperCase() + value.slice(1) })),
    },
  ];
}

async function saveMapping(mapping: Mapping): Promise<void> {
  if (!ACP_SESSION_ID.test(mapping.sessionId) || !isAmpThreadId(mapping.threadId)) throw new Error("Invalid Amp mapping identity");
  const dir = join(stateDir(), "sessions");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const destination = mappingPath(mapping.sessionId);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(mapping)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
}

async function loadMapping(id: string): Promise<Mapping | null> {
  if (!ACP_SESSION_ID.test(id)) return null;
  try {
    const raw = JSON.parse(await readFile(mappingPath(id), "utf8")) as Partial<Mapping>;
    if (raw.sessionId !== id || !isAmpThreadId(raw.threadId) || !isExecutor(raw.executor) ||
        (raw.mode !== "default" && raw.mode !== "bypass") || typeof raw.model !== "string" || typeof raw.cwd !== "string") {
      throw new Error(`Invalid persisted Amp mapping for ${id}`);
    }
    return raw as Mapping;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function paramsMeta(params: unknown): Record<string, unknown> | undefined {
  const value = params as { _meta?: unknown };
  return value && value._meta && typeof value._meta === "object" && !Array.isArray(value._meta)
    ? value._meta as Record<string, unknown> : undefined;
}

function nativeBinding(params: unknown): NativeBinding | undefined {
  const raw = paramsMeta(params)?.[NATIVE_SESSION_CAPABILITY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || typeof value.scope !== "string" || typeof value.cwd !== "string") {
    throw RequestError.invalidParams("Invalid native session binding");
  }
  return {
    id: value.id,
    scope: value.scope,
    cwd: value.cwd,
    ...(typeof value.execution_environment === "string" ? { execution_environment: value.execution_environment } : {}),
    ...(typeof value.model === "string" ? { model: value.model } : {}),
  };
}

type AmpExecution = {
  cwd: string;
  executor: Executor;
  continue?: string;
  mode?: string;
  title?: string;
  dangerouslyAllowAll?: boolean;
};

type AmpStreamMessage = {
  type?: unknown;
  session_id?: unknown;
  is_error?: unknown;
  error?: unknown;
  message?: { content?: unknown };
};

function ampErrorMessage(value: unknown, fallback: string): string {
  if (value instanceof Error && value.message.trim()) return value.message;
  if (typeof value === "string" && value.trim()) return value;
  if (value !== undefined) {
    try {
      const serialized = JSON.stringify(value);
      if (serialized && serialized !== "{}") return serialized;
    } catch { /* fall through to the stable fallback */ }
  }
  return fallback;
}

function ampError(value: unknown, fallback: string): RequestError {
  const message = ampErrorMessage(value, fallback);
  return RequestError.internalError({ details: message }, message);
}

function ampArgs(options: AmpExecution): string[] {
  const args = options.continue ? ["threads", "continue", options.continue] : [];
  args.push("--execute", "--stream-json", "--no-archive-after-execute");
  if (options.executor === "orb") args.push("--orb-execute");
  if (options.mode) args.push("--mode", options.mode);
  if (options.title && !options.continue) args.push("--title", options.title);
  if (options.dangerouslyAllowAll) args.push("--dangerously-allow-all");
  return args;
}

async function* executeAmp(prompt: string, options: AmpExecution, signal: AbortSignal): AsyncIterable<AmpStreamMessage> {
  signal.throwIfAborted();
  const selected = ampCommand();
  const { [THREAD_TITLE_ENV]: _title, ...env } = process.env;
  const child = spawn(selected.command, [...selected.prefix, ...ampArgs(options)], {
    cwd: options.cwd, env: { ...env, TERM: "dumb" }, stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr: Buffer[] = [];
  child.stderr.on("data", chunk => stderr.push(chunk));
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
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
      try { yield JSON.parse(line) as AmpStreamMessage; }
      catch { throw new Error(`Amp returned a non-JSON stream line: ${line}`); }
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

type AmpThreadLookup = {
  owner?: string;
  cwd?: string;
  executor?: Executor;
  model?: string;
};

async function lookupAmpThread(id: string, cwd: string): Promise<AmpThreadLookup> {
  const { code, stdout, stderr: details } = await ampThreadExport(id, cwd);
  if (code !== 0) throw RequestError.invalidParams(`Amp thread lookup failed${details ? `: ${details}` : ""}`);
  let exported: unknown;
  try { exported = JSON.parse(stdout.toString("utf8")); }
  catch { throw RequestError.invalidParams("Amp thread lookup returned invalid export data"); }
  if (!exported || typeof exported !== "object" || Array.isArray(exported)) throw RequestError.invalidParams("Amp thread lookup returned invalid export data");
  const record = exported as Record<string, unknown>;
  const meta = record.meta && typeof record.meta === "object" && !Array.isArray(record.meta) ? record.meta as Record<string, unknown> : {};
  const env = record.env && typeof record.env === "object" && !Array.isArray(record.env) ? record.env as Record<string, unknown> : {};
  const initial = env.initial && typeof env.initial === "object" && !Array.isArray(env.initial) ? env.initial as Record<string, unknown> : {};
  const trees = Array.isArray(initial.trees) ? initial.trees : [];
  const tree = trees.find(value => value && typeof value === "object" && typeof (value as { uri?: unknown }).uri === "string") as { uri?: string } | undefined;
  const rawExecutor = typeof meta.executorType === "string" ? meta.executorType.toLowerCase() : "";
  const executor = rawExecutor.includes("orb") || rawExecutor.includes("remote") || rawExecutor.includes("sandbox") ? "orb" : rawExecutor.includes("local") ? "local" : undefined;
  const rawCwd = typeof initial.workingDirectory === "string" ? initial.workingDirectory : tree?.uri;
  const localCwd = rawCwd?.startsWith("file://") ? fileURLToPath(rawCwd) : rawCwd?.startsWith("/") ? rawCwd : undefined;
  return {
    ...(typeof record.creatorUserID === "string" ? { owner: record.creatorUserID } : {}),
    ...(localCwd ? { cwd: await realpath(localCwd).catch(() => undefined) } : {}),
    ...(executor ? { executor } : {}),
    ...(typeof meta.agentMode === "string" && meta.agentMode.trim() ? { model: meta.agentMode.trim() } : {}),
  };
}

async function nativeDescription(id: string, requestedCwd?: string, requestedExecutor?: string): Promise<NativeDescription> {
  if (!isAmpThreadId(id)) throw RequestError.invalidParams(`Unknown Amp thread ID: ${id}`);
  if (requestedExecutor !== undefined && !isExecutor(requestedExecutor)) throw RequestError.invalidParams("Amp executionEnvironment must be local or orb");
  const requestedPath = requestedCwd?.trim() ? await realpath(requestedCwd) : undefined;
  const lookup = await lookupAmpThread(id, requestedPath || process.cwd());
  const executionEnvironment = requestedExecutor || lookup.executor || "unknown";
  if (requestedExecutor && lookup.executor && requestedExecutor !== lookup.executor) throw RequestError.invalidParams("Amp thread executor does not match the requested executionEnvironment");
  if (requestedPath && lookup.cwd && requestedPath !== lookup.cwd) throw RequestError.invalidParams("Amp thread workspace does not match cwd");
  if (executionEnvironment === "local" && !lookup.cwd) throw RequestError.invalidParams("Amp local thread workspace metadata is unavailable; original cwd cannot be verified");
  const cwd = lookup.cwd || requestedPath || await realpath(process.cwd());
  const owner = lookup.owner || process.env.AMP_ACCOUNT_SCOPE?.trim() || "authenticated";
  return {
    id, scope: `amp://account/${owner}`, cwd, executionEnvironment,
    ...(lookup.model ? { model: lookup.model } : {}),
    attachment: "shared-session",
    disconnectEffect: executionEnvironment === "local" ? "stops-local-executor" : executionEnvironment === "orb" ? "unknown" : "unknown",
    concurrentNativeClients: "unknown",
    activity: "unknown",
  } as NativeDescription;
}

async function bindingDescription(binding: NativeBinding, sessionIdValue: string, cwd: string): Promise<NativeDescription> {
  if (binding.id !== sessionIdValue || binding.cwd !== cwd || !isExecutor(binding.execution_environment)) {
    throw RequestError.invalidParams("Native Amp identity, account scope, workspace, or executor changed");
  }
  const described = await nativeDescription(binding.id, cwd, binding.execution_environment);
  if (described.scope !== binding.scope || described.cwd !== binding.cwd || described.executionEnvironment !== binding.execution_environment ||
      (binding.model !== undefined && described.model !== binding.model)) {
    throw RequestError.invalidParams("Native Amp identity changed during opening");
  }
  return described;
}

async function promptText(params: PromptRequest): Promise<string> {
  let text = "";
  for (const chunk of params.prompt) {
    if (chunk.type === "text") text += chunk.text;
    else if (chunk.type === "resource_link") text += `\n${chunk.uri}\n`;
    else if (chunk.type === "resource" && "text" in chunk.resource) text += `\n${chunk.resource.text}\n`;
  }
  return text;
}

class AmpAcpAgent implements Agent {
  private readonly sessions = new Map<string, SessionState>();
  constructor(private readonly client: AgentSideConnectionType) {}

  async initialize(_params: InitializeRequest) {
    return {
      protocolVersion: 1,
      agentInfo: { name: "amp-acp", title: "Amp ACP adapter", version: "pi-strings" },
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: {} },
        promptCapabilities: { image: true, embeddedContext: true },
        _meta: { [NATIVE_SESSION_CAPABILITY]: 1 },
      },
      authMethods: [],
    };
  }

  async newSession(params: NewSessionRequest) {
    const state: SessionState = {
      threadId: null, scope: accountScope(), mode: "default", model: "medium", executor: "local",
      cwd: params.cwd, native: false, controller: null, cancelled: false,
    };
    const id = sessionId();
    this.sessions.set(id, state);
    return { sessionId: id, configOptions: configOptions(state) };
  }

  async authenticate(_params: AuthenticateRequest) { return {}; }

  private async restore(params: LoadSessionRequest | ResumeSessionRequest): Promise<{ state: SessionState; nativeBinding?: NativeBinding }> {
    const binding = nativeBinding(params);
    const cwd = await realpath(params.cwd);
    if (binding) {
      const native = await bindingDescription(binding, params.sessionId, cwd);
      const state: SessionState = {
        threadId: native.id, scope: native.scope, mode: "default", model: native.model ?? "", executor: native.executionEnvironment as Executor,
        cwd, native: true, controller: null, cancelled: false,
      };
      this.sessions.set(params.sessionId, state);
      return { state, nativeBinding: binding };
    }
    const mapping = await loadMapping(params.sessionId);
    if (!mapping) throw RequestError.invalidParams(`No durable Amp thread mapping for ACP session ${params.sessionId}`);
    const state: SessionState = { ...mapping, scope: accountScope(), native: false, controller: null, cancelled: false };
    this.sessions.set(params.sessionId, state);
    return { state };
  }

  async loadSession(params: LoadSessionRequest) {
    const { state, nativeBinding } = await this.restore(params);
    return {
      configOptions: configOptions(state),
      _meta: {
        agentSessionId: params.sessionId,
        ...(nativeBinding ? { [NATIVE_SESSION_CAPABILITY]: nativeBinding } : {}),
      },
    };
  }

  async resumeSession(params: ResumeSessionRequest) {
    const { state, nativeBinding } = await this.restore(params);
    return {
      configOptions: configOptions(state),
      _meta: {
        agentSessionId: params.sessionId,
        ...(nativeBinding ? { [NATIVE_SESSION_CAPABILITY]: nativeBinding } : {}),
      },
    };
  }

  async prompt(params: PromptRequest) {
    const state = this.sessions.get(params.sessionId);
    if (!state) throw RequestError.invalidParams("Session not found");
    state.cancelled = false;
    const controller = new AbortController();
    state.controller = controller;
    const options: AmpExecution = {
      cwd: state.cwd,
      env: { TERM: "dumb" },
      executor: state.executor,
      continue: state.threadId || undefined,
      noArchiveAfterExecute: true,
      ...(state.model ? { mode: state.model } : {}),
      ...(!state.threadId && !state.native && process.env[THREAD_TITLE_ENV]?.trim() ? { title: process.env[THREAD_TITLE_ENV]!.trim() } : {}),
      ...(state.executor === "local" && state.mode === "bypass" ? { dangerouslyAllowAll: true } : {}),
    };
    try {
      for await (const stream of executeAmp(await promptText(params), options, controller.signal)) {
        if (stream.session_id !== undefined) {
          if (!isAmpThreadId(stream.session_id)) throw new Error(`Amp returned an invalid thread ID: ${String(stream.session_id)}`);
          if (state.threadId && state.threadId !== stream.session_id) throw new Error("Amp changed the native thread ID");
          state.threadId = stream.session_id;
          if (!state.native) await saveMapping({ sessionId: params.sessionId, threadId: state.threadId, mode: state.mode, model: state.model, executor: state.executor, cwd: state.cwd });
        }
        if (stream.type === "assistant" || stream.type === "user") {
          const content = (stream as { message?: { content?: unknown } }).message?.content;
          const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((item): item is { type: "text"; text: string } => typeof item === "object" && item !== null && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string").map(item => item.text).join("") : "";
          if (text) await this.client.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: stream.type === "assistant" ? "agent_message_chunk" : "user_message_chunk", content: { type: "text", text } } });
        }
        if (stream.type === "result" && stream.is_error) throw ampError(stream.error, "Amp returned an error result");
      }
      const nativeSession = state.threadId ? {
        id: state.threadId,
        scope: state.scope,
        cwd: state.cwd,
        execution_environment: state.executor,
        ...(state.model ? { model: state.model } : {}),
      } : undefined;
      return {
        stopReason: state.cancelled ? "cancelled" : "end_turn",
        ...(nativeSession ? { _meta: { [NATIVE_SESSION_CAPABILITY]: nativeSession } } : {}),
      };
    } catch (error) {
      if (state.cancelled || (error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message)))) return { stopReason: "cancelled" };
      if (error instanceof RequestError) throw error;
      throw ampError(error, "Amp execution failed");
    } finally {
      state.controller = null;
      state.cancelled = false;
    }
  }

  async cancel(params: CancelNotification) {
    const state = this.sessions.get(params.sessionId);
    if (!state?.controller) return;
    state.cancelled = true;
    state.controller.abort();
  }

  async setSessionConfigOption(params: SetSessionConfigOptionRequest) {
    const state = this.sessions.get(params.sessionId);
    if (!state) throw RequestError.invalidParams("Session not found");
    if (params.configId === EXECUTION_CONFIG && isExecutor(params.value)) state.executor = params.value;
    else if (params.configId === PERMISSION_CONFIG && (params.value === "default" || params.value === "bypass")) state.mode = params.value;
    else if (params.configId === MODE_CONFIG && params.value.trim()) state.model = params.value.trim();
    else throw RequestError.invalidParams(`Unsupported Amp config option: ${params.configId}`);
    if (!state.native) await saveMappingIfReady(params.sessionId, state);
    return { configOptions: configOptions(state) };
  }

  async setSessionMode(params: { sessionId: string; modeId: string }) {
    return await this.setSessionConfigOption({ sessionId: params.sessionId, configId: PERMISSION_CONFIG, value: params.modeId } as SetSessionConfigOptionRequest);
  }

  async extMethod(method: string, params: Record<string, unknown>) {
    if (method !== NATIVE_SESSION_DESCRIBE || typeof params.sessionId !== "string") throw RequestError.methodNotFound(method);
    return await nativeDescription(params.sessionId, typeof params.cwd === "string" ? params.cwd : undefined, typeof params.executionEnvironment === "string" ? params.executionEnvironment : undefined);
  }

  async readTextFile(params: unknown) { return await this.client.readTextFile(params as never); }
  async writeTextFile(params: unknown) { return await this.client.writeTextFile(params as never); }
}

async function saveMappingIfReady(id: string, state: SessionState): Promise<void> {
  if (!state.threadId || state.native) return;
  await saveMapping({ sessionId: id, threadId: state.threadId, mode: state.mode, model: state.model, executor: state.executor, cwd: state.cwd });
}

const input = new WritableStream<Uint8Array>({
  write(chunk) {
    return new Promise<void>(resolve => { process.stdout.write(chunk, () => resolve()); });
  },
});
const output = new ReadableStream<Uint8Array>({
  start(controller) {
    process.stdin.on("data", chunk => controller.enqueue(new Uint8Array(chunk as Buffer)));
    process.stdin.on("end", () => controller.close());
    process.stdin.on("error", error => controller.error(error));
  },
});
new AgentSideConnection(connection => new AmpAcpAgent(connection), ndJsonStream(input, output));
process.stdin.resume();
