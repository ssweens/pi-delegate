/**
 * A Pi process that dies holding ACP runs: one turn still running, one session idle. It starts
 * them through AcpBackend over the fake runtime, reports their IDs, and waits to be killed, so
 * both the delegate records and the Coordinator's state file are left as a crash leaves them.
 */
import { configureAcpCoordinator } from "../src/acp/instance.ts";
import { AcpBackend } from "../src/acp-backend.ts";
import { fakeRuntime } from "./acp-fake-runtime.ts";

const [stateDir, runDir, cwd, ownerKey] = process.argv.slice(2) as [string, string, string, string];
configureAcpCoordinator({ stateDir, profiles: {}, runtimeFactory: fakeRuntime().factory });
const backend = new AcpBackend({ ownerKey: () => ownerKey, changed() {}, settled() {}, runDir: () => runDir });
const busy = await backend.start({ backend: "acp", origin: "created", agent: "fake", task: "WAIT", cwd });
const idle = await backend.start({ backend: "acp", origin: "created", agent: "fake", task: "hello", cwd });
await backend.wait({ runIds: [idle.id], mode: "all" });
process.send!({ busy: busy.id, idle: idle.id });
setInterval(() => undefined, 60_000);
