import "./setup.ts"; // First: isolates this file from the real home even when run on its own.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AGENT_DIR } from "../src/index.ts";
import { loadRoles, roleDirs, roleSourcesText } from "../src/roles.ts";
import { tildify } from "../src/util/path.ts";
import { tempDir } from "./capture.ts";

test("roles are read from the agent dir the caller passes, not a hardcoded ~/.pi/agent", (t) => {
	const agentDir = tempDir("pi-delegate-roles-agent-", t), cwd = tempDir("pi-delegate-roles-cwd-", t);
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	writeFileSync(join(agentDir, "agents", "custom.md"), "---\nname: custom-from-agent-dir\ndescription: x\n---\nbody");
	assert(roleDirs(cwd, false, agentDir).includes(join(agentDir, "agents")));
	const roles = loadRoles(cwd, false, agentDir);
	assert(roles.has("custom-from-agent-dir"));
	assert.equal(roles.get("custom-from-agent-dir")!.source, tildify(join(agentDir, "agents", "custom.md")));
	assert.match(roleSourcesText(agentDir), new RegExp(`${tildify(join(agentDir, "agents")).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("the delegate reads roles from Pi's agent dir (PI_CODING_AGENT_DIR)", () => {
	assert.equal(AGENT_DIR, process.env.PI_CODING_AGENT_DIR);
	assert(roleDirs("/nowhere", false, AGENT_DIR).includes(join(process.env.PI_CODING_AGENT_DIR!, "agents")));
});

test("tildify shortens only a leading home directory", () => {
	const home = process.env.HOME!;
	assert.equal(tildify(join(home, "x", "y")), "~/x/y");
	assert.equal(tildify(home), "~");
	assert.equal(tildify(`/other${home}/x`), `/other${home}/x`);
	assert.equal(tildify(`${home}-sibling/x`), `${home}-sibling/x`);
});
