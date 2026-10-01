/**
 * The one ACP Coordinator in a process (ADR 0001). This is its only construction site.
 *
 * `delegate backend:"acp"` and the transitional op_* entry (src/acp/index.ts, loaded by the
 * pi-strings shim until 053) both reach the Coordinator through here, so two extensions in one
 * process share one Coordinator and one state lock. The slot lives on globalThis because the
 * two entries may be loaded from different module paths.
 */
import { Coordinator, type CoordinatorOptions } from "./orchestration/coordinator.js";
import { AcpxRuntimePort, acpAgentNames, type AgentOverrides } from "./runtime/acpx-runtime.js";

export interface AcpCoordinatorOptions extends CoordinatorOptions {
  /** Extra agents for the default runtime. Embedders and tests only. */
  agentOverrides?: AgentOverrides;
}

interface Slot {
  coordinator?: Coordinator;
  /** A Coordinator that is still shutting down holds the state lock; its successor waits for it. */
  closing?: Promise<void>;
  options: AcpCoordinatorOptions;
}

const KEY = Symbol.for("@ssweens/pi-delegate/acp-coordinator/1");
const slot = (): Slot => {
  const g = globalThis as typeof globalThis & { [KEY]?: Slot };
  return g[KEY] ??= { options: {} };
};

/** Options for the next construction. A live Coordinator keeps the options it was built with. */
export function configureAcpCoordinator(options: AcpCoordinatorOptions): void {
  slot().options = { ...options };
}

/** Names `agent` may take: the runtime's registry, or every name when a test supplies its own runtime. */
export function acpAgents(): string[] | undefined {
  const { options } = slot();
  if (options.runtimeFactory) return undefined;
  return acpAgentNames(options.agentOverrides);
}

/** The process's Coordinator, constructed on first use. Nothing is constructed until ACP is used. */
export async function acpCoordinator(): Promise<Coordinator> {
  const current = slot();
  if (current.closing) await current.closing;
  if (current.coordinator) return current.coordinator;
  const { agentOverrides, ...options } = current.options;
  const runtimeFactory = options.runtimeFactory ?? (agentOverrides
    ? (cwd: string, stateDir: string, profile: Parameters<NonNullable<CoordinatorOptions["runtimeFactory"]>>[2], origin?: "created" | "opened") => new AcpxRuntimePort(cwd, stateDir, profile, origin, agentOverrides)
    : undefined);
  current.coordinator = new Coordinator(process.cwd(), { ...options, ...(runtimeFactory ? { runtimeFactory } : {}) });
  return current.coordinator;
}

/** The live Coordinator, if one was constructed. Never constructs one. */
export function existingAcpCoordinator(): Coordinator | undefined {
  return slot().coordinator;
}

/** Shut the Coordinator down. The next use constructs a fresh one after this one has released its lock. */
export async function shutdownAcpCoordinator(): Promise<void> {
  const current = slot();
  const coordinator = current.coordinator;
  if (!coordinator) { await current.closing; return; }
  delete current.coordinator;
  const closing = coordinator.shutdown().finally(() => { if (current.closing === closing) delete current.closing; });
  current.closing = closing;
  await closing;
}
