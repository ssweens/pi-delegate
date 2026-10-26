import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { basename, join } from "node:path";
import { DelegateError, type BackendCapabilities, type CancelRequest, type WaitRequest, type WaitOutcome } from "./backend.ts";
import { RunCompletion } from "./completion.ts";
import { RunStore, processOwner, releaseOwner, ownedElsewhereError, type RunOwner } from "./storage.ts";
import { joinRuns, type Join } from "./wait.ts";
import { withTimeout } from "./util/async.ts";

export interface ProcessStartInput { backend: "process"; command: string; task?: string; cwd?: string; timeoutMs?: number }
export type ProcessCapabilities = Omit<BackendCapabilities, "backend"> & { backend: "process" };
export interface ProcessRunView {
	backend: "process"; id: string; command: string; task?: string; cwd: string;
	status: "running" | "done" | "error" | "cancelled" | "timed_out" | "interrupted";
	pid?: number; startedAt: number; endedAt?: number; exitCode?: number | null; signal?: NodeJS.Signals | null;
	output: string; outputFile: string; truncated: boolean; error?: string;
	capabilities: ProcessCapabilities; foreign?: { ownerPid: number; ownerHost: string };
}
export interface ProcessBackendHooks {
	ownerKey(): string; runDir(ownerKey: string): string; changed(): void;
	settled(view: ProcessRunView, ownerKey: string): void; admit?(): void;
}
type Fields = Omit<ProcessRunView, "backend" | "capabilities" | "foreign"> & Partial<RunOwner> & { ownerKey: string };
interface Run extends Fields {
	foreign?: boolean; child?: ChildProcess; completion: RunCompletion<ProcessRunView>; waiters: number;
	hooks: ProcessBackendHooks; store: RunStore<Run, Fields>; delivered?: boolean; fd?: number; poll?: NodeJS.Timeout; deadline?: NodeJS.Timeout;
	stopping?: Promise<boolean>; closed?: Promise<true>; stopStatus?: ProcessRunView["status"]; tree: Map<number, string>;
}
const KEY = Symbol.for("@ssweens/pi-delegate/process-runs/1");
const globals = globalThis as typeof globalThis & { [KEY]?: Map<string, Run> };
const runs = globals[KEY] ??= new Map<string, Run>();
const LIMIT = 64 * 1024;
const unsupported = { supported: false as const, reason: "A one-shot process has no session to open, steer or close; use cancel to stop it." };
const capabilities: ProcessCapabilities = {
	backend: "process", create: { supported: true }, open: unsupported, steer: unsupported, close: unsupported,
	wait: { supported: true }, result: { supported: true }, status: { supported: true }, cancel: { supported: true, scope: "run" },
};
function view(run: Run): ProcessRunView {
	const { id, command, task, cwd, status, pid, startedAt, endedAt, exitCode, signal, output, outputFile, truncated, error } = run;
	return { backend: "process", id, command, task, cwd, status, pid, startedAt, endedAt, exitCode, signal, output, outputFile, truncated, error, capabilities,
		...(run.foreign ? { foreign: { ownerPid: run.ownerPid ?? 0, ownerHost: run.ownerHost ?? "" } } : {}) };
}
function save(run: Run): void { run.store.save(run, RunStore.recordPath(run.hooks.runDir(run.ownerKey), run.id)); }
function tail(run: Run): void {
	const fd = run.fd ?? openSync(run.outputFile, "r");
	try {
		const size = fstatSync(fd).size;
		const bytes = Buffer.allocUnsafe(Math.min(size, LIMIT));
		const count = readSync(fd, bytes, 0, bytes.length, Math.max(0, size - LIMIT));
		run.output = bytes.toString("utf8", 0, count);
		while (Buffer.byteLength(run.output) > LIMIT) run.output = run.output.slice(1);
		run.truncated = size > LIMIT;
	} finally { if (run.fd === undefined) closeSync(fd); }
}
interface ProcessRow { pid: number; ppid: number; identity: string; zombie: boolean }
function processes(): ProcessRow[] {
	return execFileSync("ps", ["-axo", "pid=,ppid=,stat=,lstart="], { encoding: "utf8", timeout: 2000 }).trim().split("\n").map((line) => {
		const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
		if (!match) throw new Error("Cannot parse process ownership snapshot");
		return { pid: Number(match[1]), ppid: Number(match[2]), zombie: match[3]!.startsWith("Z"), identity: match[4]! };
	});
}
function track(run: Run, rows: ProcessRow[]): ProcessRow[] {
	const root = rows.find((p) => p.pid === run.child?.pid);
	if (root && run.child?.exitCode === null && run.child.signalCode === null && !run.tree.has(root.pid)) run.tree.set(root.pid, root.identity);
	let added: boolean;
	do {
		added = false;
		for (const p of rows) {
			const parent = rows.find((row) => row.pid === p.ppid);
			if (!run.tree.has(p.pid) && parent && run.tree.get(parent.pid) === parent.identity) { run.tree.set(p.pid, p.identity); added = true; }
		}
	} while (added);
	return rows.filter((p) => !p.zombie && run.tree.get(p.pid) === p.identity);
}
function notify(run: Run): void {
	if (run.waiters || run.delivered || !run.completion.settled) return;
	run.delivered = true; run.hooks.settled(view(run), run.ownerKey);
}
function finish(run: Run): void {
	if (run.completion.settled) return;
	clearInterval(run.poll); clearTimeout(run.deadline);
	try { tail(run); } catch (e) { run.status = "error"; run.error = `OUTPUT_READ_FAILED: ${String(e)}`; }
	if (run.fd !== undefined) { closeSync(run.fd); delete run.fd; }
	run.endedAt = Date.now();
	try { save(run); } catch (e) { run.status = "error"; run.error = `RUN_NOT_PERSISTED: ${String(e)}`; }
	run.completion.settle(view(run)); run.hooks.changed(); notify(run);
}
async function stop(run: Run, status: ProcessRunView["status"]): Promise<boolean> {
	if (run.stopping) return run.stopping;
	if (!run.child) return true;
	const completed = run.completion.settled;
	if (!completed) run.stopStatus = status;
	clearInterval(run.poll);
	const work = (async () => {
		let clean = false;
		try {
			for (const signal of ["SIGTERM", "SIGKILL"] as const) {
				const owned = track(run, processes());
				for (const p of owned.reverse()) {
					try { process.kill(p.pid, signal); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
				}
				const until = Date.now() + 500;
				while (Date.now() < until && track(run, processes()).length) await new Promise((r) => setTimeout(r, 25));
				if (!track(run, processes()).length) { clean = true; break; }
			}
			if (!clean) throw new Error("verified owned processes remain alive");
			if (run.closed && !await withTimeout(run.closed, 1000)) throw new Error("child exit was not confirmed");
			if (!completed) run.status = status;
		} catch (e) { clean = false; run.status = "error"; run.error = `PROCESS_CLEANUP_FAILED: ${String(e)}`; }
		if (completed) { tail(run); save(run); run.hooks.changed(); }
		else finish(run);
		return clean;
	})();
	run.stopping = work;
	try { return await work; } finally { if (run.stopping === work) delete run.stopping; }
}
export class ProcessBackend {
	readonly name = "process" as const;
	private readonly store: RunStore<Run, Fields> = new RunStore<Run, Fields>({
		tag: { backend: "process" }, foreignSave: "skip",
		valid: (r) => typeof r.command === "string" && typeof r.cwd === "string" && typeof r.outputFile === "string" && typeof r.startedAt === "number" &&
			["running", "done", "error", "cancelled", "timed_out", "interrupted"].includes(r.status) && typeof r.output === "string" && typeof r.truncated === "boolean",
		revive: (r) => ({ ...r, completion: new RunCompletion(), waiters: 0, tree: new Map(), hooks: this.hooks, store: this.store }),
		recover: (r, at) => { if (r.status === "running") { r.status = "interrupted"; r.endedAt = at; r.error = "PARENT_PROCESS_LOST: process outcome unknown; command was not adopted or replayed"; } },
		persisted: (r) => {
			const { child, completion, waiters, hooks, store, delivered, fd, poll, deadline, stopping, closed, stopStatus, tree, foreign, ...fields } = r;
			return fields;
		},
	});
	constructor(private readonly hooks: ProcessBackendHooks) {}
	capabilities(_run?: ProcessRunView): ProcessCapabilities { return capabilities; }
	find(id: string | undefined, ownerKey: string): Run | undefined { const run = id ? runs.get(id) : undefined; return run?.ownerKey === ownerKey ? run : undefined; }
	private get(id: string): Run { const run = this.find(id, this.hooks.ownerKey()); if (!run) throw new DelegateError("RUN_NOT_FOUND", `unknown process runId ${id}`); return run; }
	owned(ownerKey: string): ProcessRunView[] { return [...runs.values()].filter((r) => r.ownerKey === ownerKey).map(view); }
	restore(ownerKey: string): void {
		for (const path of RunStore.recordFiles(this.hooks.runDir(ownerKey)).filter((p) => basename(p).startsWith("process-"))) {
			const run = this.store.load(path, ownerKey);
			const live = runs.get(run.id);
			if (live) { if (!live.foreign) { live.hooks = this.hooks; live.store = this.store; } continue; }
			run.hooks = this.hooks; runs.set(run.id, run);
			if (existsSync(run.outputFile)) tail(run);
			if (run.status !== "running") { run.completion.settle(view(run)); run.delivered = true; }
			save(run);
		}
	}
	async start(input: ProcessStartInput, _signal?: AbortSignal): Promise<ProcessRunView> {
		if (!input.command.trim() || (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0))) throw new DelegateError("INPUT_INVALID", "command must be nonempty and timeoutMs a positive safe integer");
		this.hooks.admit?.();
		const ownerKey = this.hooks.ownerKey(), id = `process-${randomUUID()}`;
		const run: Run = { ...processOwner(), id, ownerKey, command: input.command, task: input.task, cwd: input.cwd ?? process.cwd(), status: "running", startedAt: Date.now(), output: "", outputFile: join(this.hooks.runDir(ownerKey), `${id}.output`), truncated: false, completion: new RunCompletion(), waiters: 0, tree: new Map(), hooks: this.hooks, store: this.store };
		try { save(run); } catch (e) { throw new DelegateError("RUN_NOT_PERSISTED", `command was not started: ${String(e)}`); }
		runs.set(id, run);
		try {
			run.fd = openSync(run.outputFile, "wx+", 0o600);
			const child = run.child = spawn(input.command, { shell: true, cwd: run.cwd, detached: true, stdio: ["ignore", run.fd, run.fd] });
			run.pid = child.pid;
			run.closed = new Promise((resolve) => child.once("close", () => resolve(true)));
			child.once("error", (e) => { run.status = "error"; run.error = `PROCESS_LAUNCH_FAILED: ${e.message}`; finish(run); });
			child.once("close", (code, signal) => {
				if (child.pid === undefined) return;
				run.exitCode = code; run.signal = signal;
				if (run.completion.settled || run.stopStatus) return;
				run.status = code === 0 ? "done" : "error"; finish(run);
			});
			run.poll = setInterval(() => { try { tail(run); track(run, processes()); run.hooks.changed(); } catch (e) { run.error = `PROCESS_OBSERVATION_FAILED: ${String(e)}`; } }, 100);
			if (input.timeoutMs !== undefined) {
				const end = run.startedAt + input.timeoutMs;
				const deadline = () => { const left = end - Date.now(); if (left <= 0) void stop(run, "timed_out"); else run.deadline = setTimeout(deadline, Math.min(left, 2 ** 31 - 1)); };
				deadline();
			}
			save(run);
		} catch (e) {
			run.error = `PROCESS_LAUNCH_FAILED: ${String(e)}`;
			if (run.child?.pid) await stop(run, "error"); else { run.status = "error"; finish(run); }
		}
		this.hooks.changed(); return view(run);
	}
	async result(id: string): Promise<ProcessRunView> { const run = this.get(id); if (!run.completion.settled && !run.foreign) tail(run); return view(run); }
	async status(ids?: readonly string[]): Promise<ProcessRunView[]> { return ids ? Promise.all(ids.map((id) => this.result(id))) : this.owned(this.hooks.ownerKey()); }
	join(ids: readonly string[]): Join<ProcessRunView> {
		const joined = ids.map((id) => this.get(id)); joined.forEach((r) => r.waiters++);
		let released = false;
		return {
			views: () => joined.map((r) => ({ id: r.id, settled: r.status !== "running", view: view(r) })),
			next: (pending, ms) => new Promise((resolve) => {
				const local = joined.filter((r) => !r.foreign && pending.some((v) => v.id === r.id));
				if (!local.length) { resolve(false); return; }
				const off: (() => void)[] = [];
				const end = () => { clearTimeout(timer); off.forEach((f) => f()); resolve(true); };
				const timer = setTimeout(end, ms);
				for (const r of local) off.push(r.completion.subscribe(end));
			}),
			claim: (settled) => { for (const v of settled) this.get(v.id).delivered = true; return [...settled]; },
			release: () => { if (released) return; released = true; joined.forEach((r) => { r.waiters--; notify(r); }); },
		};
	}
	async wait(request: WaitRequest, signal?: AbortSignal, interrupted?: () => boolean): Promise<WaitOutcome<ProcessRunView>> {
		const result = await joinRuns([this.join(request.runIds)], request.runIds, request.mode, { signal, interrupted, timeoutMs: request.timeoutMs, lost: "process owner is unavailable" });
		return { reason: result.reason, settled: result.settled, pending: result.pending.map((v) => v.id) };
	}
	async cancel(id: string, _input: CancelRequest = {}): Promise<ProcessRunView> {
		const run = this.get(id); if (run.foreign) throw ownedElsewhereError(run);
		run.delivered = true; await stop(run, "cancelled"); return view(run);
	}
	async closeOwner(ownerKey: string): Promise<ProcessRunView[]> {
		const owned = [...runs.values()].filter((r) => r.ownerKey === ownerKey && !r.foreign);
		await Promise.all(owned.map(async (r) => { r.delivered = true; if (await stop(r, "interrupted")) releaseOwner(r); save(r); }));
		return owned.map(view);
	}
}
