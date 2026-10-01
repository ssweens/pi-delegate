import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = realpathSync(resolve(import.meta.dirname, ".."));
const root = mkdtempSync(join(tmpdir(), "pi-delegate-install-"));
const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle/cli.js");
const env = { ...process.env, HOME: root, PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0" };
const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const peerRange: string = manifest.peerDependencies["@earendil-works/pi-coding-agent"];
const runtimeBinaries = ["dist/pi-acp.js", "dist/amp-acp.js"];
const runtimeModule = "dist/acpx-runtime/runtime.js";
const required = [
	"package.json", "README.md", "LICENSE", "NOTICE.md", "vendor/acpx/LICENSE", "vendor/pi-acp/LICENSE",
	"src/index.ts", "src/inspector.ts", "src/transcript.ts", "src/todo-ext.ts", "src/todo-render.ts", "src/todo.ts",
	"src/acp-backend.ts", "src/acp/runtime/acpx-runtime.ts", "src/acp/domain/types.ts",
	...runtimeBinaries, runtimeModule,
	"skills/delegation/SKILL.md", "roles/scout.md", "roles/worker.md", "roles/reviewer.md", "docs/ARCHITECTURE.md",
];
const walk = (dir: string): string[] => readdirSync(join(repo, dir), { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]);
const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + sep);
// Enough semver for the ">=a.b.c <x.y.z" peer ranges this package declares.
const compare = (a: string, b: string) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const covers = (range: string, version: string) => range.trim().split(/\s+/).every((part) => {
	const match = /^(>=|<)(\d+\.\d+\.\d+)$/.exec(part); assert(match, `Unsupported peer range ${range}`);
	return match[1] === ">=" ? compare(version, match[2]) >= 0 : compare(version, match[2]) < 0;
});
try {
	// Pack contents: the ACP runtime and resources ship; tests, scripts and vendored sources do not.
	const [dryRun] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: repo, encoding: "utf8", timeout: 30000 }));
	const packed = new Set<string>(dryRun.files.map((file: { path: string }) => file.path));
	for (const path of [...required, ...walk("dist")]) assert(packed.has(path), `Missing packaged ${path}`);
	for (const path of packed) {
		assert(!/^(test|scripts|node_modules|\.agents)\//.test(path), `Unexpected packaged ${path}`);
		assert(!/^(tsconfig.*\.json|TODO\.md|package-lock\.json)$/.test(path), `Unexpected packaged ${path}`);
		assert(!path.startsWith("vendor/") || /^vendor\/[^/]+\/LICENSE$/.test(path), `Unexpected packaged vendor source ${path}`);
	}
	const [pack] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", root], { cwd: repo, encoding: "utf8", timeout: 30000 }));
	assert.deepEqual(pack.files.map((file: { path: string }) => file.path).sort(), [...packed].sort());
	const cwd = join(root, "project"); mkdirSync(cwd);
	// Optional source exercises another real pi install route, e.g. npm:… or git:….
	// Without one, use the current artifact—not a potentially stale published release.
	execFileSync("tar", ["-xzf", join(root, pack.filename), "-C", root]);
	const source = process.argv[2] ?? join(root, "package");
	// Pi links local directories; unlike npm/git sources, it does not install their dependencies.
	if (!process.argv[2]) execFileSync("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: source, encoding: "utf8", timeout: 120000 });
	execFileSync(process.execPath, [cli, "install", source], { cwd, env, encoding: "utf8", timeout: 120000 });
	const piVersion: string = JSON.parse(readFileSync(join(dirname(cli), "../../package.json"), "utf8")).version;
	assert(covers(peerRange, piVersion), `Peer range ${peerRange} does not cover Pi ${piVersion}`);
	process.env.HOME = root; process.env.PI_CODING_AGENT_DIR = env.PI_CODING_AGENT_DIR; process.env.PI_OFFLINE = "1";
	const { DefaultResourceLoader } = await import("@earendil-works/pi-coding-agent");
	const loader = new DefaultResourceLoader({ cwd, agentDir: env.PI_CODING_AGENT_DIR, noContextFiles: true });
	await loader.reload();
	const result = loader.getExtensions();
	assert.deepEqual(result.errors, []);
	const tools = result.extensions.flatMap((extension) => [...extension.tools.keys()]);
	assert.equal(tools.filter((name) => name === "delegate").length, 1);
	assert.equal(tools.filter((name) => name === "delegate_ctl").length, 1);
	assert.equal(tools.filter((name) => name === "todo").length, 1);
	const skill = loader.getSkills().skills.find((skill) => skill.name === "delegation"); assert(skill);
	assert.match(readFileSync(skill.filePath, "utf8"), /Model per role/);
	const definition = result.extensions.flatMap((extension) => [...extension.tools.values()]).find((tool) => tool.definition.name === "delegate");
	assert(definition); assert.match(definition.definition.description, /delegation skill/);
	const installed = result.extensions.find((extension) => extension.tools.has("delegate")); assert(installed);
	const { loadRoles } = await import(pathToFileURL(join(dirname(installed.path), "roles.ts")).href);
	const roles = loadRoles(cwd, false);
	assert.deepEqual([...roles.keys()].sort(), ["reviewer", "scout", "worker"]);

	// ACP runtime: everything resolves from the installed package, never from this checkout.
	const installedRoot = realpathSync(resolve(dirname(installed.path), ".."));
	assert(!inside(installedRoot, repo), `Extension loaded from the repo: ${installedRoot}`);
	for (const path of [...runtimeBinaries, runtimeModule]) assert(existsSync(join(installedRoot, path)), `Installed package lacks ${path}`);
	for (const entry of [...runtimeBinaries, runtimeModule]) {
		const requireFrom = createRequire(join(installedRoot, entry));
		for (const dependency of Object.keys(manifest.dependencies)) {
			const resolved = realpathSync(requireFrom.resolve(dependency));
			assert(inside(resolved, installedRoot), `${entry}: ${dependency} resolved outside the installed package: ${resolved}`);
		}
	}
	const runtime = await import(pathToFileURL(join(installedRoot, runtimeModule)).href);
	assert.equal(typeof runtime.AcpxRuntime, "function");
	assert.equal(typeof runtime.createAgentRegistry, "function");
	const port = await import(pathToFileURL(join(installedRoot, "src/acp/runtime/acpx-runtime.ts")).href);
	const agents: string[] = port.acpAgentNames();
	assert(agents.includes("pi") && agents.includes("amp"), `ACP agents: ${agents.join(", ")}`);
	// Each bundled adapter starts from the installed copy and answers an ACP initialize.
	const initialize = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } })}\n`;
	for (const binary of runtimeBinaries) {
		const run = spawnSync(process.execPath, [join(installedRoot, binary)], { cwd, env, input: initialize, encoding: "utf8", timeout: 20000 });
		assert.equal(run.status, 0, `${binary} exited ${run.status}: ${run.stderr}`);
		const reply = JSON.parse(run.stdout.split("\n").find((line) => line.trim()) ?? "{}");
		assert.equal(reply.id, 1, `${binary} reply: ${run.stdout}`);
		assert.equal(reply.result?.protocolVersion, 1, `${binary} reply: ${run.stdout}`);
	}
	console.log(`PASS ${packed.size} packaged files, Pi ${piVersion} in ${peerRange}, isolated pi install with ACP runtime from ${installedRoot}`);
} finally { rmSync(root, { recursive: true, force: true }); }
