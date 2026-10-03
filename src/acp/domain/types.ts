import type { NativeSessionDescription } from "../../../dist/acpx-runtime/runtime.js";
import type { AcpModelOption, AcpModelSource } from "../model-catalog.js";
export type { NativeSessionDescription } from "../../../dist/acpx-runtime/runtime.js";
export type { AcpModelOption, AcpModelSource } from "../model-catalog.js";
export type SessionOrigin = "created" | "opened";

export type WorkerRole = "read-only" | "writer";
export type WorkerKind = "oracle" | "finder" | "worker" | "free";
export type IsolationMode = "shared" | "worktree";
export type WorkerStatus = "spawning" | "idle" | "running" | "failed" | "closing" | "closed";
export type RequestStatus = "running" | "completed" | "cancelled" | "timed_out" | "failed";

export interface WorktreeIdentity {
  worktreeRoot: string;
  gitDir: string;
  commonDir: string;
}

export interface UsageBreakdown {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
}

export interface UsageCost {
  amount?: number;
  currency?: string;
}

export interface TurnUsage {
  breakdown?: UsageBreakdown;
  cost?: UsageCost;
}

export interface AcceptanceReport {
  parsed: boolean;
  report?: unknown;
}

export interface Profile {
  agent: string;
  role: WorkerRole;
  kind?: WorkerKind;
  model?: string;
  thinking?: string;
  fallbackModels?: string[];
  tools: string[];
  isolation?: IsolationMode;
  timeoutMs: number;
  cancellationGraceMs: number;
  maxOutputBytes: number;
  maxTurns?: number;
  maxAttempts?: number;
}

export interface RuntimeHandle {
  sessionKey: string;
  backend: string;
  runtimeSessionName: string;
  agent?: string;
  profileName?: string;
  role?: WorkerRole;
  cwd?: string;
  acpxRecordId?: string;
  backendSessionId?: string;
  agentSessionId?: string;
}

export interface RuntimeStatus {
  modelDiscoverySupported: boolean;
  native?: NativeSessionDescription;
  currentModelId?: string;
  availableModelIds: string[];
  modelConfigId?: string;
  modelOptions?: AcpModelOption[];
  modelSource?: AcpModelSource;
}

export type NormalizedEvent =
  | { type: "text"; text: string; stream: "output" | "thought" }
  | { type: "status"; text: string; usage?: TurnUsage }
  | { type: "tool"; text: string; toolCallId?: string; toolFingerprint?: string; status?: string };

export type RuntimeTerminal =
  | { status: "completed"; stopReason?: string; usage?: TurnUsage }
  | { status: "cancelled"; stopReason?: string; usage?: TurnUsage }
  | { status: "failed"; error: { message: string; code?: string; detailCode?: string; retryable?: boolean }; usage?: TurnUsage };

export interface RuntimeTurn {
  requestId: string;
  events: AsyncIterable<NormalizedEvent>;
  result: Promise<RuntimeTerminal>;
  cancel(reason?: string): Promise<void>;
  closeStream(reason?: string): Promise<void>;
}

export interface RuntimePort {
  /** mode and title are Amp-only: its agent mode (`amp --mode`) and the title of the thread the first turn creates. */
  ensureSession(input: { name: string; agent: string; cwd: string; profile: Profile; resumeSessionId?: string; executionEnvironment?: string; mode?: string; title?: string }): Promise<RuntimeHandle>;
  describeNativeSession?(agent: string, sessionId: string, options?: { cwd?: string; executionEnvironment?: string }): Promise<NativeSessionDescription>;
  openSession?(input: { name: string; agent: string; native: NativeSessionDescription; handle?: RuntimeHandle }): Promise<RuntimeHandle>;
  disconnect?(handle: RuntimeHandle): Promise<void>;
  /** Reopen a created session that was closed without discarding it. Fails RESUME_UNSUPPORTED when the adapter cannot resume or load it. */
  resumeSession?(input: { name: string; agent: string; cwd: string; profile: Profile; sessionId: string }): Promise<RuntimeHandle>;
  /** Take over the saved session record a created worker left in another, dead process's state dir, so resumeSession finds it here. Copies; never changes the other dir. */
  adoptSession?(input: { name: string; fromStateDir: string }): Promise<void>;
  startTurn(input: { handle: RuntimeHandle; prompt: string; requestId: string; timeoutMs: number }): RuntimeTurn;
  getStatus?(handle: RuntimeHandle): Promise<RuntimeStatus>;
  setModel?(input: { handle: RuntimeHandle; model: string }): Promise<void>;
  setConfigOption?(input: { handle: RuntimeHandle; key: string; value: string }): Promise<void>;
  close(handle: RuntimeHandle, reason: string, discardPersistentState: boolean): Promise<void>;
}

export interface RequestRecord {
  id: string;
  workerName: string;
  status: RequestStatus;
  startedAt: string;
  finishedAt?: string;
  output: string;
  truncated: boolean;
  eventPath: string;
  failure?: { code: string; message: string; retryable: boolean; detailCode?: string };
  stopReason?: string;
  cancellationRequestedAt?: string;
  lineageId?: string;
  attempt?: number;
  supersededBy?: string;
  predecessorRequestId?: string;
  usage?: TurnUsage;
  acceptance?: AcceptanceReport;
  requestedModel?: string;
  attemptModels?: string[];
  attempts?: number;
  delivery?: "unknown" | "accepted";
  providerOutcome?: "completed" | "cancelled" | "failed";
}

export interface WorkerRecord {
  origin: SessionOrigin;
  native?: NativeSessionDescription;
  name: string;
  profileName: string;
  profile: Profile;
  role: WorkerRole;
  model?: string;
  /** Amp's agent mode, chosen at creation. The adapter keeps it for every turn of the thread. */
  mode?: string;
  status: WorkerStatus;
  cwd: string;
  worktree?: WorktreeIdentity;
  handle: RuntimeHandle;
  activeRequestId?: string;
  createdAt: string;
  updatedAt: string;
  lineageId?: string;
}

export type StringsResponse =
  | { ok: true; action: string; details: Record<string, unknown> }
  | { ok: false; action: string; error: { code: string; message: string; retryable: boolean } };
