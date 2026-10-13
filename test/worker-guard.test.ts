import "./setup.ts"; // First: isolates this file from the real home even when run on its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import extension from "../src/index.ts";
import { fakePi } from "./capture.ts";

const GUARDS = ["PI_STRINGS_WORKER", "PI_STRINGS_OPENED"] as const;

function withEnv(values: Partial<Record<(typeof GUARDS)[number], string>>, run: () => void) {
	const saved = Object.fromEntries(GUARDS.map((name) => [name, process.env[name]]));
	for (const name of GUARDS) delete process.env[name];
	Object.assign(process.env, values);
	try { run(); } finally {
		for (const name of GUARDS) {
			if (saved[name] === undefined) delete process.env[name];
			else process.env[name] = saved[name];
		}
	}
}

test("without worker markers the extension registers delegation tools with the skill reminder", () => {
	const api = fakePi();
	withEnv({}, () => extension(api.pi));
	for (const name of ["delegate", "delegate_ctl", "todo"]) assert(api.tools.has(name), `missing ${name}: ${[...api.tools.keys()].join(", ")}`);
	for (const name of ["delegate", "delegate_ctl"]) {
		assert.match(api.tools.get(name)?.description ?? "", /Before using this tool, read skills\/delegation\/SKILL\.md if you have not read it in this session\./);
	}
});

for (const name of GUARDS) {
	test(`${name}=1 makes the extension register nothing`, () => {
		const api = fakePi();
		withEnv({ [name]: "1" }, () => extension(api.pi));
		assert.deepEqual([...api.tools.keys()], []);
		assert.deepEqual(api.calls, []);
	});
}
