// One-shot diagnostic; keep outside Amp plugin auto-load directories.
// Run only with explicit approval: amp plugins exec <this-file> session.start --data '{}'
// No thread methods, agent calls, registration, installation, or configuration writes.
export default function ampHostCapabilities(amp: {
  system?: { ampURL?: URL; user?: unknown; executor?: { kind?: unknown } };
  threads?: { get?: unknown };
  logger: { log: (...args: unknown[]) => void };
}): void {
  const system = amp.system;
  amp.logger.log(JSON.stringify({
    probe: "pi-strings-amp-host-capabilities",
    serviceOrigin: system?.ampURL?.origin ?? null,
    authenticatedUserPresent: system?.user != null,
    hostExecutorKind: typeof system?.executor?.kind === "string" ? system.executor.kind : null,
    threadLookupAvailable: typeof amp.threads?.get === "function",
    threadMethodsCalled: false,
  }));
}
