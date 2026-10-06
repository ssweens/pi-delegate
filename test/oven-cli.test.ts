import "./setup.ts"; // First: isolates this file from the real home even when run on its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ovenCli } from "../src/oven.ts";

test("oven's CLI comes from OVEN_CLI, else this package's oven dependency (run with node); nothing on PATH is needed", () => {
	const saved = process.env.OVEN_CLI;
	try {
		delete process.env.OVEN_CLI;
		const dependency = ovenCli();
		assert.equal(dependency.command, process.execPath);
		assert.deepEqual(dependency.args, [fileURLToPath(new URL("../node_modules/oven/bin/oven.mjs", import.meta.url))]);
		process.env.OVEN_CLI = "/somewhere/oven";
		assert.deepEqual(ovenCli(), { command: "/somewhere/oven", args: [] });
	} finally { if (saved === undefined) delete process.env.OVEN_CLI; else process.env.OVEN_CLI = saved; }
});
