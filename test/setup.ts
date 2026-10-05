/**
 * Test isolation. `npm test` preloads it (`--import ./test/setup.ts`) in the runner and in each test
 * file's process, and every test file that loads src/index.ts, directly or through test/fixture.ts,
 * imports it first as well, so a file run on its own (`npx tsx --test test/x.test.ts`) is isolated
 * too. Nothing a test imports can then resolve the real home: Pi and src/index.ts read their agent
 * directory once, when first loaded. A module is evaluated once per process, so the preload and the
 * imports share one temporary home.
 *
 * `npm run test:acp:e2e` does not preload it on purpose: it drives real agents with the developer's
 * real auth and never loads src/index.ts.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, relative, isAbsolute } from "node:path";

/** The account's home from the user database, which a changed HOME does not move. */
export const REAL_HOME = userInfo().homedir;
const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-delegate-test-home-")));
/** This process's agent directory. test/fixture.ts's sandboxes all use it, reset for each sandbox. */
export const TEST_AGENT_DIR = join(root, ".pi", "agent");
Object.assign(process.env, {
	HOME: root,
	PI_CODING_AGENT_DIR: TEST_AGENT_DIR,
	XDG_CONFIG_HOME: join(root, ".config"),
	XDG_DATA_HOME: join(root, ".local", "share"),
	XDG_STATE_HOME: join(root, ".local", "state"),
	XDG_CACHE_HOME: join(root, ".cache"),
	PI_OFFLINE: "1",
	PI_TELEMETRY: "0",
	DO_NOT_TRACK: "1",
});
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
// Overrides inherited from the developer's shell would point Pi back at real state.
for (const name of ["PI_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"]) delete process.env[name];

/** True when `path` is the real home's `.pi` or inside it. */
export function underRealPi(path: string): boolean {
	const rel = relative(join(REAL_HOME, ".pi"), path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
if (homedir() === REAL_HOME || underRealPi(process.env.PI_CODING_AGENT_DIR!)) {
	throw new Error(`test/setup.ts: the agent directory resolves to the real home (${process.env.PI_CODING_AGENT_DIR}); refusing to run tests.`);
}
