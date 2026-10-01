import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";

const GUARDS = ["PI_STRINGS_WORKER", "PI_STRINGS_OPENED"] as const;

/** Records every ExtensionAPI method the extension calls, and every tool it registers. */
function recordingApi() {
	const calls: string[] = [];
	const tools: string[] = [];
	const pi = new Proxy({}, {
		get: (_target, property) => (...args: any[]) => {
			calls.push(String(property));
			if (property === "registerTool") tools.push(args[0]?.name);
		},
	}) as unknown as ExtensionAPI;
	return { pi, calls, tools };
}

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

test("without worker markers the extension registers delegate, delegate_ctl and todo", () => {
	const api = recordingApi();
	withEnv({}, () => extension(api.pi));
	for (const name of ["delegate", "delegate_ctl", "todo"]) assert(api.tools.includes(name), `missing ${name}: ${api.tools.join(", ")}`);
});

for (const name of GUARDS) {
	test(`${name}=1 makes the extension register nothing`, () => {
		const api = recordingApi();
		withEnv({ [name]: "1" }, () => extension(api.pi));
		assert.deepEqual(api.tools, []);
		assert.deepEqual(api.calls, []);
	});
}
