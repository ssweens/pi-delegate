import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AcpxRuntime, createAgentRegistry, createFileSessionStore, type AcpRuntimeEvent, type AcpRuntimeHandle, type NativeSessionBinding, type NativeSessionDescription } from "../../../dist/acpx-runtime/runtime.js";
import type { NormalizedEvent, Profile, RuntimeHandle, RuntimePort, RuntimeStatus, RuntimeTerminal, RuntimeTurn, TurnUsage } from "../domain/types.js";
import { StringsError } from "../domain/errors.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const adapterEntry = resolve(packageRoot, "dist/pi-acp.js");
const ampAdapterEntry = resolve(packageRoot, "dist/amp-acp.js");

export function normalize(event: AcpRuntimeEvent): NormalizedEvent | null {
  if (event.type === "text_delta") return { type: "text", text: event.text, stream: event.stream === "thought" ? "thought" : "output" };
  if (event.type === "status") {
    const usage: TurnUsage | undefined = (event.breakdown || event.cost) ? { ...(event.breakdown ? { breakdown: event.breakdown } : {}), ...(event.cost ? { cost: event.cost } : {}) } : undefined;
    return { type: "status", text: event.text, ...(usage ? { usage } : {}) };
  }
  if (event.type === "tool_call") return {
    type: "tool",
    text: event.text,
    ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
    ...(event.title && event.rawInput !== undefined ? { toolFingerprint: `${event.title}\u0000${createHash("sha256").update(stableSerialize(event.rawInput)).digest("hex")}` } : {}),
    ...(event.status ? { status: event.status } : {}),
  };
  return null;
}

