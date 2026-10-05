import "./setup.ts"; // First: isolates this file from the real home even when run on its own.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
// Loaded at the top, as milestones.test.ts and worker-guard.test.ts do: test/setup.ts must already have isolated it.
import { AGENT_DIR } from "../src/index.ts";
import { REAL_HOME, TEST_AGENT_DIR, underRealPi } from "./setup.ts";

test("the test process never resolves the real home or its ~/.pi", () => {
	assert.notEqual(homedir(), REAL_HOME, "HOME is the preload's temporary home");
	assert.equal(underRealPi(AGENT_DIR), false, `pi-delegate's agent dir ${AGENT_DIR} is outside ${REAL_HOME}/.pi`);
	assert.equal(underRealPi(getAgentDir()), false, `Pi's agent dir ${getAgentDir()} is outside ${REAL_HOME}/.pi`);
	assert.equal(AGENT_DIR, TEST_AGENT_DIR, "pi-delegate resolved this process's test agent dir");
	assert.equal(AGENT_DIR, getAgentDir(), "pi-delegate resolves the agent dir as Pi does");
});

test("every test module that loads src/index.ts, directly or through the fixture, imports ./setup.ts first", () => {
	const dir = import.meta.dirname;
	const loadsIndex = /from "\.\.\/src\/index\.ts"|import\("\.\.\/src\/index\.ts"\)|from "\.\/fixture\.ts"/;
	// terminal-fixture.ts is an extension loaded inside the Pi that terminal-smoke.ts starts in its sandbox.
	const unguarded = readdirSync(dir).filter((name) => name.endsWith(".ts") && name !== "setup.ts" && name !== "terminal-fixture.ts").filter((name) => {
		const source = readFileSync(join(dir, name), "utf8");
		if (!loadsIndex.test(source)) return false;
		const first = source.split("\n").find((line) => line.startsWith("import "));
		return !/^import (?:\{[^}]*\} from )?"\.\/setup\.ts";/.test(first ?? "");
	});
	// A module evaluates its imports in order: src/index.ts loaded before ./setup.ts resolves the real home.
	assert.deepEqual(unguarded, []);
});
