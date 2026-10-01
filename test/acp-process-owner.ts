/**
 * One Pi process's ACP side, driven by its parent test over IPC: AcpBackend over this process's
 * one Coordinator, which is configured as Pi configures it, by the environment only (the agent
 * dir), with no state dir given. The runtime is the in-process fake ("fake") or ACPX with the
 * fixture ACP agent and the vendored Amp adapter over the fake Amp CLI ("acpx").
 * argv: runDir ownerKey runtime [fixtureStatePath]
 * A request is { id, op, args }; the reply is { id, ok, value } or { id, ok: false, code, message }.
 */
import { acpCoordinator, configureAcpCoordinator, shutdownAcpCoordinator } from "../src/acp/instance.ts";
import { AcpBackend, DelegateError } from "../src/acp-backend.ts";
import { fakeRuntime } from "./acp-fake-runtime.ts";

const [runDir, ownerKey, runtime, fixtureState] = process.argv.slice(2) as [string, string, string, string | undefined];
const fakeAcpAgent = new URL("./acp/fixtures/fake-acp-agent.ts", import.meta.url).pathname;
if (runtime === "fake") configureAcpCoordinator({ profiles: {}, runtimeFactory: fakeRuntime().factory });
else configureAcpCoordinator({ profiles: {}, agentOverrides: { fixture: [process.execPath, "--import", import.meta.resolve("tsx"), fakeAcpAgent, fixtureState!] } });
const backend = new AcpBackend({ ownerKey: () => ownerKey, changed() {}, settled() {}, runDir: () => runDir });

const ops: Record<string, (args: any) => Promise<unknown>> = {
	start: (input) => backend.start({ backend: "acp", ...input }),
	steer: ({ id, message }) => backend.steer(id, { message }),
	wait: ({ ids, timeoutMs }) => backend.wait({ runIds: ids, mode: "all", ...(timeoutMs ? { timeoutMs } : {}) }),
	status: ({ ids }) => backend.status(ids),
	close: ({ id, force }) => backend.close(id, force ? { force } : {}),
	restore: async () => backend.restore(ownerKey),
	/** Parent exit, as Pi's session_shutdown does it: park this parent's runs, then shut the Coordinator down. */
	park: async () => { await backend.closeOwner(ownerKey); await shutdownAcpCoordinator(); },
	stateDir: async () => (await acpCoordinator() as unknown as { stateDir: string }).stateDir,
	exit: async () => { setImmediate(() => process.exit(0)); },
};

process.on("message", async ({ id, op, args }: { id: number; op: string; args?: unknown }) => {
	try { process.send!({ id, ok: true, value: await ops[op]!(args ?? {}) }); }
	catch (error) {
		process.send!({ id, ok: false, code: error instanceof DelegateError ? error.code : (error as { code?: string }).code ?? "ERROR", message: error instanceof Error ? error.message : String(error) });
	}
});
process.send!({ ready: process.pid });