function stableSerialize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "undefined") return "undefined";
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(",")}}`;
  }
  return String(value);
}

export function permissionModeFor(_profile: Profile): "approve-reads" { return "approve-reads"; }

function toHandle(handle: AcpRuntimeHandle): RuntimeHandle { return { ...handle }; }
function fromHandle(handle: RuntimeHandle): AcpRuntimeHandle { return { ...handle }; }

function nativeDescriptionFromBinding(binding: NativeSessionBinding | undefined): NativeSessionDescription | undefined {
  if (!binding?.execution_environment) return undefined;
  return {
    id: binding.id,
    scope: binding.scope,
    cwd: binding.cwd,
    executionEnvironment: binding.execution_environment,
    ...(binding.model ? { model: binding.model } : {}),
    attachment: "shared-session",
    disconnectEffect: binding.execution_environment === "local" ? "stops-local-executor" : "unknown",
    concurrentNativeClients: "unknown",
    activity: "unknown",
  };
}

/** Extra ACPX agent commands, by agent name. Embedders and tests only; users get the built-in registry. */
export type AgentOverrides = Readonly<Record<string, readonly string[]>>;

/** Every agent name this runtime can start: ACPX's built-in registry, the vendored pi and amp adapters, and any overrides. */
export function acpAgentNames(overrides: AgentOverrides = {}): string[] {
  return [...new Set([...createAgentRegistry().list(), "pi", "amp", ...Object.keys(overrides).map(name => name.trim().toLowerCase())])].sort();
}

export class AcpxRuntimePort implements RuntimePort {
  private readonly runtime: AcpxRuntime;
  private readonly sessionStore: ReturnType<typeof createFileSessionStore>;

  constructor(cwd: string, stateDir: string, profile: Profile, private readonly origin: "created" | "opened" = "created", agentOverrides: AgentOverrides = {}) {
    const piAdapterArgv = origin === "opened"
      ? [process.execPath, adapterEntry, "--pi-strings-opened"]
      : [process.execPath, adapterEntry, "--pi-strings-worker", "--pi-tools-json", JSON.stringify(profile.tools)];
    if (origin === "created" && profile.thinking) piAdapterArgv.push("--pi-thinking", profile.thinking);
    this.sessionStore = createFileSessionStore({ stateDir: resolve(stateDir, "acpx") });
    const runtimeOptions = {
      cwd,
      sessionStore: this.sessionStore,
      agentRegistry: createAgentRegistry({
        overrides: {
          pi: piAdapterArgv,
          // Vendored Amp adapter: drives the locally-installed `amp` CLI for
          // local/Orb execution and exact native T-ID continuation. Requires
          // `amp login`; provider-native tools are not confined by ACPX's
          // permission layer (same boundary as Codex's Guardian).
          amp: [process.execPath, ampAdapterEntry],
          ...Object.fromEntries(Object.entries(agentOverrides).map(([name, argv]) => [name, [...argv]])),
        },
      }),
      permissionMode: permissionModeFor(profile),
      nonInteractivePermissions: "deny" as const,
      // ACPX's default approve-reads mode prompts for mutations when its host
      // process has a TTY. Pi-strings has no permission UI, so use ACPX's
      // native policy to settle those requests instead of leaving the turn
      // waiting on readline. Writers remain usable without an interactive
      // operator; read-only workers auto-approve reads/searches and deny the
      // rest. No provider-specific callback or matcher is involved.
      permissionPolicy: origin === "opened"
        ? { defaultAction: "deny" as const }
        : profile.role === "writer"
        ? { defaultAction: "approve" as const }
        : { autoApprove: ["read", "search"], defaultAction: "deny" as const },
      // Coordinator deadlines are authoritative; ACPX must not terminate turns independently.
      timeoutMs: 0,
    };
    this.runtime = new AcpxRuntime(runtimeOptions);
  }

  async describeNativeSession(agent: string, sessionId: string, options: { cwd?: string; executionEnvironment?: string } = {}): Promise<NativeSessionDescription> {
    try { return await this.runtime.describeNativeSession({ agent, sessionId, ...options }); }
    catch (error) {
      const rpc = error as { code?: number; data?: unknown };
      if (rpc.code === -32601) throw new StringsError("NATIVE_OPEN_UNSUPPORTED", "This adapter does not yet advertise verified native opening.");
      throw new StringsError("NATIVE_LOOKUP_FAILED", typeof rpc.data === "string" ? rpc.data : error instanceof Error ? error.message : String(error));
    }
  }

  async openSession(input: { name: string; agent: string; native: NativeSessionDescription; handle?: RuntimeHandle }): Promise<RuntimeHandle> {
    const { id, scope, cwd } = input.native;
    const handle = await this.runtime.ensureSession({
      sessionKey: input.handle?.sessionKey ?? `pi-strings:opened:${input.name}:${randomUUID()}`,
      agent: input.agent, mode: "persistent", cwd, resumeSessionId: id,
      nativeSession: {
        id, scope, cwd,
        ...(input.agent.toLowerCase() === "amp" ? {
          execution_environment: input.native.executionEnvironment,
          ...(input.native.model ? { model: input.native.model } : {}),
        } : {}),
      },
    });
    if (handle.agentSessionId !== id) {
      await this.runtime.disconnect({ handle });
      throw new Error("Runtime did not verify the requested native identity.");
    }
    return toHandle(handle);
  }

  disconnect(handle: RuntimeHandle): Promise<void> { return this.runtime.disconnect({ handle: fromHandle(handle) }); }

  async ensureSession(input: { name: string; agent: string; cwd: string; profile: Profile; resumeSessionId?: string; executionEnvironment?: string; mode?: string; title?: string }): Promise<RuntimeHandle> {
    const amp = input.agent.toLowerCase() === "amp";
    if ((input.mode !== undefined || input.title !== undefined) && !amp) throw new StringsError("INPUT_INVALID", "mode and title are Amp-only.");
    const handle = await this.runtime.ensureSession({
      sessionKey: `pi-strings:${input.name}`,
      agent: input.agent,
      mode: "persistent",
      cwd: input.cwd,
      ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
      sessionOptions: {
        ...(input.profile.model ? { model: input.profile.model } : {}),
        ...(input.agent === "pi" ? { allowedTools: input.profile.tools } : {}),
        // The adapter titles the thread its first execution creates (`amp --title`). ACPX persists
        // session env under its snake_case key policy, hence the lowercase name.
        ...(amp && input.title ? { env: { amp_acp_thread_title: input.title } } : {}),
      },
    });
    try {
      const status = (input.executionEnvironment || input.profile.model || input.mode) ? await this.runtime.getStatus({ handle }) : undefined;
      if (input.executionEnvironment) {
        const options = status?.details?.configOptions as Array<{ id: string; options?: Array<{ value?: string; options?: Array<{ value: string }> }> }> | undefined;
        const option = options?.find(option => option.id === "execution-environment");
        const values = option?.options?.flatMap(option => option.options?.map(value => value.value) ?? (option.value ? [option.value] : [])) ?? [];
        if (!values.includes(input.executionEnvironment)) throw new Error(`Execution environment is not advertised: ${input.executionEnvironment}`);
        await this.runtime.setConfigOption({ handle, key: "execution-environment", value: input.executionEnvironment });
      }
      if (input.profile.model && status?.details?.configOptions) {
        const options = status.details.configOptions as Array<{ id: string; category?: string }>;
        const modelConfigId = options.find(option => option.category === "model")?.id;
        if (modelConfigId) await this.runtime.setConfigOption({ handle, key: modelConfigId, value: input.profile.model });
      }
      if (input.mode) {
        // Amp's agent mode (`amp --mode`): any mode Amp knows, plugin modes included, so it is not checked against the advertised list.
        const options = status?.details?.configOptions as Array<{ id: string }> | undefined;
        if (!options?.some(option => option.id === "amp-mode")) throw new Error("The Amp adapter does not advertise its mode option.");
        await this.runtime.setConfigOption({ handle, key: "amp-mode", value: input.mode });
      }
      if (input.agent === "codex") await this.runtime.setMode?.({ handle, mode: input.profile.role === "writer" ? "agent" : "read-only" });
    } catch (error) {
      await this.runtime.close({ handle, reason: "creation configuration failed", discardPersistentState: true }).catch(() => undefined);
      throw error;
    }
    // Amp exposes its own permission + effort config options (Default/Bypass and
    // low/medium/high/ultra) via ACP config options rather than ACP session modes,
    // so no setMode call here; the adapter default (Default permissions) is used.
    return { ...toHandle(handle), agent: input.agent, role: input.profile.role, cwd: input.cwd };
  }

  /**
   * Reopen a created session under its original session key. ACPX keeps the record of a session
   * closed without discard; its persistent reconnect is same-session-only, so the agent must
   * advertise session/resume or session/load (recorded at its last initialize). Without that the
   * resume is refused here rather than failing on the next turn.
   */
  async resumeSession(input: { name: string; agent: string; cwd: string; profile: Profile; sessionId: string }): Promise<RuntimeHandle> {
    const saved = await this.sessionStore.load(`pi-strings:${input.name}`);
    if (!saved || saved.acpSessionId !== input.sessionId) throw new StringsError("RESUME_UNSUPPORTED", `No saved ACP session ${input.sessionId} remains for this worker; it was discarded or never persisted.`);
    const capabilities = saved.agentCapabilities;
    if (!capabilities?.loadSession && !capabilities?.sessionCapabilities?.resume) throw new StringsError("RESUME_UNSUPPORTED", `Agent ${input.agent} does not advertise session/resume or session/load; session ${input.sessionId} cannot be reopened.`);
    // The session keeps the model it was configured with; the Coordinator re-selects it per turn.
    const { model: _model, ...profile } = input.profile;
    return this.ensureSession({ name: input.name, agent: input.agent, cwd: input.cwd, profile, resumeSessionId: input.sessionId });
  }

  async getStatus(handle: RuntimeHandle): Promise<RuntimeStatus> {
    if (this.origin === "opened") return { modelDiscoverySupported: false, availableModelIds: [] };
    const status = await this.runtime.getStatus({ handle: fromHandle(handle) });
    const native = nativeDescriptionFromBinding(status.nativeSession);
    if (!status.models) return { modelDiscoverySupported: false, availableModelIds: [], ...(native ? { native } : {}) };
    const configOptions = status.details?.configOptions as Array<{ id: string; category?: string }> | undefined;
    const modelConfigId = configOptions?.find(option => option.category === "model")?.id;
    return {
      ...(modelConfigId ? { modelConfigId } : {}),
      modelDiscoverySupported: true,
      ...(native ? { native } : {}),
      ...(status.models.currentModelId ? { currentModelId: status.models.currentModelId } : {}),
      availableModelIds: [...status.models.availableModelIds],
    };
  }

  startTurn(input: { handle: RuntimeHandle; prompt: string; requestId: string; timeoutMs: number }): RuntimeTurn {
    const turn = this.runtime.startTurn({ handle: fromHandle(input.handle), text: input.prompt, requestId: input.requestId, timeoutMs: 0, mode: "prompt" });
    let usage: TurnUsage | undefined;
    const events: AsyncIterable<NormalizedEvent> = {
      async *[Symbol.asyncIterator]() {
        for await (const event of turn.events) {
          const item = normalize(event);
          if (!item) continue;
          if (item.type === "status" && item.usage) usage = item.usage;
          yield item;
        }
      },
    };
    const result = turn.result.then((terminal): RuntimeTerminal => (usage ? { ...(terminal as RuntimeTerminal), usage } : terminal) as RuntimeTerminal);
    return {
      requestId: turn.requestId,
      events,
      result,
      cancel: (reason) => turn.cancel(reason ? { reason } : undefined),
      closeStream: (reason) => turn.closeStream(reason ? { reason } : undefined),
    };
  }

  async setConfigOption(input: { handle: RuntimeHandle; key: string; value: string }): Promise<void> {
    await this.runtime.setConfigOption({ handle: fromHandle(input.handle), key: input.key, value: input.value });
  }

  close(handle: RuntimeHandle, reason: string, discardPersistentState: boolean): Promise<void> { return this.runtime.close({ handle: fromHandle(handle), reason, discardPersistentState }); }
}
