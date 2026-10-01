import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	buildSessionContext,
	convertToLlm,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { AgentHistory, AgentsPanel, ChildView, type LiveSource } from "./inspector.js";
import type { ActiveTool, ChildActivity } from "./transcript.js";
import { type AAIndices, acpRowView, asRunView, elapsed, empty, framed, type LiveFacts, type ModelRow, type ModelsDetails, resultLines, resultView, type RunView } from "./render.js";
import { type AcpRunView, type LifecycleAction, type PiStartInput, type WaitOutcome, PI_CAPABILITIES, requireAction, validateStartInput, validateSteer } from "./backend.js";
import { AcpBackend, acpResultText, acpStatusText, acpSummary, DelegateError, sessionLabel, unwrap } from "./acp-backend.js";
import { shutdownAcpCoordinator } from "./acp/instance.js";
import { loadRoles } from "./roles.js";
import { installTodo } from "./todo-ext.js";
import { dealEligible, selectDeals, type DealsDetails } from "./deals.js";
import { RunCompletion } from "./completion.js";
import { ownedElsewhere, processOwner, readRecord, storageDir, writeRecord } from "./storage.js";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const LOG_FILE = join(AGENT_DIR, "delegate-runs.jsonl");
const DEFAULTS_FILE = join(AGENT_DIR, "delegate-models.json");
const RATINGS_FILE = join(AGENT_DIR, "delegate-ratings.json");
const STALE_DAYS = 30;
const RATINGS_STALE_DAYS = 14;
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_TTL_MS = 10 * 60 * 1000;
const OPENROUTER_TIMEOUT_MS = 8000;
const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
// Only tools whose contract is to mutate files. bash is not one: read-only roles use it for grep/git diff/tests,
// and treating it as a writer made two scouts in one cwd collide. Keeping bash out is a decision, not a guess.
const WRITE_TOOLS = new Set(["edit", "write"]);
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_RETAINED_SESSIONS = 8;
const OUTPUT_CAP = 40_000;
/** Parent-session event bus only. No model turn or worker tool is created by a milestone. */
export const DELEGATE_MILESTONE_EVENT = "pi-delegate:milestone.v1";
export interface DelegateMilestone {
	version: 1;
	runId: string;
	segment: number;
	role: string;
	kind: "started" | "note" | "settled";
	at: number;
	task?: string;
	text?: string;
	status?: Status;
	changedFiles?: string[];
}

const CONTRACT_FOOTER = `

## Delegated worker contract
You are working inside another agent's task. You do the work yourself with the tools listed above: you have no delegation tools and cannot start another agent, so a delegation call is not available to you. That is your fixed toolset, not a broken setup — never ask anyone to reload, restart, or fix an extension, and never stop and wait for a reply. Whatever the conversation above shows another agent doing, your job is the brief below.

You are not alone in this repository: preserve unrelated and concurrent edits, do not revert work you do not own, stay within the ownership stated in the brief. Do not commit or push unless the brief says so. Inspect before editing; verify before claiming. End your final message with:
STATUS: complete | partial | blocked
CHANGES: <files changed, from the actual diff; or none>
VERIFIED: <commands or flows run and their concrete results>
GAPS: <unfinished work or blockers, or none>`;

// Stripping the delegating agent's tool calls is not enough on its own: its prose still reads as
// "I am supervising a worker", and a child that adopts that voice inspects the job instead of doing it.
const FORK_FOOTER = `

## The conversation before your assignment
It belongs to the agent that delegated to you \u2014 its plans, its investigation, its supervision of workers. Read it as background only. You are not that agent and you are not observing anyone: you are the worker it hired, and the assignment that follows is yours to carry out with your own tools.`;

type Status = RunView["status"];
type RunResult = { content: { type: "text"; text: string }[]; details: RunView; isError: boolean };

interface Run {
	id: string;
	ownerKey: string;
	recordPath: string;
	segment: number;
	stopped: boolean;
	acknowledged: boolean;
	systemPrompt: string;
	contextFiles: { path: string; content: string }[];
	appendSystemPrompt: string[];
	tools: string[];
	timeoutMs: number;
	sessionId: string;
	completion: RunCompletion<RunResult>;
	role: string;
	model: string;
	thinking: string;
	context: "fork" | "fresh";
	cwd: string;
	task: string;
	status: Status;
	startedAt: number;
	endedAt?: number;
	turns: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
	cost: number;
	changedFiles: string[];
	droppedTools: string[];
	output: string;
	failedAttempts: number;
	lastAttemptError?: string;
	error?: string;
	lastTool?: string;
	toolCalls: { name: string; args: Record<string, unknown>; at: number }[];
	activeTools: Map<string, ActiveTool>;
	revision: number;
	streamingMessage?: any;
	activityCache?: { revision: number; items: ChildActivity };
	contextWindow?: number;
	session?: any;
	ready?: Promise<void>;
	startIdx: number;
	segmentStartedAt: number;
	forkedMessages?: number;
	writer: boolean;
	syncJoined?: boolean;
	dirtyBefore?: Map<string, number>;
	timer?: ReturnType<typeof setTimeout>;
	sessionFile?: string;
	// Per-run ownership (see storage.ts). A run owned by another live process is read-only here.
	ownerPid?: number;
	ownerHost?: string;
	ownerToken?: string;
	foreign?: boolean;
}

/** A parent's in-process binding. There is no parent-level lock: runs carry their own ownership. */
interface Owner {
	key: string;
	// One pointer file per run: concurrent processes on the same parent never clobber a shared list.
	dir: string;
	queued: Set<string>;
	closed: boolean;
	binding?: { pi: ExtensionAPI; ctx: ExtensionContext };
}
interface RuntimeState {
	runs: Map<string, Run>;
	owners: Map<string, Owner>;
	listeners: Set<() => void>;
}
// This is the process-owned execution layer. Extension instances are replaceable UI/tool bindings.
// Never persist live session objects; a fresh process reconstructs only inert records from disk.
const runtimeKey = Symbol.for("@ssweens/pi-delegate/runtime/1");
const processState = globalThis as typeof globalThis & { [key: symbol]: RuntimeState };
const state = processState[runtimeKey] ??= { runs: new Map(), owners: new Map(), listeners: new Set() };
const { runs, listeners } = state;
function changed() { for (const listener of listeners) listener(); }
function milestone(run: Run, event: Omit<DelegateMilestone, "version" | "runId" | "segment" | "role" | "at">) {
	const owner = state.owners.get(run.ownerKey);
	if (!owner?.binding || owner.closed || run.foreign) return;
	owner.binding.pi.events.emit(DELEGATE_MILESTONE_EVENT, {
		version: 1, runId: run.id, segment: run.segment, role: run.role, at: Date.now(), ...event,
	} satisfies DelegateMilestone);
}
function newId(role: string): string { return `${role}-${randomUUID()}`; }
function ownerPath(ctx: ExtensionContext): string {
	return join(storageDir(ctx.sessionManager.getCwd()), "owners", `${ctx.sessionManager.getSessionId()}.json`);
}
function ownedRuns(owner: Owner): Run[] { return [...runs.values()].filter((r) => r.ownerKey === owner.key); }
function pointerDir(key: string): string { return key.replace(/\.json$/, ""); }
function foreignError(run: Run): Error {
	return new Error(`${run.id} is owned by another live Pi process (pid ${run.ownerPid} on ${run.ownerHost}); it is read-only here. Use that session, or wait for it to exit.`);
}
/** Legacy single-file index (read only) plus one pointer file per run. */
function runRecordPaths(owner: Owner): string[] {
	const paths: string[] = [];
	const legacy = readRecord<{ version: number; runs: string[] }>(owner.key);
	if (legacy && (legacy.version !== 1 || !Array.isArray(legacy.runs) || legacy.runs.some((p) => typeof p !== "string"))) throw new Error(`Invalid delegate index: ${owner.key}`);
	paths.push(...(legacy?.runs ?? []));
	const names = existsSync(owner.dir) ? readdirSync(owner.dir).filter((n) => n.endsWith(".json")).sort() : [];
	for (const name of names) {
		const pointer = readRecord<{ version: number; recordPath: string }>(join(owner.dir, name));
		if (!pointer || pointer.version !== 1 || typeof pointer.recordPath !== "string") throw new Error(`Invalid delegate pointer: ${join(owner.dir, name)}`);
		paths.push(pointer.recordPath);
	}
	return [...new Set(paths)];
}

type RunRecord = Omit<Run, "completion" | "session" | "timer" | "streamingMessage" | "activeTools" | "activityCache" | "dirtyBefore" | "ready" | "acknowledged" | "foreign"> & { version: 1; savedAt: number };
function saveRun(run: Run): void {
	if (run.foreign) throw foreignError(run);
	const { completion, session, timer, streamingMessage, activeTools, activityCache, dirtyBefore, ready, acknowledged, foreign, ...record } = run;
	writeRecord(run.recordPath, { ...record, version: 1, savedAt: Date.now() });
}
function messagesOf(run: Run): any[] {
	if (!run.sessionFile) return [];
	const manager = run.session?.sessionManager ?? openTranscript(run);
	return manager.getEntries().filter((e: any) => e.type === "message").map((e: any) => e.message);
}
function openTranscript(run: Run): SessionManager {
	if (!run.sessionFile || !existsSync(run.sessionFile)) throw new Error(`${run.id}: saved transcript is missing; refusing to start a replacement.`);
	const manager = SessionManager.open(run.sessionFile);
	if (manager.getSessionId() !== run.sessionId) throw new Error(`${run.id}: transcript identity does not match its saved configuration.`);
	return manager;
}
function finalResult(run: Run): RunResult {
	return { content: [{ type: "text", text: resultText(run) }], details: { ...recordedView(run), settled: true, completionReceipt: true }, isError: run.status !== "complete" };
}
function restoreRun(path: string, owner: Owner): Run {
	const record = readRecord<RunRecord>(path);
	if (!record || record.version !== 1 || record.ownerKey !== owner.key || typeof record.id !== "string" ||
		typeof record.systemPrompt !== "string" || !Array.isArray(record.contextFiles) || !Array.isArray(record.appendSystemPrompt) || !Array.isArray(record.tools) || typeof record.sessionId !== "string" ||
		!Number.isInteger(record.segment) || typeof record.cwd !== "string" || !Array.isArray(record.toolCalls)) {
		throw new Error(`Cannot restore delegate metadata: ${path}`);
	}
	// Parent message_end hooks run before Pi appends the message. Only its transcript
	// can establish durable delivery after a crash; never trust a saved in-memory acknowledgement.
	const run: Run = { ...record, recordPath: path, acknowledged: false, completion: new RunCompletion(), activeTools: new Map() };
	if (ownedElsewhere(record)) {
		// Its live owner is still running or delivering it: show a snapshot, never write or re-deliver it.
		run.foreign = true;
		run.completion.settle(finalResult(run));
		return run;
	}
	// Unowned, ours from before a reload, or its owner died: this process adopts it.
	Object.assign(run, processOwner());
	if (run.status === "running") {
		run.status = "interrupted";
		run.endedAt = record.savedAt;
		run.error = "The previous process ended before this execution settled. Inspect its saved work; send a message to continue.";
	}
	try { harvest(run); }
	catch (error) { run.status = "error"; run.error = String(error); }
	saveRun(run);
	run.completion.settle(finalResult(run));
	return run;
}

function parseModelSpec(spec: string): { provider?: string; id: string; thinking?: string } {
	let thinking: string | undefined;
	let rest = spec;
	const colon = rest.lastIndexOf(":");
	if (colon > 0 && !rest.slice(colon + 1).includes("/")) {
		thinking = rest.slice(colon + 1);
		rest = rest.slice(0, colon);
	}
	const slash = rest.indexOf("/");
	return slash > 0 ? { provider: rest.slice(0, slash), id: rest.slice(slash + 1), thinking } : { id: rest, thinking };
}

function resolveModel(spec: string | undefined, ctx: ExtensionContext) {
	if (!spec) return { model: ctx.model, thinking: undefined as string | undefined };
	const p = parseModelSpec(spec);
	const reg: any = ctx.modelRegistry;
	// A named provider is a choice between offerings of the same weights, not a search key:
	// resolving it to another provider would silently change cost, limits, and serving.
	const model = p.provider ? reg.find(p.provider, p.id) : reg.getAll().find((m: any) => m.id === p.id);
	if (!model) throw new Error(`model not found: ${spec}`);
	return { model, thinking: p.thinking };
}

/** Dirty paths (tracked+untracked) → mtime, or undefined when cwd is not a git work tree. */
function snapshotDirty(cwd: string): Map<string, number> | undefined {
	let out: string;
	try {
		out = execFileSync("git", ["status", "--porcelain", "-uall", "-z"], { cwd, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return undefined;
	}
	const m = new Map<string, number>();
	for (const rec of out.split("\0")) {
		if (rec.length < 4) continue;
		const p = rec.slice(3);
		let mtime = 0;
		try {
			mtime = statSync(join(cwd, p)).mtimeMs;
		} catch {
			/* deleted */
		}
		m.set(p, mtime);
	}
	return m;
}

function dirtyDelta(before: Map<string, number> | undefined, cwd: string): string[] | undefined {
	if (!before) return undefined;
	const after = snapshotDirty(cwd);
	if (!after) return undefined;
	const changed: string[] = [];
	for (const [p, mt] of after) if (!before.has(p) || before.get(p) !== mt) changed.push(p);
	for (const p of before.keys()) if (!after.has(p)) changed.push(p);
	return changed;
}

/**
 * A fork inherits the parent's work, not this package's orchestration of it. Delegation tool
 * calls, their results, and completion notices taught children to re-delegate a brief they were
 * handed — and children have no delegation tools, so that attempt only failed confusingly.
 */
function stripDelegation(messages: any[]): any[] {
	const removed = new Set<string>();
	const out: any[] = [];
	for (const message of messages) {
		if (message?.role === "custom" && message.customType === "delegate") continue;
		if (message?.role === "assistant" && Array.isArray(message.content)) {
			const content = message.content.filter((block: any) => {
				if (block?.type !== "toolCall" || (block.name !== "delegate" && block.name !== "delegate_ctl")) return true;
				removed.add(block.id);
				return false;
			});
			if (content.length !== message.content.length) {
				if (!content.length) continue;
				out.push({ ...message, content });
				continue;
			}
		}
		if (message?.role === "toolResult" && removed.has(message.toolCallId)) continue;
		out.push(message);
	}
	return out;
}

/** Drop a trailing assistant message whose tool calls have no results yet (the call to `delegate` itself). */
function trimDangling(messages: any[]): any[] {
	const out = messages.slice();
	while (out.length) {
		const last = out[out.length - 1];
		if (last?.role === "assistant" && Array.isArray(last.content) && last.content.some((b: any) => b?.type === "toolCall")) {
			out.pop();
			continue;
		}
		break;
	}
	return out;
}

function harvest(run: Run) {
	const msgs = messagesOf(run);
	let turns = 0;
	const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	let cost = 0;
	const changed = new Set<string>(dirtyDelta(run.dirtyBefore, run.cwd) ?? []);
	const gitBacked = run.dirtyBefore !== undefined;
	let output = "";
	let failedAttempts = 0;
	let lastAttemptError: string | undefined;
	for (let i = run.startIdx; i < msgs.length; i++) {
		const m = msgs[i];
		if (m?.role !== "assistant") continue;
		// A failed request and its retries are attempts, not turns of work. Counting them as turns
		// made a provider stalling twice for five minutes look like a slow model thinking hard.
		if (m.stopReason === "error") { failedAttempts += 1; lastAttemptError = m.errorMessage || "unknown provider error"; }
		else if (m.stopReason !== "aborted") turns += 1;
		const u = m.usage;
		if (u) {
			tokens.input += u.input ?? 0;
			tokens.output += u.output ?? 0;
			tokens.cacheRead += u.cacheRead ?? 0;
			tokens.cacheWrite += u.cacheWrite ?? 0;
			cost += u.cost?.total ?? 0;
		}
		let text = "";
		for (const b of m.content ?? []) {
			if (b?.type === "text") text += b.text;
			if (!gitBacked && b?.type === "toolCall" && (b.name === "edit" || b.name === "write")) {
				const p = b.arguments?.path ?? b.arguments?.file_path;
				if (typeof p === "string") changed.add(p);
			}
		}
		if (text.trim()) output = text;
	}
	run.turns = turns;
	run.failedAttempts = failedAttempts;
	run.lastAttemptError = lastAttemptError;
	run.tokens = tokens;
	run.cost = cost;
	run.changedFiles = [...changed].sort();
	run.output = output.length > OUTPUT_CAP ? `${output.slice(0, OUTPUT_CAP)}\n…[truncated ${output.length - OUTPUT_CAP} chars]` : output;
}

interface ApprovedModel {
	spec: string; // provider/id:thinking
	reason?: string;
	approvedAt: number;
	cost?: { input: number; output: number };
}
interface Defaults {
	approved: Record<string, ApprovedModel>;
	catalogAtApproval: string[];
}

function loadDefaults(): Defaults {
	try {
		const d = JSON.parse(readFileSync(DEFAULTS_FILE, "utf8"));
		return { approved: d.approved ?? {}, catalogAtApproval: d.catalogAtApproval ?? [] };
	} catch {
		return { approved: {}, catalogAtApproval: [] };
	}
}

/** Written by delegate_ctl approve after the user agreed in conversation, or by the user's editor. Snapshot is the full catalog. */
function saveDefault(role: string, entry: ApprovedModel, available: any[]) {
	const d = loadDefaults();
	d.approved[role] = entry;
	d.catalogAtApproval = available.map(modelKey).sort();
	mkdirSync(dirname(DEFAULTS_FILE), { recursive: true });
	writeFileSync(DEFAULTS_FILE, `${JSON.stringify(d, null, 2)}\n`);
}

function modelKey(m: any): string {
	return `${m.provider}/${m.id}`;
}

interface Rating {
	score: number;
	source: string;
	note?: string;
}
interface Ratings {
	updatedAt: number;
	entries: Record<string, Rating>;
}

function loadRatings(): Ratings {
	try {
		const d = JSON.parse(readFileSync(RATINGS_FILE, "utf8"));
		return { updatedAt: d.updatedAt ?? 0, entries: d.entries ?? {} };
	} catch {
		return { updatedAt: 0, entries: {} };
	}
}

function saveRatings(items: { model: string; score: number; source: string; note?: string }[]): Ratings {
	const r = loadRatings();
	for (const it of items) r.entries[it.model] = { score: it.score, source: it.source, note: it.note };
	r.updatedAt = Date.now();
	mkdirSync(dirname(RATINGS_FILE), { recursive: true });
	writeFileSync(RATINGS_FILE, `${JSON.stringify(r, null, 2)}\n`);
	return r;
}

/** Live OpenRouter catalog: per-token pricing, tiered overrides, expiration, Artificial Analysis indices. Public endpoint, no key. */
interface LiveOR {
	at: number;
	byId: Map<string, any>;
	error?: string;
}
let liveOR: LiveOR | undefined;

async function fetchOpenRouter(): Promise<LiveOR> {
	if (liveOR && !liveOR.error && Date.now() - liveOR.at < OPENROUTER_TTL_MS) return liveOR;
	try {
		const res = await fetch(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = (await res.json())?.data;
		if (!Array.isArray(data)) throw new Error("unexpected payload");
		liveOR = { at: Date.now(), byId: new Map(data.map((m: any) => [m.id, m])) };
	} catch (e: any) {
		liveOR = { at: Date.now(), byId: liveOR?.byId ?? new Map(), error: String(e?.message ?? e) };
	}
	return liveOR;
}

function perM(v: unknown): number | undefined {
	if (v === undefined || v === null || v === "") return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? Math.round(n * 1e6 * 1e4) / 1e4 : undefined;
}

function livePriceStr(l: any): string {
	const p = perM(l?.pricing?.prompt);
	const c = perM(l?.pricing?.completion);
	if (p === undefined || c === undefined) return "";
	const req = Number(l?.pricing?.request);
	return `$${p}/${c}/M${Number.isFinite(req) && req > 0 ? ` +$${req}/req` : ""}`;
}

// Pricing overrides per https://openrouter.ai/docs/guides/overview/models#pricing-object
const OVERRIDE_PRICE_KEYS = new Set(["prompt", "completion", "request", "image", "image_output", "web_search", "internal_reasoning", "input_cache_read", "input_cache_write", "input_cache_write_1h", "audio", "audio_output", "input_audio_cache"]);
const OVERRIDE_COND_KEYS = new Set(["min_prompt_tokens", "utc_start", "utc_end", "utc_days"]);
const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function hhmm(v: number): string {
	const n = Number(v);
	return `${String(Math.floor(n / 100)).padStart(2, "0")}:${String(n % 100).padStart(2, "0")}`;
}

/** Wrap-aware window test from the spec: t >= start || t < end when end is not after start. */
function inWindow(o: any, now: Date): boolean {
	if (o.utc_days && !o.utc_days.includes(DAY_NAMES[now.getUTCDay()])) return false;
	if (o.utc_start === undefined && o.utc_end === undefined) return true;
	const t = now.getUTCHours() * 100 + now.getUTCMinutes();
	const s = Number(o.utc_start ?? 0);
	const e = Number(o.utc_end ?? 0);
	return e > s ? t >= s && t < e : t >= s || t < e;
}

/** Render every override as the API states it; skip entries with condition fields the spec does not define. */
function overridesStr(pricing: any, now: Date): { text: string; skipped: number } {
	const out: string[] = [];
	let skipped = 0;
	for (const o of pricing?.overrides ?? []) {
		const unknown = Object.keys(o).filter((k) => !OVERRIDE_PRICE_KEYS.has(k) && !OVERRIDE_COND_KEYS.has(k));
		if (unknown.length) {
			skipped++;
			continue;
		}
		const price = `$${perM(o.prompt) ?? perM(pricing.prompt)}/${perM(o.completion) ?? perM(pricing.completion)}`;
		const cond: string[] = [];
		if (o.min_prompt_tokens !== undefined) cond.push(`>${Math.round(Number(o.min_prompt_tokens) / 1000)}k prompt`);
		if (o.utc_days) cond.push(o.utc_days.map((d: string) => d.slice(0, 3)).join(","));
		if (o.utc_start !== undefined || o.utc_end !== undefined) {
			const e = Number(o.utc_end ?? 0);
			cond.push(`${hhmm(Number(o.utc_start ?? 0))}\u2013${e === 0 ? "24:00" : hhmm(e)}Z`);
		}
		const timed = o.utc_days || o.utc_start !== undefined || o.utc_end !== undefined;
		const active = timed && o.min_prompt_tokens === undefined && inWindow(o, now);
		out.push(`${cond.join(" ") || "always"} ${price}${active ? " \u2190now" : ""}`);
	}
	return { text: out.join("; "), skipped };
}

/** Per-provider endpoints for one OpenRouter model: discount, quantization, status, uptime, own overrides. */
interface LiveEndpoints {
	at: number;
	endpoints: any[];
	error?: string;
}
const liveEP = new Map<string, LiveEndpoints>();

async function fetchEndpoints(id: string): Promise<LiveEndpoints> {
	const c = liveEP.get(id);
	if (c && !c.error && Date.now() - c.at < OPENROUTER_TTL_MS) return c;
	let r: LiveEndpoints;
	try {
		const res = await fetch(`https://openrouter.ai/api/v1/models/${id}/endpoints`, { signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const eps = (await res.json())?.data?.endpoints;
		if (!Array.isArray(eps)) throw new Error("unexpected payload");
		r = { at: Date.now(), endpoints: eps };
	} catch (e: any) {
		r = { at: Date.now(), endpoints: c?.endpoints ?? [], error: String(e?.message ?? e) };
	}
	liveEP.set(id, r);
	return r;
}

async function discoverDeals(ctx: ExtensionContext, filter = "", signal?: AbortSignal): Promise<DealsDetails> {
	const live = await fetchOpenRouter();
	if (live.error) throw new Error(`OpenRouter deal discovery unavailable: ${live.error}. Cached data was not used.`);
	const term = filter.toLowerCase();
	const universe = [...live.byId.values()];
	const catalog = universe.filter((m) => dealEligible(m) && (!term || m.id.toLowerCase().includes(term)));
	// OpenRouter has no catalog-wide endpoint-discount listing. Scan all eligible model endpoints
	// in bounded batches; successful responses share the models view's ten-minute cache.
	const endpoints = new Map<string, LiveEndpoints>();
	for (let i = 0; i < catalog.length; i += 8) {
		if (signal?.aborted) throw new DOMException("Deal discovery cancelled", "AbortError");
		const batch = await Promise.all(catalog.slice(i, i + 8).map((m) => fetchEndpoints(m.id)));
		batch.forEach((result, j) => endpoints.set(catalog[i + j].id, result));
	}
	const configured = new Set<string>((ctx.modelRegistry as any).getAvailable().filter((m: any) => m.provider === "openrouter").map((m: any) => m.id));
	return selectDeals(catalog, endpoints, configured, new Date(), term ? universe : catalog);
}

function dealsReport(d: DealsDetails): string {
	const row = (r: DealsDetails["discounts"][number]) => `  ${r.id}  ${r.price}  AA intel ${r.quality ?? "unrated"}${r.coding !== undefined ? ` coding ${r.coding}` : ""}  ${r.configured ? "configured" : "not configured"}  ${r.reason}`;
	const section = (title: string, rows: DealsDetails["discounts"]) => `${title}\n${rows.length ? rows.map(row).join("\n") : "  none with available evidence"}`;
	const partial = d.endpointFailures ? `; ${d.endpointFailures} endpoint lookups failed (promotions incomplete)` : "";
	return `OPENROUTER DEALS evaluated ${d.evaluatedAt} (catalog and endpoint responses may be cached up to 10m) — ${d.eligible} eligible tool-capable text models; ${d.endpointsChecked} model endpoint catalogs checked${partial}.\nBasket for sorting value: 1M prompt + 250k completion tokens; free, batch and per-request-priced models excluded. AA intelligence is a proxy, not proof of fitness. Endpoint discounts require routing to that provider; their percentages do not prove the endpoint is the cheapest route.\n\n${section("ENDPOINT DISCOUNTS (four distinct models)", d.discounts)}\n\n${section("OFF-PEAK RATES (three distinct models)", d.offPeak)}\n\n${section(`FRONTIER VALUE (AA intelligence top 15%, ≥128k context; floor ${d.frontierFloor ?? "unavailable"})`, d.frontier)}\n\n${section(`LIGHT VALUE (AA intelligence top half below frontier, ≥32k context; floor ${d.lightFloor ?? "unavailable"})`, d.light)}\n\nNot configured = add the exact model id to models.json before choosing it. No model was selected or approved.`;
}

function aaOf(l: any): AAIndices | undefined {
	const aa = l?.benchmarks?.artificial_analysis;
	if (!aa) return undefined;
	const out: AAIndices = {};
	if (aa.intelligence_index != null) out.intel = aa.intelligence_index;
	if (aa.coding_index != null) out.coding = aa.coding_index;
	if (aa.agentic_index != null) out.agentic = aa.agentic_index;
	return out;
}

function aaStr(aa: AAIndices | undefined): string {
	if (!aa) return "";
	const parts: string[] = [];
	if (aa.intel != null) parts.push(`intel ${aa.intel}`);
	if (aa.coding != null) parts.push(`coding ${aa.coding}`);
	if (aa.agentic != null) parts.push(`agentic ${aa.agentic}`);
	return parts.length ? `  AA[${parts.join(" ")}]` : "";
}

function endpointLine(e: any, now: Date): string {
	const p = e.pricing ?? {};
	const parts: string[] = [`${e.provider_name}${e.tag && e.tag !== e.provider_name?.toLowerCase() ? ` [${e.tag}]` : ""}`, livePriceStr(e)];
	const d = Number(p.discount);
	if (Number.isFinite(d) && d > 0) {
		const lp = perM(p.prompt);
		const lc = perM(p.completion);
		const undisc = lp !== undefined && lc !== undefined && d < 1 ? ` (listed price includes it; undiscounted $${Math.round((lp / (1 - d)) * 1e4) / 1e4}/${Math.round((lc / (1 - d)) * 1e4) / 1e4})` : "";
		parts.push(`${Math.round(d * 100)}% off${undisc}`);
	}
	if (e.quantization && e.quantization !== "unknown") parts.push(e.quantization);
	if (e.status !== undefined && e.status !== 0) parts.push(`status ${e.status}`);
	if (e.uptime_last_30m !== undefined && e.uptime_last_30m !== null) parts.push(`up ${Math.round(e.uptime_last_30m)}%`);
	if (e.context_length) parts.push(`ctx ${Math.round(e.context_length / 1000)}k`);
	const ov = overridesStr(p, now);
	if (ov.text) parts.push(`overrides: ${ov.text}`);
	if (ov.skipped) parts.push(`${ov.skipped} override(s) with unrecognized conditions skipped`);
	return parts.join("  ");
}

/** What OpenRouter says right now about one registry offering. The report text and the view both read this. */
function liveFacts(m: any, live: LiveOR | undefined): LiveFacts | undefined {
	if (m.provider !== "openrouter" || !live) return undefined;
	const l = live.byId.get(m.id);
	if (!l) return { listed: false, notes: [], tiered: false };
	const notes: string[] = [];
	const now = new Date();
	const lp = perM(l.pricing?.prompt);
	const lc = perM(l.pricing?.completion);
	const rp = Math.round((m.cost?.input ?? 0) * 1e4) / 1e4;
	const rc = Math.round((m.cost?.output ?? 0) * 1e4) / 1e4;
	const differs = lp !== undefined && lc !== undefined && (lp !== rp || lc !== rc);
	if (differs) notes.push(`live now ${livePriceStr(l)} (registry differs)`);
	else {
		const req = Number(l.pricing?.request);
		if (Number.isFinite(req) && req > 0) notes.push(`+$${req}/req`);
	}
	const ov = overridesStr(l.pricing, now);
	if (ov.text) notes.push(`top provider overrides: ${ov.text}`);
	if (ov.skipped) notes.push(`${ov.skipped} override(s) with unrecognized conditions skipped`);
	if (l.expiration_date) notes.push(`expires ${l.expiration_date}`);
	const ep = liveEP.get(m.id);
	const epFailed = Boolean(ep?.error && !ep.endpoints.length);
	return {
		listed: true, notes, tiered: Boolean(ov.text),
		livePrice: differs ? livePriceStr(l) : undefined,
		expires: l.expiration_date ? String(l.expiration_date) : undefined,
		aa: aaOf(l),
		endpoints: ep && !epFailed ? ep.endpoints.map((e) => endpointLine(e, now)) : undefined,
		endpointsError: epFailed ? ep!.error : undefined,
	};
}

function liveStr(f: LiveFacts | undefined): string {
	if (!f) return "";
	if (!f.listed) return "  live: not listed on OpenRouter now";
	const endpoints = f.endpointsError
		? `\n      endpoints: fetch failed (${f.endpointsError})`
		: f.endpoints ? `\n      endpoints (${f.endpoints.length}):\n${f.endpoints.map((e) => `        ${e}`).join("\n")}` : "";
	return (f.notes.length ? `  ${f.notes.join("; ")}` : "") + aaStr(f.aa) + endpoints;
}

function liveSummary(live: LiveOR | undefined): string {
	if (!live) return "not fetched";
	const age = Math.round((Date.now() - live.at) / 1000);
	const aaCount = [...live.byId.values()].filter((l) => l.benchmarks?.artificial_analysis).length;
	if (live.error) return `fetch failed (${live.error})${live.byId.size ? `, data from ${age}s ago` : ""}`;
	return `${live.byId.size} live, ${aaCount} with AA, fetched ${age}s ago (${new Date().toISOString().slice(11, 16)}Z)`;
}

function ratingStr(r: Ratings, name: string): string {
	const e = r.entries[name];
	if (!e) return "";
	const note = e.note ? ` ${e.note.length > 60 ? `${e.note.slice(0, 60)}\u2026` : e.note}` : "";
	return `  rated ${e.score} (${e.source.length > 40 ? `${e.source.slice(0, 40)}\u2026` : e.source})${note}`;
}

function ratingsSummary(r: Ratings): string {
	const n = Object.keys(r.entries).length;
	if (!n) return "none";
	const age = ageDays(r.updatedAt);
	return `${n}, ${age}d old${age > RATINGS_STALE_DAYS ? " (stale)" : ""}`;
}

function costStr(m: any): string {
	return m?.cost ? `$${m.cost.input ?? 0}/${m.cost.output ?? 0}/M` : "$?";
}

function ageDays(ts: number): number {
	return Math.floor((Date.now() - ts) / 86_400_000);
}

/** Approved defaults + drift against the live catalog. */
function defaultsFacts(ctx: ExtensionContext): ModelsDetails["defaults"] {
	const d = loadDefaults();
	const reg: any = ctx.modelRegistry;
	const avail: any[] = reg.getAvailable();
	const byKey = new Map(avail.map((m) => [modelKey(m), m]));
	const approved: ModelsDetails["defaults"]["approved"] = [];
	const drift: string[] = [];
	for (const [role, a] of Object.entries(d.approved)) {
		const base = a.spec.split(":")[0];
		const m = byKey.get(base);
		approved.push({ role, spec: a.spec, ageDays: ageDays(a.approvedAt), reason: a.reason });
		if (!m) drift.push(`${role}: ${base} is no longer available`);
		else if (a.cost && m.cost && (a.cost.input !== m.cost.input || a.cost.output !== m.cost.output))
			drift.push(`${role}: price changed $${a.cost.input}/${a.cost.output} \u2192 $${m.cost.input}/${m.cost.output}/M`);
		if (m && m.provider === "openrouter" && liveOR && !liveOR.error) {
			const l = liveOR.byId.get(m.id);
			if (!l) drift.push(`${role}: ${base} not listed on OpenRouter right now`);
			else {
				const lp = perM(l.pricing?.prompt);
				const lc = perM(l.pricing?.completion);
				if (lp !== undefined && lc !== undefined && a.cost && (lp !== a.cost.input || lc !== a.cost.output))
					drift.push(`${role}: OpenRouter live price $${lp}/${lc}/M vs approved $${a.cost.input}/${a.cost.output}/M`);
				if (l.expiration_date) drift.push(`${role}: OpenRouter lists expiration ${l.expiration_date}`);
			}
		}
		if (ageDays(a.approvedAt) > STALE_DAYS) drift.push(`${role}: approval is ${ageDays(a.approvedAt)}d old \u2014 re-verify`);
	}
	if (d.catalogAtApproval.length) {
		const snap = new Set(d.catalogAtApproval);
		const added = avail.map(modelKey).filter((k) => !snap.has(k));
		if (added.length) drift.push(`${added.length} new since approval${added.length <= 8 ? `: ${added.join(", ")}` : " (message=<substring> to list)"}`);
	}
	// Without an approval there is nothing to drift from; the report has always said just "none".
	return { approved, drift: approved.length ? drift : [] };
}

function defaultsReport({ approved, drift }: ModelsDetails["defaults"]): string {
	if (!approved.length) return "DEFAULTS: none";
	let out = `DEFAULTS (approved by user)\n${approved.map((a) => `  ${a.role}: ${a.spec}  approved ${a.ageDays}d ago${a.reason ? ` \u2014 ${a.reason}` : ""}`).join("\n")}`;
	if (drift.length) out += `\nDRIFT:\n  ${drift.join("\n  ")}`;
	return out;
}

function fmtTokens(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

const MAX_TOOL_CALLS = 200;

function view(run: Run): RunView {
	return {
		id: run.id,
		segment: run.segment,
		stopped: run.stopped,
		settled: run.completion.settled,
		role: run.role,
		model: run.model,
		cwd: run.cwd,
		thinking: run.thinking,
		context: run.context,
		forkedMessages: run.forkedMessages,
		contextWindow: run.contextWindow,
		status: run.status,
		task: run.task,
		output: run.output,
		turns: run.turns,
		tokens: run.tokens,
		cost: run.cost,
		durationMs: (run.endedAt ?? Date.now()) - run.startedAt,
		changedFiles: run.changedFiles,
		droppedTools: run.droppedTools,
		failedAttempts: run.failedAttempts,
		lastAttemptError: run.lastAttemptError,
		toolCalls: run.toolCalls,
		activeTool: run.activeTools.values().next().value,
		// A synchronous launch is a blocked parent too, but only while it is actually running:
		// the recorded outcome should not claim someone is still waiting on it.
		joinedWaiters: run.completion.waiting + (run.syncJoined && run.status === "running" ? 1 : 0),
		revision: run.revision,
		lastTool: run.lastTool,
		error: run.error,
		sessionFile: run.sessionFile,
	};
}

// The SDK retains result objects in its session tree. Published facts must not
// share mutable arrays/objects with a child that is still running or later resumed.
function recordedView(run: Run): RunView {
	return structuredClone(view(run));
}

function summary(run: Run): string {
	const dur = ((run.endedAt ?? Date.now()) - run.startedAt) / 1000;
	const parts = [
		`${run.status} · ${run.id}`,
		`role ${run.role}`,
		`model ${run.model}${run.thinking ? `:${run.thinking}` : ""}`,
		run.context === "fork" ? `context forked from ${run.forkedMessages ?? 0} parent messages` : "context fresh",
		`${run.turns} turn${run.turns === 1 ? "" : "s"} in ${dur.toFixed(0)}s`,
		`tokens in ${fmtTokens(run.tokens.input)}, out ${fmtTokens(run.tokens.output)}` +
			(run.tokens.cacheRead ? `, cached ${fmtTokens(run.tokens.cacheRead)}` : ""),
		run.cost ? `$${run.cost.toFixed(4)}` : "",
	].filter(Boolean);
	let s = parts.join(" · ");
	if (run.failedAttempts) s += `\n${run.failedAttempts} provider attempt${run.failedAttempts === 1 ? "" : "s"} failed and were retried before this (last: ${run.lastAttemptError}) — that wall clock and any tokens are included above.`;
	if (run.sessionFile) s += `\nsession: ${run.sessionFile}`;
	if (run.droppedTools.length) s += `\ntools the child could not have (children get built-ins only): ${run.droppedTools.join(", ")}`;
	if (run.changedFiles.length) s += `\nchanged: ${run.changedFiles.join(", ")}`;
	if (run.error) s += `\nerror: ${run.error}`;
	return s;
}

/** The child's words are quoted, never blended into this tool's own reporting. */
function resultText(run: Run): string {
	return `${summary(run)}\n\n----- ${run.id} reported, verbatim -----\n${run.output || "(the child ended without a final message)"}\n----- end of report -----`;
}

function log(run: Run) {
	try {
		mkdirSync(dirname(LOG_FILE), { recursive: true });
		const { session: _s, timer: _t, activityCache: _a, streamingMessage: _m, activeTools: _tools, completion: _completion, ready: _ready, systemPrompt: _prompt, contextFiles: _context, appendSystemPrompt: _append, ...rest } = run;
		appendFileSync(LOG_FILE, `${JSON.stringify({ ...rest, output: run.output.slice(0, 2000), ts: Date.now() })}\n`);
	} catch {
		/* logging must never fail the run */
	}
}

function retire(keep: Run) {
	const finished = [...runs.values()].filter((r) => r.ownerKey === keep.ownerKey && r !== keep && r.session && r.completion.settled);
	finished.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
	while (finished.length > MAX_RETAINED_SESSIONS - 1) {
		const r = finished.shift()!;
		r.activityCache = { revision: r.revision, items: activityOf(r) };
		try {
			r.session.dispose();
		} catch {
			/* ignore */
		}
		r.session = undefined;
	}
}

function finish(run: Run, status: Status, error?: string) {
	if (run.timer) clearTimeout(run.timer);
	run.timer = undefined;
	run.endedAt = Date.now();
	run.status = status;
	if (error) run.error = error;
	try { if (run.session) harvest(run); }
	catch (e) { run.status = "error"; run.error = `Cannot read child transcript: ${String(e)}`; }
	if (run.status === "timeout" && !run.error) {
		run.error = `Stopped after its ${Math.round(run.timeoutMs / 60000)} min budget (timeoutMs, default ${DEFAULT_TIMEOUT_MS / 60000} min). Its work up to that point stands and is not rolled back.`
			+ (run.failedAttempts
				? ` Most of that budget went to ${run.failedAttempts} failed provider attempt${run.failedAttempts === 1 ? "" : "s"} and retries (last: ${run.lastAttemptError}), not to the work \u2014 investigate that provider or choose another offering before granting more time.`
				: ` Give it a larger timeoutMs only if the work genuinely needs longer.`);
	}
	run.activeTools.clear();
	run.streamingMessage = undefined;
	run.revision++;
	try { saveRun(run); }
	catch (e) { run.status = "error"; run.error = `Could not persist completion: ${String(e)}`; }
	log(run);
	retire(run);
	run.completion.settle(finalResult(run));
	milestone(run, { kind: "settled", status: run.status, changedFiles: run.changedFiles.slice(0, 20) });
	changed();
}

async function cancelRun(run: Run) {
	if (run.foreign) throw foreignError(run);
	run.stopped = true;
	if (run.status === "running") run.status = "cancelled";
	try { saveRun(run); }
	finally { changed(); await run.session?.abort(); }
}

function publish(completion: RunCompletion<RunResult>) {
	if (completion.claimed) return;
	const result = completion.result;
	const run = runs.get(result.details.id);
	if (!run || run.segment !== result.details.segment || run.acknowledged) return;
	if (run.foreign) return; // Its owner delivers it.
	const owner = state.owners.get(run.ownerKey);
	if (!owner?.binding || owner.closed) return;
	const key = `${run.id}:${run.segment}`;
	if (owner.queued.has(key)) return;
	owner.queued.add(key);
	try {
		owner.binding.pi.sendMessage(
			{ customType: "delegate", content: `delegate finished\n${result.content[0].text}`, display: true, details: result.details },
			{ deliverAs: "followUp", triggerTurn: true },
		);
	} catch (error) { owner.queued.delete(key); throw error; }
}

function acknowledge(owner: Owner, details: any) {
	// A several-run wait delivers each settled pi run it reports, with that run's own receipt.
	if (details?.kind === "runs" && Array.isArray(details.rows)) { for (const row of details.rows) acknowledge(owner, row); return; }
	const run = details?.id ? runs.get(details.id) : undefined;
	if (!run || !details.completionReceipt || run.ownerKey !== owner.key || details.status === "running" || details.segment !== run.segment || run.acknowledged) return;
	run.acknowledged = true;
	owner.queued.delete(`${run.id}:${run.segment}`);
}

async function closeOwner(owner: Owner) {
	owner.binding = undefined;
	owner.closed = true;
	await Promise.all(ownedRuns(owner).map(async (run) => {
		if (!run.foreign) {
			if (!run.completion.settled) {
				if (run.status === "running") run.status = "interrupted";
				await run.session?.abort();
				await run.completion.wait();
			}
			run.session?.dispose();
			// Release ownership so the next process to open this parent adopts it.
			run.ownerPid = run.ownerHost = run.ownerToken = undefined;
			try { saveRun(run); } catch { /* the record stays with its last owner; a dead owner is adopted anyway */ }
		}
		runs.delete(run.id);
	}));
	state.owners.delete(owner.key);
}

/** Reserve a segment before awaiting setup: concurrent steers cannot create duplicate sessions. */
function armTimeout(run: Run) {
	if (run.timer) clearTimeout(run.timer);
	const spent = Date.now() - run.segmentStartedAt;
	if (spent >= run.timeoutMs) throw new Error(`${run.id} has already run ${Math.round(spent / 60000)} min of this segment; a ${Math.round(run.timeoutMs / 60000)} min budget is already spent. Pass a larger timeoutMs.`);
	// The explanation is composed in finish(), after harvesting can say where the budget went.
	run.timer = setTimeout(() => { run.status = "timeout"; void run.session.abort(); }, run.timeoutMs - spent);
}

function beginResume(run: Run, restart: boolean, replacement?: { model?: string; thinking?: string; contextWindow?: number; timeoutMs?: number }) {
	if (!run.completion.settled) throw new Error(`${run.id} is still stopping; wait for completion before resuming.`);
	if (run.stopped && !restart) throw new Error(`${run.id} was explicitly stopped. Restart only at the user's request (steer with restart: true).`);
	if (run.writer) {
		const clash = [...runs.values()].find((r) => r !== run && !r.completion.settled && r.writer && r.cwd === run.cwd);
		if (clash) throw new Error(`${clash.id} is already writing in ${run.cwd}; wait before resuming this child.`);
	}
	openTranscript(run); // Missing history is an error, never permission to start over.
	// A retained session stays bound to the offering it was opened with. Changing the record alone
	// sends the next segment to the old provider, so a new offering reopens from the transcript.
	const rebind = Boolean(replacement) && ((replacement!.model ?? run.model) !== run.model || (replacement!.thinking ?? run.thinking) !== run.thinking);
	const next: Run = { ...run, ...replacement, segment: run.segment + 1, stopped: false, acknowledged: false,
		status: "running", endedAt: undefined, error: undefined, revision: run.revision + 1,
		session: rebind ? undefined : run.session,
		completion: new RunCompletion<RunResult>() };
	saveRun(next);
	if (rebind) {
		try { run.session?.dispose(); } catch { /* a stale session must not block its replacement */ }
	}
	Object.assign(run, next);
	changed();
}

/** Actual conversation after the inherited prefix, including streamed text and tool results. */
function activityOf(run: Run): ChildActivity {
	if (run.activityCache?.revision === run.revision) return run.activityCache.items;
	let messages: any[];
	try { messages = messagesOf(run).slice(run.startIdx).filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult"); }
	catch (error) { return { messages: [], activeTools: run.activeTools, error: String(error) }; }
	const items = { messages, activeTools: run.activeTools,
		streaming: run.streamingMessage && !messages.includes(run.streamingMessage) ? run.streamingMessage : undefined };
	run.activityCache = { revision: run.revision, items };
	return items;
}

export default function (pi: ExtensionAPI) {
	// ACP Pi workers (pi-acp) are full Pi processes that load installed extensions. They must not
	// receive `delegate`, or a worker could start its own orchestration and recurse.
	if (process.env.PI_STRINGS_WORKER === "1" || process.env.PI_STRINGS_OPENED === "1") return;
	// Reload refreshes configuration for future session opens. Live children retain the
	// runtime they already own; replacing a binding must not mutate their provider state.
	let modelRuntime: Promise<ModelRuntime> | undefined;
	const getRuntime = () => modelRuntime ??= ModelRuntime.create();
	// Account and provider extensions register offerings in the parent's live catalog rather
	// than models.json, and they register them whenever they please \u2014 at startup, on reload, or
	// when the user switches accounts. Mirror that catalog into this runtime at every child
	// session open, so a child is limited by the parent's providers, not by launch order.
	const mirrored = new Set<string>();
	function mirrorProviders(runtime: ModelRuntime) {
		const registry: any = requireOwner().binding!.ctx.modelRegistry;
		const present = new Set<string>(registry.getRegisteredProviderIds());
		for (const id of present) {
			const native = registry.getRegisteredNativeProvider(id);
			if (native) runtime.registerNativeProvider(native);
			const config = registry.getRegisteredProviderConfig(id);
			if (config) runtime.registerProvider(id, config);
			mirrored.add(id);
		}
		for (const id of mirrored) {
			if (present.has(id)) continue;
			runtime.unregisterProvider(id); // The parent dropped it; a child must not keep serving it.
			mirrored.delete(id);
		}
	}
	let owner: Owner | undefined;
	let attachError: string | undefined;
	// The acp backend (acp-backend.ts) over the process's one Coordinator. Its runs belong to a
	// parent as pi runs do, and a turn that settles with no wait joined wakes that parent the same way.
	const acp = new AcpBackend({
		ownerKey: () => requireOwner().key,
		changed,
		settled: (v, ownerKey) => {
			const target = state.owners.get(ownerKey);
			if (!target?.binding || target.closed) return;
			target.binding.pi.sendMessage(
				{ customType: "delegate", content: `delegate finished\n${acpResultText(v)}`, display: true, details: v },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		},
		// Next to this parent's pi run pointers, under the subsession directory.
		runDir: (ownerKey) => join(state.owners.get(ownerKey)?.dir ?? pointerDir(ownerKey), "acp"),
	});
	// Canonical phased todo (transferred from pi-omp; see todo-ext.ts). The reminder reads this
	// parent's live children: while one is unsettled its completion message re-wakes the loop,
	// so an incomplete-todo nag at agent_end would be premature.
	installTodo(pi, {
		hasActiveJobs: () => {
			if (!owner || owner.closed) return false;
			return ownedRuns(owner).some((run) => !run.completion.settled) || acp.owned(owner.key).some((run) => run.status === "running");
		},
	});
	function requireOwner(): Owner {
		if (!owner || owner.closed || owner.binding?.pi !== pi) throw new Error(attachError ?? "Delegate runtime is not attached to this parent.");
		return owner;
	}
	/**
	 * The runtime registry outlives /reload so that live children survive it, so the Owner found
	 * there may have been built by the previous version of this file. Before per-run ownership it
	 * held a parent lease and a shared index, had no pointer `dir`, and its runs carried no owner.
	 * Upgrade it in place: its live children hold references to this very object.
	 */
	function adoptPreviousOwner(previous: Owner) {
		const legacy = previous as Owner & { path?: string; runPaths?: string[]; lost?: Error; release?: () => Promise<void> };
		const release = legacy.release;
		delete legacy.path; delete legacy.runPaths; delete legacy.lost; delete legacy.release;
		legacy.dir = pointerDir(legacy.key);
		legacy.queued ??= new Set();
		// Its runs, live or settled, belong to this process. Recording that stops another process
		// opening this parent from adopting children that are still running here.
		for (const run of ownedRuns(legacy)) if (!run.ownerToken) { Object.assign(run, processOwner()); saveRun(run); }
		// The lease no longer guards anything; releasing it stops its refresh timer and removes its lock.
		// Call it with no arguments: proper-lockfile reads an extra one as its callback and crashes Pi.
		if (release) void Promise.resolve().then(() => release()).catch(() => {});
	}
	async function attach(ctx: ExtensionContext) {
		const path = ownerPath(ctx);
		let existing = state.owners.get(path);
		if (existing?.binding && existing.binding.pi !== pi) throw new Error("This parent already has an attached delegate runtime.");
		if (existing && typeof existing.dir !== "string") adoptPreviousOwner(existing);
		if (!existing) {
			const created: Owner = { key: path, dir: pointerDir(path), queued: new Set(), closed: false };
			state.owners.set(path, created);
			try {
				for (const recordPath of runRecordPaths(created)) {
					const run = restoreRun(recordPath, created);
					runs.set(run.id, run);
				}
				// ACP runs come back parked: readable at once, reopened only by a steer.
				acp.restore(created.key);
			} catch (error) { await closeOwner(created); await acp.closeOwner(created.key); throw error; }
			existing = created;
		}
		owner = existing;
		owner.binding = { pi, ctx };
		attachError = undefined;
		// The parent's persisted receipt is the durable delivery acknowledgement.
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom_message" && entry.customType === "delegate") acknowledge(owner, entry.details);
			if (entry.type === "message" && entry.message.role === "toolResult") acknowledge(owner, entry.message.details);
		}
		for (const run of ownedRuns(owner)) if (run.completion.settled) publish(run.completion);
	}
	async function steer(run: Run, message: string, restart = false, replacement?: { model?: string; thinking?: string; contextWindow?: number; timeoutMs?: number }) {
		requireOwner();
		if (run.foreign) throw foreignError(run);
		if (run.status === "running") {
			await run.ready;
			if (run.status === "running") {
				// A live turn is already bound to its model. Never swap it underneath running work.
				if (replacement?.model) throw new Error(`${run.id} is running on ${run.model}; a different offering applies to its next segment. Wait for it or cancel it, then steer with model.`);
				if (replacement?.timeoutMs !== undefined) {
					// More time is the one change a live segment can take: re-arm its own budget.
					const previous = run.timeoutMs;
					run.timeoutMs = replacement.timeoutMs;
					try { armTimeout(run); }
					catch (error) { run.timeoutMs = previous; armTimeout(run); throw error; }
					saveRun(run);
					changed();
				}
				await run.session.steer(message); return;
			}
		}
		beginResume(run, restart, replacement);
		const completion = run.completion;
		void launch(run, message).then(() => publish(completion));
	}
	const liveSource: LiveSource = {
		all: () => owner ? [...ownedRuns(owner).map(view), ...acp.owned(owner.key).map(acpRowView)] : [],
		activity: (id) => {
			const r = runs.get(id);
			if (r && r.ownerKey === owner?.key) return activityOf(r);
			return owner && acp.find(id, owner.key) ? acp.activity(id) : { messages: [], activeTools: new Map() };
		},
		subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		steer: async (id, message) => {
			if (acp.find(id, requireOwner().key)) { await acp.steer(id, { message }); return; }
			const r = runs.get(id);
			if (!r || r.ownerKey !== requireOwner().key) throw new Error(`${id}: child is not owned by this parent`);
			await steer(r, message, true); // A message typed directly by the human is an explicit restart request.
		},
		cancel: async (id) => {
			if (acp.find(id, requireOwner().key)) { await acp.cancel(id, {}); return; }
			const r = runs.get(id); if (r?.ownerKey === requireOwner().key) await cancelRun(r);
		},
	};
	pi.on("message_end", (event) => {
		if (!owner?.binding || owner.binding.pi !== pi) return;
		const message = event.message;
		if ((message.role === "custom" && message.customType === "delegate") || message.role === "toolResult") acknowledge(owner, message.details);
	});

	async function openSession(run: Run, onUpdate?: (u: any) => void, preparedLoader?: DefaultResourceLoader) {
		if (run.session) return;
		if (!statSync(run.cwd).isDirectory()) throw new Error(`Saved working directory is unavailable: ${run.cwd}`);
		const runtime = await getRuntime();
		mirrorProviders(runtime);
		const slash = run.model.indexOf("/");
		const model = runtime.getModel(run.model.slice(0, slash), run.model.slice(slash + 1));
		if (!model) throw new Error(`Saved model is unavailable: ${run.model}. No fallback was selected \u2014 choose a replacement: delegate_ctl steer runId=${run.id} model=<provider/id[:thinking]>.`);
		const loader = preparedLoader ?? new DefaultResourceLoader({
			cwd: run.cwd, agentDir: AGENT_DIR,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			systemPrompt: run.systemPrompt,
			agentsFilesOverride: () => ({ agentsFiles: run.contextFiles }),
			appendSystemPromptOverride: () => run.appendSystemPrompt,
		});
		if (!preparedLoader) await loader.reload();
		const manager = openTranscript(run);
		// A crash may have happened before the first prompt was appended. Preserve the original
		// brief before the explicit revival message rather than silently discarding the task.
		if (run.segment > 1 && !messagesOf(run).some((message, index) => index >= run.startIdx && message.role === "user")) {
			manager.appendMessage({ role: "user", content: [{ type: "text", text: run.task }], timestamp: run.startedAt });
		}
		const { session } = await createAgentSession({
			cwd: run.cwd, model, thinkingLevel: run.thinking as any,
			tools: run.tools, resourceLoader: loader,
			sessionManager: manager, modelRuntime: runtime,
		} as any);
		run.session = session;
		saveRun(run);

		session.subscribe((ev: any) => {
			if (ev.type === "message_start" || ev.type === "message_update") {
				if (ev.message?.role === "assistant") run.streamingMessage = ev.message;
			}
			if (ev.type === "message_end") run.streamingMessage = undefined;
			if (ev.type === "tool_execution_start") {
				run.lastTool = ev.toolName;
				run.activeTools.set(ev.toolCallId, { name: ev.toolName, args: ev.args ?? {} });
				if (run.toolCalls.length < MAX_TOOL_CALLS) run.toolCalls.push({ name: ev.toolName, args: (ev.args ?? {}) as Record<string, unknown>, at: Date.now() });
				if (state.owners.get(run.ownerKey)?.binding?.pi === pi) onUpdate?.({ content: [{ type: "text", text: `${run.id}: ${ev.toolName}` }], details: view(run) });
			}
			if (ev.type === "tool_execution_update") {
				const active = run.activeTools.get(ev.toolCallId);
				if (active) active.result = { ...ev.partialResult, isError: false };
			}
			if (ev.type === "tool_execution_end") run.activeTools.delete(ev.toolCallId);
			run.revision++;
			if (ev.type === "message_end") {
				try { saveRun(run); }
				catch (error) { run.status = "error"; run.error = `Cannot save child state: ${String(error)}`; void session.abort(); }
				if (run.status === "running" && ev.message?.role === "assistant") {
					const text = ev.message.content?.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ").trim();
					if (text) milestone(run, { kind: "note", text: text.slice(0, 500) });
				}
			}
			changed();
		});
	}

	async function launch(run: Run, task: string, signal?: AbortSignal, onUpdate?: (u: any) => void, preparedLoader?: DefaultResourceLoader) {
		const abort = () => { if (run.status === "running") { run.status = "cancelled"; run.stopped = true; void run.session?.abort(); } };
		signal?.addEventListener("abort", abort, { once: true });
		try {
			if (signal?.aborted) abort();
			run.ready = openSession(run, onUpdate, preparedLoader);
			await run.ready;
			if (run.status === "running") {
				milestone(run, { kind: "started", task: task.slice(0, 600) });
				run.dirtyBefore = snapshotDirty(run.cwd);
				run.segmentStartedAt = Date.now();
				armTimeout(run);
				await run.session.prompt(task, { preflightResult: (accepted: boolean) => {
					// Pi abort() cannot cancel prompt preflight while its agent is still idle.
					// Recheck at the SDK's dispatch boundary, before it starts the agent loop.
					if (accepted && run.status !== "running") throw new Error("Child stopped before prompt dispatch.");
				} });
				// Provider failures are assistant messages, not rejected prompt promises.
				const last = messagesOf(run).findLast((message) => message.role === "assistant");
				if (run.status === "running" && last?.stopReason === "error") throw new Error(last.errorMessage ?? "Child provider failed.");
			}
			finish(run, run.status === "running" ? "complete" : run.status);
		} catch (e: any) {
			finish(run, run.status === "running" ? "error" : run.status, String(e?.message ?? e));
		} finally { signal?.removeEventListener("abort", abort); run.ready = undefined; }
	}

	// What the control call was about, in the header rather than buried in its output.
	const subject = (args: any): string => {
		if (!args) return "";
		if (args.action === "models" || args.action === "deals" || args.action === "roles") return args.message ? `"${args.message}"` : "";
		if (args.action === "approve") return [args.role, args.model].filter(Boolean).join(" \u2192 ");
		if (args.action === "rate") return `${args.ratings?.length ?? 0} offering${args.ratings?.length === 1 ? "" : "s"}`;
		return args.runId ?? "";
	};

	// Async dispatch stays silent in the transcript; a call that blocks the parent's turn must not.
	// Without this the parent simply stops for minutes with nothing on screen explaining why.
	const blockingCall = (label: (args: any) => string | undefined) => (args: any, theme: any, ctx: any) => {
		const text = label(args);
		const state = ctx.state as { interval?: ReturnType<typeof setInterval>; startedAt?: number };
		// Settlement is read from the run itself: the call renders before the result in the same
		// pass, and forcing an extra pass reprints the whole block in regular mode. Once the
		// outcome line exists it is the record, and a stale "waiting" above it would lie.
		const run = runs.get(args?.runId ?? syncLaunches.get(ctx.toolCallId) ?? "");
		if (!text || run?.completion.settled) { stopTicking(ctx); return empty(); }
		state.startedAt ??= Date.now();
		state.interval ??= setInterval(() => ctx.invalidate(), 1000);
		const child = run ? ` \u00b7 ${run.status === "running" ? run.activeTools.values().next().value?.name ?? "thinking" : run.status}` : "";
		return framed((width) => [truncateToWidth(theme.fg("accent", `\u23f3 ${text}`) + theme.fg("dim", `${child} \u00b7 ${elapsed(Date.now() - state.startedAt!)} \u00b7 abort to stop waiting; the child keeps running`), width, "\u2026")]);
	};
	// A synchronous launch has no run id in its arguments; its row needs one to know when to stop.
	const syncLaunches = new Map<string, string>();
	const stopTicking = (ctx: any) => {
		const state = ctx?.state as { interval?: ReturnType<typeof setInterval> } | undefined;
		if (state?.interval) { clearInterval(state.interval); state.interval = undefined; }
	};
	// The renderer must tolerate whatever shape is on disk from earlier versions; see resultView.
	const resultRenderer = (title: string) => (result: any, opts: any, theme: any, ctx: any) => {
		stopTicking(ctx);
		return framed((width) => resultView(title, ctx.args?.action, subject(ctx.args), result, opts, theme, width));
	};

	// --- acp results. A failure is reported by its code; it never becomes a different action.
	const failed = (error: unknown) => {
		if (!(error instanceof DelegateError)) throw error;
		return {
			content: [{ type: "text" as const, text: `${error.code}: ${error.message}` }], isError: true,
			details: { error: { code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) } },
		};
	};
	const settledBadly = (v: AcpRunView) => v.status !== "running" && v.status !== "idle" && v.status !== "complete";
	const acpRunResult = (v: AcpRunView) => ({ content: [{ type: "text" as const, text: acpResultText(v) }], details: v, isError: settledBadly(v) });
	const acpStartText = (v: AcpRunView) => {
		const session = sessionLabel(v);
		if (v.status === "idle") return `${v.id} idle (acp ${v.session.agent}, ${session}); no turn sent. Use delegate_ctl steer with this runId to send one, status or result to read it, close to disconnect.`;
		return `${v.id} running (acp ${v.session.agent}, ${session}). Completion will wake you; use delegate_ctl wait with this runId when dependent work needs the result.`;
	};
	/** One run in a wait report: its full report once settled, its one-line summary while pending. */
	interface WaitRow { id: string; settled: boolean; report: string; summary: string; details: any; bad: boolean }
	const acpRow = (v: AcpRunView, settled: boolean): WaitRow => ({ id: v.id, settled, report: acpResultText(v), summary: acpSummary(v), details: v, bad: settledBadly(v) });
	const piRow = (run: Run): WaitRow => run.completion.settled
		? { id: run.id, settled: true, report: resultText(run), summary: summary(run), details: finalResult(run).details, bad: run.status !== "complete" }
		: { id: run.id, settled: false, report: resultText(run), summary: summary(run), details: recordedView(run), bad: false };
	const waitResult = (reason: WaitOutcome<unknown>["reason"], rows: WaitRow[], runIds: readonly string[], timeoutMs?: number, lost = "these runs; they did not settle") => {
		const settled = rows.filter((row) => row.settled), pending = rows.filter((row) => !row.settled);
		const still = pending.map((row) => row.id).join(", ");
		const head = reason === "timeout" ? `wait timed out after ${timeoutMs} ms; nothing was cancelled. Still running: ${still}`
			: reason === "interrupted" ? `wait interrupted — queued messages are waiting for you; the runs keep going.\nAnswer the queued message(s) first, then call wait again to rejoin. Still running: ${still}`
			: reason === "lost" ? `wait lost ${lost}: ${still}`
			: pending.length ? `${settled.length} settled; still running: ${still}` : "";
		const text = [head, ...settled.map((row) => row.report), ...(reason === "settled" ? [] : pending.map((row) => row.summary))].filter(Boolean).join("\n\n");
		const details = runIds.length === 1 ? (settled[0] ?? pending[0])?.details : { kind: "runs", rows: [...settled, ...pending].map((row) => row.details), wait: { reason, pending: pending.map((row) => row.id) } };
		return { content: [{ type: "text" as const, text }], details, isError: reason === "lost" || (reason === "settled" && settled.some((row) => row.bad)) };
	};
	const acpWaitResult = async (outcome: WaitOutcome<AcpRunView>, runIds: readonly string[], timeoutMs?: number) => {
		const pending = await Promise.all(outcome.pending.map((id) => acp.result(id)));
		return waitResult(outcome.reason, [...outcome.settled.map((v) => acpRow(v, true)), ...pending.map((v) => acpRow(v, false))], runIds, timeoutMs, "the ACP coordinator (it is shutting down); these runs did not settle");
	};

	/**
	 * delegate_ctl wait over runs of either backend, any or all. pi runs are joined through their
	 * completion as a single-run wait joins them, so a segment that settles reports here instead of
	 * waking the parent; ACP runs through the backend's join. Queued parent messages end the wait
	 * early, a timeout ends it, and an abort only detaches: no run is ever cancelled. A run this wait
	 * reports is delivered by it; any other run keeps its own wake-up.
	 */
	async function waitRuns(owner: Owner, ids: readonly string[], mode: "any" | "all", ctx: ExtensionContext, signal?: AbortSignal, timeoutMs?: number) {
		const piRuns = new Map<string, Run>();
		const acpIds: string[] = [];
		for (const id of ids) {
			if (acp.find(id, owner.key)) { acpIds.push(id); continue; }
			const run = runs.get(id);
			if (!run || run.ownerKey !== owner.key) throw new DelegateError("RUN_NOT_FOUND", `unknown runId ${id}`, "runIds");
			unwrap(requireAction(PI_CAPABILITIES, "wait"));
			piRuns.set(id, run);
		}
		if (!piRuns.size) return acpWaitResult(await acp.wait({ runIds: acpIds, mode, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }, signal, () => ctx.hasPendingMessages()), ids, timeoutMs);
		if (signal?.aborted) throw new DOMException("Wait cancelled; the runs are unaffected.", "AbortError");
		const join = acp.join(acpIds);
		let wake = () => {};
		// While subscribed, a segment that settles is claimed by this wait, exactly as waitForChild claims it.
		const joined = new Map([...piRuns].map(([id, run]) => [id, { completion: run.completion, settledAtJoin: run.completion.settled, unsubscribe: run.completion.subscribe(() => wake()) }]));
		const deadline = timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
		const stoppedSince = new Map<string, number>();
		let aborted = false, coordinatorLost = false;
		// At most one Coordinator wait at a time: a pass woken by a pi run reuses the one still outstanding.
		let acpNext: Promise<void> | undefined;
		try {
			for (;;) {
				const acpViews = new Map(join.views().map((v) => [v.id, v]));
				const rows = ids.map((id) => { const v = acpViews.get(id); return v ? acpRow(v, v.status !== "running") : piRow(piRuns.get(id)!); });
				const settled = rows.filter((row) => row.settled);
				const end = async (reason: WaitOutcome<unknown>["reason"], lost?: string) => {
					const settledAcp = settled.flatMap((row) => acpViews.has(row.id) ? [acpViews.get(row.id)!] : []);
					join.claim(settledAcp);
					// An Amp run's thread cost is read once for its settled turn, so the result reports it.
					const costed = new Map((await acp.withCosts(settledAcp)).map((v) => [v.id, v]));
					return waitResult(reason, rows.map((row) => costed.has(row.id) ? acpRow(costed.get(row.id)!, true) : row), ids, timeoutMs, lost);
				};
				if (mode === "any" ? settled.length > 0 : settled.length === rows.length) return await end("settled");
				if (signal?.aborted) { aborted = true; throw new DOMException("Wait cancelled; the runs are unaffected.", "AbortError"); }
				if (ctx.hasPendingMessages()) return await end("interrupted");
				if (coordinatorLost) return await end("lost", "the ACP coordinator (it is shutting down, or another process owns these runs); not settled");
				// A terminal status that never settles is a child that stopped without reporting completion (see waitForChild).
				for (const [id, run] of piRuns) {
					if (run.status === "running" || run.completion.settled) { stoppedSince.delete(id); continue; }
					if (!stoppedSince.has(id)) stoppedSince.set(id, Date.now());
					else if (Date.now() - stoppedSince.get(id)! >= 2 * WAIT_POLL_MS) return await end("lost", `${id}, which stopped without reporting completion (read its status or result; steer with restart:true if it must continue). Not settled`);
				}
				const left = deadline - Date.now();
				if (left <= 0) return await end("timeout");
				const slice = Math.min(WAIT_POLL_MS, left);
				const pendingAcp = rows.flatMap((row) => !row.settled && acpViews.has(row.id) ? [acpViews.get(row.id)!] : []);
				await new Promise<void>((resolve) => {
					const onAbort = () => wake();
					const timer = setTimeout(() => wake(), slice);
					wake = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); wake = () => {}; resolve(); };
					signal?.addEventListener("abort", onAbort, { once: true });
					// The ACP slice ends early on a settling turn.
					if (pendingAcp.length) acpNext ??= join.next(pendingAcp, slice).then((reported) => { if (!reported) coordinatorLost = true; }, () => {})
						.finally(() => { acpNext = undefined; wake(); });
				});
			}
		} finally {
			for (const [id, entry] of joined) {
				entry.unsubscribe();
				// An abort reports nothing: a segment this wait claimed as it settled still wakes the parent.
				if (aborted && !entry.settledAtJoin && entry.completion.settled && entry.completion.claimed && piRuns.get(id)?.completion === entry.completion) {
					entry.completion.claimed = false;
					publish(entry.completion);
				}
			}
			join.release(aborted);
		}
	}

	pi.registerTool({
		name: "delegate",
		renderCall: blockingCall((args) => args?.sync ? `Waiting for a new ${(args.backend === "acp" ? args.agent : args.role) ?? "child"} \u2014 this launch joins at once (sync)` : undefined),
		renderResult: resultRenderer("delegate"),
		label: "Delegate",
		description:
			"Run a role on a task in its own session; returns its final report, changed files, tokens, cost, and a runId. Load the delegation skill for when to delegate, review triggers, and the model-proposal procedure. " +
			"Delegate only for context isolation, parallelism, or a model-tier switch — if the brief would be longer than the expected diff, do the work yourself. " +
			"Start the brief with a short task title on its own line, then objective, ownership, interfaces/constraints, verification, return shape. " +
			'context "fork" (default) hands the child your conversation so far; "fresh" is for adversarial review. ' +
			"Runs in the background by default \u2014 the call returns a run id at once and you are woken once, when the child finishes. There are no progress pings by design; waiting is not your work. Do other work, or use delegate_ctl wait with that runId to block without polling when nothing else can proceed, or delegate_ctl status for a single progress read when someone asks. sync:true joins at launch when explicitly needed. Children have built-in tools only. Model: run delegate_ctl models first; a role's approved default is used when model: is omitted. Proposing a model that is not the approved default is a conversation with the user, not a tool step: state the offering, price, rating and tradeoff, get their answer, then call delegate; if they want it kept, delegate_ctl action=approve. Use delegate_ctl to list roles, wait, check status, steer, or cancel. " +
			'backend "acp" runs an external ACP agent session instead (agent required, e.g. "pi", "amp", "codex", "claude"): it creates a session and sends task as its first turn, or with sessionId opens that exact native session (an Amp T-ID, say) without owning it and sends task only when given. ' +
			"An ACP child never receives your conversation (no context), and an opened session keeps its native role and model. Its report carries the agent's native session ID and each turn's request ID and delivery. Close an ACP run with delegate_ctl close when done.",
		parameters: Type.Object({
			backend: Type.Optional(Type.String({ description: 'where the child runs: "pi" (default) is an in-process Pi child; "acp" is an external ACP agent session' })),
			role: Type.Optional(Type.String({ description: 'pi: role name, required (delegate_ctl action=roles lists them). acp: "read-only" (default) or "writer" for a created session; not allowed with sessionId' })),
			task: Type.Optional(Type.String({ description: "the brief. Required, except acp with sessionId, where it is the first native turn when given" })),
			model: Type.Optional(Type.String({ description: "override. pi: provider/id[:thinking]. acp: the agent's own model ID, created sessions only" })),
			context: Type.Optional(StringEnum(["fork", "fresh"] as const)),
			cwd: Type.Optional(Type.String()),
			timeoutMs: Type.Optional(Type.Number({ description: `abort the child after this many ms; default ${DEFAULT_TIMEOUT_MS / 60000} min. Size it to the work: a build, suite, or training run that takes hours needs hours here, or it is killed mid-flight` })),
			sync: Type.Optional(Type.Boolean({ description: "block until the child finishes. Default false: the call returns at once and you are woken with the result" })),
			reason: Type.Optional(Type.String({ description: "one line: why this model for this role; recorded in the run log" })),
			agent: Type.Optional(Type.String({ description: "acp only: the ACP agent to run, e.g. pi, amp, codex, claude" })),
			sessionId: Type.Optional(Type.String({ description: "acp only: open this exact provider-native session (e.g. an Amp T-ID) instead of creating one" })),
			executionEnvironment: Type.Optional(Type.String({ description: 'acp only: "local" or "orb". Creating: where the session runs. Opening (Amp only): a verification hint' })),
			mode: Type.Optional(Type.String({ description: 'acp + amp only, created threads: Amp\'s agent mode (low, medium, high, ultra or a plugin mode), used for every turn. Not with model or sessionId' })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const start = validateStartInput(params as Record<string, unknown>);
			if (!start.ok) return failed(new DelegateError(start.error.code, start.error.message, start.error.field));
			if (start.value.backend === "acp") {
				const input = start.value;
				try {
					requireOwner();
					// A created session works where the parent does unless told otherwise; an opened one keeps its native workspace.
					const cwd = input.cwd !== undefined ? realpathSync(input.cwd) : input.origin === "created" ? realpathSync(ctx.cwd) : undefined;
					const v = await acp.start({ ...input, ...(cwd !== undefined ? { cwd } : {}) });
					if (input.sync && v.status === "running") {
						const outcome = await acp.wait({ runIds: [v.id], mode: "all" }, signal);
						return acpRunResult(outcome.settled[0] ?? await acp.result(v.id));
					}
					return { content: [{ type: "text", text: acpStartText(v) }], details: v };
				} catch (error) { return failed(error); }
			}
			const p = { ...params, role: (start.value as PiStartInput).role, task: (start.value as PiStartInput).task };
			const owner = requireOwner();
			const cwd = realpathSync(p.cwd ?? ctx.cwd);
			const roles = loadRoles(cwd, ctx.isProjectTrusted());
			const role = roles.get(p.role);
			if (!role) {
				return {
					content: [{ type: "text", text: `unknown role "${p.role}". available: ${[...roles.keys()].sort().join(", ")}` }],
					isError: true, details: undefined,
				};
			}
			// Model: explicit param, else the role's approved default, else the role file, else the parent's.
			const approved = loadDefaults().approved[role.name];
			const { model, thinking: specThinking } = resolveModel(p.model ?? approved?.spec ?? role.model, ctx);
			if (!model) return { content: [{ type: "text", text: "no model available for child" }], isError: true, details: undefined };
			const thinking = String(specThinking ?? (p.model ? undefined : approved?.spec.split(":")[1]) ?? role.thinking ?? ctx.thinkingLevel ?? "");
			const timeoutMs = p.timeoutMs ?? role.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			const wantedTools = role.tools ?? BUILTIN_TOOLS;
			const isWriter = wantedTools.some((t) => WRITE_TOOLS.has(t));
			const tools = wantedTools.filter((t) => BUILTIN_TOOLS.includes(t));
			if (!tools.length) tools.push("read");
			const context = p.context ?? role.context ?? "fork";
			const systemPrompt = role.systemPrompt + (role.systemPrompt.includes("STATUS:") ? "" : CONTRACT_FOOTER) + (context === "fork" ? FORK_FOOTER : "");
			const loader = new DefaultResourceLoader({ cwd, agentDir: AGENT_DIR, systemPrompt,
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true });
			await loader.reload();
			requireOwner(); // Setup may have yielded through a parent session replacement.
			if (isWriter) {
				const clash = [...runs.values()].find((r) => !r.completion.settled && r.writer && r.cwd === cwd);
				if (clash) return { content: [{ type: "text", text: `refused: ${clash.id} (${clash.role}) is already writing in ${cwd}. One writer per tree — wait, cancel it, or give this child its own cwd/worktree.` }], isError: true, details: undefined };
			}
			// Freeze the runtime inputs before advertising a run, including project instructions.
			const dir = storageDir(cwd);
			const created = SessionManager.create(cwd, dir);
			const sessionFile = created.getSessionFile()!;
			// Pi normally defers the first disk write until an assistant replies. Establish its own
			// header now so a crash before the first response still leaves a resumable identity.
			writeFileSync(sessionFile, `${JSON.stringify(created.getHeader())}\n`, { flag: "wx", mode: 0o600 });
			const manager = SessionManager.open(sessionFile);
			const inherited = context === "fork" ? convertToLlm(trimDangling(stripDelegation(buildSessionContext(ctx.sessionManager.buildContextEntries()).messages))) : [];
			for (const message of inherited) manager.appendMessage(message);
			const id = newId(role.name);
			const run: Run = {
				id, ownerKey: owner.key, recordPath: join(dir, `${encodeURIComponent(id)}.json`),
				segment: 1, stopped: false, acknowledged: false,
				systemPrompt, contextFiles: loader.getAgentsFiles().agentsFiles, appendSystemPrompt: loader.getAppendSystemPrompt(),
				tools, timeoutMs,
				sessionFile, sessionId: manager.getSessionId(),
				completion: new RunCompletion<RunResult>(),
				role: role.name,
				model: modelKey(model),
				thinking,
				context,
				cwd,
				task: p.task,
				status: "running",
				startedAt: Date.now(), segmentStartedAt: Date.now(),
				turns: 0, failedAttempts: 0,
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				cost: 0,
				changedFiles: [],
				droppedTools: wantedTools.filter((t) => !BUILTIN_TOOLS.includes(t)),
				output: "",
				startIdx: inherited.length,
				forkedMessages: context === "fork" ? inherited.length : undefined,
				writer: isWriter, syncJoined: p.sync === true,
				toolCalls: [],
				activeTools: new Map(),
				revision: 0,
				contextWindow: model.contextWindow,
				...processOwner(),
			};
			saveRun(run);
			writeRecord(join(owner.dir, `${encodeURIComponent(run.id)}.json`), { version: 1, recordPath: run.recordPath });
			runs.set(run.id, run);
			changed();
			const completion = run.completion;
			if (p.sync) syncLaunches.set(_id, run.id);
			const work = launch(run, p.task, p.sync ? signal : undefined, onUpdate, loader);

			if (!p.sync) {
				void work.then(() => publish(completion));
				return { content: [{ type: "text", text: `${run.id} running (${run.context}, ${run.model}). Completion will wake you; use delegate_ctl wait with this runId when dependent work needs the result.` }], details: recordedView(run) };
			}

			await work;
			return completion.result;
		},
	});

const WAIT_POLL_MS = 1000;
/**
 * Join the child, waking early when queued messages exist: pi delivers steering only after this
 * tool returns, so a blocking join would postpone every queued message until the child finishes.
 * Early return is not an error — the child keeps running and wait rejoins after the messages are handled.
 */
async function waitForChild(run: Run, ctx: ExtensionContext, signal?: AbortSignal) {
	if (signal?.aborted) throw new DOMException("Wait cancelled; the child is unaffected.", "AbortError");
	const interrupted = {
		content: [{ type: "text" as const, text: `${run.id}: wait interrupted — queued messages are waiting for you; the child keeps running.\nAnswer the queued message(s) first, then call wait again to rejoin.\n${summary(run)}` }],
		details: recordedView(run),
		isError: false, // an early wake is a normal result, not a failure
	};
	const lost = {
		content: [{ type: "text" as const, text: `${run.id}: wait lost the child — status=${run.status}${run.error ? `: ${run.error}` : ""}\nThe child stopped without reporting completion, so this wait cannot return a result. Read status or result for details; steer with restart:true if it must continue.` }],
		details: recordedView(run),
		isError: true,
	};
	return new Promise<Awaited<ReturnType<typeof run.completion.wait>>>((resolve, reject) => {
		let done = false;
		let unsubscribe: () => void = () => {};
		let lostPolls = 0;
		let poll: ReturnType<typeof setInterval> | undefined;
		const finish = (deliver: () => void) => {
			if (done) return;
			done = true;
			unsubscribe();
			if (poll !== undefined) clearInterval(poll);
			signal?.removeEventListener("abort", onAbort);
			deliver();
		};
		const onAbort = () => finish(() => reject(new DOMException("Wait cancelled; the child is unaffected.", "AbortError")));
		// Settle wakes instantly (no poll latency); queued messages are polled at WAIT_POLL_MS.
		// subscribe can fire synchronously when the child already settled: finish() guards the rest.
		unsubscribe = run.completion.subscribe((value) => finish(() => resolve(value)));
		if (done) return;
		poll = setInterval(() => {
			if (ctx.hasPendingMessages()) { finish(() => resolve(interrupted)); return; }
			// Terminal status without settle = a failure path that set status but never completed
			// (see the child-state save catch). Two consecutive polls ride out finishRun's
			// async persistence gap so a normal completion cannot false-positive.
			if (run.status !== "running" && !run.completion.settled) lostPolls += 1;
			else lostPolls = 0;
			if (lostPolls >= 2) finish(() => resolve(lost));
		}, WAIT_POLL_MS);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

	pi.registerTool({
		name: "delegate_ctl",
		renderCall: blockingCall((args) => args?.action === "wait" ? `Waiting for ${args.runId ?? (Array.isArray(args.runIds) && args.runIds.length ? args.runIds.join(", ") : "a child")}` : undefined),
		renderResult: resultRenderer("delegate_ctl"),
		label: "Delegate control",
		description:
			"See the delegation skill for the full procedure. models: every offering across all enabled providers, verbatim from the registry (provider/id, reasoning, context, $/M), plus live OpenRouter pricing, tiered rates, expirations and Artificial Analysis indices, your cached ratings, approved defaults and drift \u2014 call before the first delegate of a session. deals: read-only OpenRouter promotion and price/quality shortlist for frontier and light work; does not choose or approve a model. " +
			"rate: store quality ratings you researched, per exact offering (provider/id), so choices are grounded; stale after 14 days. approve: record a role's default model after the user agreed in conversation. " +
			"roles: list roles. status: one run or all \u2014 a nonblocking progress read: status, current tool, tool calls so far, elapsed, remaining time budget. result: current report without waiting. wait: join an existing runId; returns its final report, immediately if finished. If queued messages arrive while waiting it returns early with the child still running — answer them, then wait again to rejoin. If the child stops without reporting completion it returns an error report instead of blocking until the run budget. Cancelling wait only detaches; the child keeps running. An attached waiter receives completion instead of a separate wake-up. steer: queue a correction or resume a finished child in the background, keeping its context; returns immediately. Use wait to join the resumed work. Saved children are restored on parent reopen without running; steer revives them with their original configuration unless you pass model:, which moves that child to another offering from the next segment on \u2014 propose it in conversation first, including when the saved offering is exhausted or gone. Explicitly stopped children require restart:true and the user's request. cancel: stop the child and prevent automatic revival. " +
			"wait with runIds and mode any|all joins several runs of either backend at once; timeoutMs only ends that wait, never the runs. " +
			"Runs started with backend acp take the same runId actions: status and result read the session and its latest turn; wait joins it; steer sends the next turn (a running turn must finish or be cancelled first); cancel stops only a turn this run started; close releases the session \u2014 a created one is disposed, an opened one only disconnected, never archived or deleted. close is acp only and final. " +
			"When the parent exits, its acp runs are parked, not closed: their sessions are released and their records stay readable after a restart; steer reopens one (an opened run by its native ID, a created run by native resume, else RUN_NOT_RESUMABLE). " +
			"status or result with observe:true on an opened Amp run also reads its thread once (one amp threads export, never in the background) and returns only the messages after the last ones this run was shown, from any participant; a failed read is reported as unknown. Other runs fail ACTION_UNSUPPORTED. " +
			"An Amp run's thread cost (amp threads usage) is read once per settled turn, which its wait result or wake-up reports, and by status or result with a runId unless the cached cost is current (a closed run, or a created run with no turn since); unknown when it was never read, and a failed read keeps the last cost with when it was read.",
		parameters: Type.Object({
			action: StringEnum(["models", "deals", "rate", "approve", "roles", "status", "result", "wait", "steer", "cancel", "close"] as const),
			role: Type.Optional(Type.String({ description: "approve: role name" })),
			model: Type.Optional(Type.String({ description: "approve: provider/id[:thinking] the user agreed to. steer: run the next segment on this offering instead of the child's saved one; the user chooses it, you never substitute silently" })),
			runId: Type.Optional(Type.String()),
			runIds: Type.Optional(Type.Array(Type.String(), { description: "wait: join several runs at once, pi and acp alike, with mode" })),
			mode: Type.Optional(StringEnum(["any", "all"] as const, { description: "wait with runIds: any returns when the first run settles, all (default) when every one has" })),
			force: Type.Optional(Type.Boolean({ description: "close: cancel an active turn first instead of refusing" })),
			discardPersistentState: Type.Optional(Type.Boolean({ description: "close, created acp sessions only: do not keep the session resumable" })),
			observe: Type.Optional(Type.Boolean({ description: "status or result with runId, opened Amp runs only: also read the native thread once and return the messages since this run's last observation" })),
			restart: Type.Optional(Type.Boolean({ description: "steer only: restart an explicitly stopped child, only when the user requested it" })),
			timeoutMs: Type.Optional(Type.Number({ description: "steer: give the child this time budget instead of its saved one \u2014 re-armed at once on a running child, applied to the next segment of an inactive one. wait with runIds, or on an acp run: stop waiting after this many ms; the runs keep going" })),
			message: Type.Optional(Type.String({ description: "steer: the correction. models/deals: substring filter. approve: one-line reason the user agreed to" })),
			ratings: Type.Optional(
				Type.Array(
					Type.Object({
						model: Type.String({ description: "exact provider/id as listed by models; rate each offering you judged, separately" }),
						score: Type.Number({ description: "index score from the cited source" }),
						source: Type.String({ description: "where the score came from, with date" }),
						note: Type.Optional(Type.String()),
					}),
					{ description: "rate: ratings to store" },
				),
			),
		}),
		async execute(_id, p, signal, onUpdate, ctx) {
			if (p.action === "approve") {
				if (!p.role || !p.model) return { content: [{ type: "text", text: "approve requires role and model" }], isError: true, details: undefined };
				const { model, thinking } = resolveModel(p.model, ctx);
				if (!model) return { content: [{ type: "text", text: `model not found: ${p.model}` }], isError: true, details: undefined };
				const spec = `${modelKey(model)}${thinking ? `:${thinking}` : ""}`;
				saveDefault(p.role, { spec, reason: p.message, approvedAt: Date.now(), cost: model.cost ? { input: model.cost.input, output: model.cost.output } : undefined }, (ctx.modelRegistry as any).getAvailable());
				return { content: [{ type: "text", text: `${p.role} \u2192 ${spec} saved as default (${DEFAULTS_FILE.replace(homedir(), "~")}). Only call this after the user has agreed in conversation.` }], details: undefined };
			}
			if (p.action === "rate") {
				if (!p.ratings?.length) return { content: [{ type: "text", text: "rate requires ratings: [{model, score, source, note?}]" }], isError: true, details: undefined };
				const r = saveRatings(p.ratings);
				return { content: [{ type: "text", text: `stored ${p.ratings.length}; ${Object.keys(r.entries).length} rated in total. Run models to see them applied.` }], details: undefined };
			}
			if (p.action === "deals") {
				try {
					const details = await discoverDeals(ctx, p.message, signal);
					return { content: [{ type: "text", text: dealsReport(details) }], details };
				} catch (e) {
					return { content: [{ type: "text", text: String(e) }], details: undefined, isError: true };
				}
			}
			if (p.action === "models") {
				const all: any[] = (ctx.modelRegistry as any).getAvailable();
				const cur = ctx.model ? modelKey(ctx.model) : "";
				const f = (p.message ?? "").toLowerCase();
				const ratings = loadRatings();
				const live = await fetchOpenRouter();
				const liveAA = (m: any) => (m.provider === "openrouter" ? live.byId.get(m.id)?.benchmarks?.artificial_analysis : undefined);
				const EP_CAP = 12;
				let offers: any[];
				let scope: string;
				let endpointCap: number | undefined;
				if (f) {
					offers = all.filter((m) => modelKey(m).toLowerCase().includes(f));
					scope = `matching "${p.message}"`;
					const orIds = offers.filter((m) => m.provider === "openrouter" && live.byId.has(m.id)).map((m) => m.id);
					await Promise.all(orIds.slice(0, EP_CAP).map(fetchEndpoints));
					if (orIds.length > EP_CAP) {
						endpointCap = EP_CAP;
						scope += ` (endpoints fetched for the first ${EP_CAP} OpenRouter matches; narrow the filter for the rest)`;
					}
				} else {
					offers = all.filter((m) => ratings.entries[modelKey(m)] || liveAA(m)?.intelligence_index != null);
					scope = `rated; ${all.length - offers.length} unrated hidden (message=<substring>)`;
				}
				const score = (m: any) => {
					const mine = ratings.entries[modelKey(m)]?.score;
					if (mine != null) return [1, mine];
					const aa = liveAA(m)?.intelligence_index;
					return aa != null ? [0, aa] : [-1, 0];
				};
				offers.sort((a, b) => {
					const [ta, sa] = score(a);
					const [tb, sb] = score(b);
					return tb - ta || sb - sa || modelKey(a).localeCompare(modelKey(b));
				});
				const CAP = 120;
				const rows: ModelRow[] = offers.slice(0, CAP).map((m) => ({
					key: modelKey(m),
					current: modelKey(m) === cur,
					reasoning: Boolean(m.reasoning),
					contextWindow: m.contextWindow || undefined,
					cost: m.cost ? { input: m.cost.input ?? 0, output: m.cost.output ?? 0 } : undefined,
					live: liveFacts(m, live),
					rating: ratings.entries[modelKey(m)],
				}));
				const lines = rows.map((r, i) => {
					const ctxk = r.contextWindow ? `${Math.round(r.contextWindow / 1000)}k` : "?";
					return `${r.current ? "* " : "  "}${r.key}  ${r.reasoning ? "reasoning" : "no-reasoning"}  ctx=${ctxk}  ${costStr(offers[i])}${liveStr(r.live)}${ratingStr(ratings, r.key)}`;
				});
				const provs = new Map<string, number>();
				for (const m of all) provs.set(m.provider, (provs.get(m.provider) ?? 0) + 1);
				const providers = [...provs.entries()].sort((a, b) => b[1] - a[1]);
				const provLine = providers.map(([k, v]) => `${k} ${v}`).join(", ");
				const more = offers.length > CAP ? `\n  \u2026${offers.length - CAP} more` : "";
				// live on OpenRouter but absent from the registry: usable only after adding to models.json
				const registryOR = new Set(all.filter((m) => m.provider === "openrouter").map((m) => m.id));
				const liveOnly = [...live.byId.keys()].filter((id) => !registryOR.has(id) && (!f || id.toLowerCase().includes(f)));
				const liveOnlyStr = !liveOnly.length
					? ""
					: f
						? `\n\nON OPENROUTER BUT NOT IN YOUR REGISTRY (${liveOnly.length}) \u2014 add to ~/.pi/agent/models.json to make usable:\n${liveOnly.slice(0, 20).map((id) => `  ${id}  ${livePriceStr(live.byId.get(id))}${aaStr(aaOf(live.byId.get(id)))}`).join("\n")}${liveOnly.length > 20 ? "\n  \u2026" : ""}`
						: `\n\nON OPENROUTER BUT NOT IN YOUR REGISTRY: ${liveOnly.length} models; message=<substring> lists matches.`;
				const head = `CATALOG: ${all.length} offerings, ${provs.size} providers`;
				const body = offers.length
					? `\n\nOFFERINGS ${offers.length} ${scope}. * = current.\n${lines.join("\n")}${more}`
					: f
						? `\n\nno registry offering matches "${p.message}"`
						: "\n\nno rated offerings; message=<substring> to search, action=rate to add";
				const defaults = defaultsFacts(ctx);
				const details: ModelsDetails = {
					kind: "models", filter: p.message ?? "", total: all.length, providers,
					matched: offers.length, unratedHidden: f ? 0 : all.length - offers.length, endpointCap, rows,
					defaults, ratings: ratingsSummary(ratings),
					openrouter: { summary: liveSummary(live), error: Boolean(live.error) },
					liveOnly: { count: liveOnly.length, rows: f ? liveOnly.slice(0, 20).map((id) => ({ id, price: livePriceStr(live.byId.get(id)), aa: aaOf(live.byId.get(id)) })) : [] },
				};
				return { content: [{ type: "text", text: `${defaultsReport(defaults)}\nRATINGS: ${details.ratings}\nOPENROUTER: ${details.openrouter.summary}\n\n${head}${body}${liveOnlyStr}\n\nproviders: ${provLine}` }], details };
			}
			if (p.action === "roles") {
				const roles = [...loadRoles(ctx.cwd, ctx.isProjectTrusted()).values()].sort((a, b) => a.name.localeCompare(b.name));
				const approved = loadDefaults().approved;
				const rows = roles.map((r) => {
					const wanted = r.tools ?? BUILTIN_TOOLS;
					const tools = wanted.filter((t) => BUILTIN_TOOLS.includes(t));
					return {
						name: r.name,
						mode: `${r.context ?? "fork"}${r.thinking ? `:${r.thinking}` : ""}`,
						model: approved[r.name]?.spec ?? r.model ?? "needs approval",
						approved: Boolean(approved[r.name]),
						writes: tools.some((t) => WRITE_TOOLS.has(t)),
						tools,
						dropped: wanted.filter((t) => !BUILTIN_TOOLS.includes(t)),
						timeoutMs: r.timeoutMs,
						description: r.description,
						source: r.source,
					};
				});
				const lines = rows.map((r, i) => `${r.name}  [${r.mode}]  ${approved[roles[i].name] ? "default" : "no default"}: ${r.model}  ${r.description}  (${r.source})`);
				return { content: [{ type: "text", text: lines.join("\n") || "no roles found" }], details: { kind: "roles", rows } };
			}
			const owner = requireOwner();
			if (p.observe === true && (p.action !== "status" && p.action !== "result" || !p.runId)) {
				return failed(new DelegateError("INPUT_INVALID", "observe applies to status or result with one runId", "observe"));
			}
			if (p.action === "status" && !p.runId) {
				const owned = ownedRuns(owner);
				const external = acp.owned(owner.key);
				const lines = [...owned.map((r) => `${summary(r).split("\n")[0]}${r.status === "running" && r.lastTool ? `  last: ${r.lastTool}` : ""}`), ...external.map((v) => acpSummary(v).split("\n")[0])];
				return { content: [{ type: "text", text: lines.join("\n") || "no runs" }], details: { kind: "runs", rows: [...owned.map(recordedView), ...external] } };
			}
			if (p.action === "wait" && (p.runIds !== undefined || p.mode !== undefined)) {
				const ids = [...new Set(p.runIds ?? (p.runId ? [p.runId] : []))];
				try {
					if (!ids.length) throw new DelegateError("INPUT_INVALID", "wait with mode needs runIds", "runIds");
					return await waitRuns(owner, ids, p.mode ?? "all", ctx, signal, p.timeoutMs);
				} catch (error) { return failed(error); }
			}
			if (acp.find(p.runId, owner.key)) {
				const id = p.runId!;
				// The cost read, an observation's export and the model read are separate calls: run them together, then read the view they updated.
				const read = async (latest: () => Promise<AcpRunView>): Promise<AcpRunView> => {
					const [, observed, models] = await Promise.all([acp.refreshUsage(id), p.observe === true ? acp.observe(id) : undefined, acp.models(id)]);
					const v = observed ? { ...(await latest()), ...(observed.observation ? { observation: observed.observation } : {}) } : await latest();
					return models ? { ...v, models } : v;
				};
				try {
					switch (p.action) {
						case "status": {
							const v = await read(async () => (await acp.status([id]))[0]!);
							return { content: [{ type: "text", text: acpStatusText(v) }], details: v };
						}
						case "result": return acpRunResult(await read(() => acp.result(id)));
						case "wait": {
							const outcome = await acp.wait({ runIds: [id], mode: "all", ...(p.timeoutMs !== undefined ? { timeoutMs: p.timeoutMs } : {}) }, signal, () => ctx.hasPendingMessages());
							return await acpWaitResult(outcome, [id], p.timeoutMs);
						}
						case "steer": {
							const current = await acp.result(id);
							const request = unwrap(validateSteer({ backend: "acp", origin: current.session.origin, agent: current.session.agent }, p as Record<string, unknown>));
							const v = await acp.steer(id, request);
							return { content: [{ type: "text", text: `${id}: turn ${v.turns.at(-1)?.requestId} sent${request.model ? ` on model ${request.model}` : ""}. Completion will wake you; use wait to join.` }], details: v };
						}
						case "cancel": {
							const v = await acp.cancel(id, {});
							const turn = v.turns.at(-1);
							return { content: [{ type: "text", text: `${id}: cancel requested; turn ${turn?.requestId} is ${turn?.status}.\n${acpSummary(v)}` }], details: v };
						}
						case "close": {
							const v = await acp.close(id, { ...(p.force !== undefined ? { force: p.force } : {}), ...(p.discardPersistentState !== undefined ? { discardPersistentState: p.discardPersistentState } : {}) });
							return { content: [{ type: "text", text: `${id}: closed; ${v.session.origin === "opened" ? "disconnected, and the native session is unchanged" : "its session was disposed"}.\n${acpSummary(v)}` }], details: v };
						}
					}
				} catch (error) { return failed(error); }
			}
			const run = p.runId ? runs.get(p.runId) : undefined;
			if (!run || run.ownerKey !== owner.key) return failed(new DelegateError("RUN_NOT_FOUND", `unknown runId ${p.runId ?? "(none)"}; known: ${[...ownedRuns(owner).map((r) => r.id), ...acp.owned(owner.key).map((v) => v.id)].join(", ") || "none"}`, "runId"));
			// The pi backend's capability report decides what it cannot do; that fails, it never becomes another action.
			const capability = requireAction(PI_CAPABILITIES, p.observe === true ? "observe" : p.action as LifecycleAction);
			if (!capability.ok) return failed(new DelegateError(capability.error.code, capability.error.message));

			switch (p.action) {
				case "wait":
					return await waitForChild(run, ctx, signal);
				case "status":
					if (run.session && run.status === "running") harvest(run);
					return { content: [{ type: "text", text: `${summary(run)}${run.status === "running" ? `\nnow: ${run.activeTools.values().next().value?.name ?? (run.lastTool ? `thinking after ${run.lastTool}` : "thinking")} \u00b7 ${run.toolCalls.length} tool call${run.toolCalls.length === 1 ? "" : "s"} so far \u00b7 ${Math.round((run.timeoutMs - (Date.now() - run.startedAt)) / 60000)} min of its budget left` : ""}` }], details: recordedView(run) };
				case "result":
					return run.completion.settled ? finalResult(run) : { content: [{ type: "text", text: resultText(run) }], details: recordedView(run) };
				case "cancel":
					await cancelRun(run);
					return { content: [{ type: "text", text: `${run.id} stopped; automatic revival is disabled.` }], details: recordedView(run) };
				case "steer": {
					if (!p.message) throw new Error("steer requires message");
					const running = run.status === "running";
					let replacement: { model?: string; thinking?: string; contextWindow?: number; timeoutMs?: number } | undefined;
					if (p.model) {
						const { model, thinking } = resolveModel(p.model, ctx);
						if (!model) throw new Error(`model not found: ${p.model}`);
						// Keep the saved reasoning level unless this spec names one.
						replacement = { model: modelKey(model), thinking: thinking ?? run.thinking, contextWindow: model.contextWindow };
					}
					if (p.timeoutMs !== undefined) replacement = { ...replacement, timeoutMs: p.timeoutMs };
					const previous = `${run.model}${run.thinking ? `:${run.thinking}` : ""}`;
					await steer(run, p.message, p.restart, replacement);
					const moved = replacement?.model ? ` Model changed from ${previous} to ${run.model}${run.thinking ? `:${run.thinking}` : ""} for this and later segments; its earlier work keeps the model it ran on.` : "";
					const retimed = replacement?.timeoutMs !== undefined ? ` Budget now ${Math.round(run.timeoutMs / 60000)} min for this and later segments.` : "";
					return { content: [{ type: "text", text: `${run.id}: ${running ? "steer queued" : "resumed in the background"}.${moved}${retimed} Completion will wake you; use wait to join.` }], details: recordedView(run) };
				}
			}
			return { content: [{ type: "text", text: "unreachable" }], isError: true, details: undefined };
		},
	});

	pi.registerMessageRenderer("delegate", (message: any, { expanded }: any, theme: any) => {
		const v = message.details as RunView | undefined;
		if (!v || typeof v !== "object" || !("id" in v)) return undefined;
		const shown = asRunView(v) ?? v;
		return framed((width) => resultLines(shown, expanded, theme, width));
	});

	let panel: AgentsPanel | undefined;
	let navigationOpen = false;
	const childDrafts = new Map<string, string>();
	async function openChild(ctx: ExtensionContext, id: string) {
		if (navigationOpen) return;
		navigationOpen = true;
		try {
			await ctx.ui.custom<undefined>(
				(childTui, childTheme, kb, done) => new ChildView(id, liveSource, childTheme, childTui, kb, SettingsManager.create(ctx.cwd, AGENT_DIR), () => done(undefined), childDrafts.get(id) ?? "", (draft) => { childDrafts.set(id, draft); }),
				{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 } },
			);
		} catch (e) { ctx.ui.notify(`Cannot open child: ${String(e)}`, "error"); }
		finally { navigationOpen = false; }
	}
	async function openHistory(ctx: ExtensionContext) {
		if (navigationOpen || ctx.mode !== "tui") return;
		const finished = liveSource.all().filter((r) => r.settled);
		if (!finished.length) { ctx.ui.notify("No finished agents.", "info"); return; }
		navigationOpen = true;
		let id: string | undefined;
		try {
			id = await ctx.ui.custom<string | undefined>(
				(tui, theme, _kb, done) => new AgentHistory(finished, theme, tui, done),
				{ overlay: true, overlayOptions: { width: "90%", maxHeight: "100%", anchor: "center", margin: 1 } },
			);
		} catch (e) { ctx.ui.notify(`Cannot open agent history: ${String(e)}`, "error"); }
		finally { navigationOpen = false; }
		if (id) await openChild(ctx, id);
	}
	pi.on("session_start", async (_ev, ctx) => {
		try { await attach(ctx); }
		catch (error) { attachError = String(error); ctx.ui.notify(attachError, "error"); return; }
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget("delegate-agents", (tui, theme) => {
			panel = new AgentsPanel(liveSource, theme, tui, (id) => openChild(ctx, id));
			return panel;
		});
	});
	pi.registerEntryRenderer<DealsDetails>("pi-delegate.deals", (entry, opts, theme) =>
		framed((width) => resultView("OpenRouter", "deals", "", { content: [], details: entry.data }, opts, theme, width)));
	pi.registerCommand("deals", {
		description: "Find OpenRouter promotions and frontier/light value without calling a model (/deals [model substring])",
		handler: async (args, ctx) => {
			try {
				const details = await discoverDeals(ctx, args.trim());
				// Custom entries render in chat but are excluded from the model context.
				pi.appendEntry("pi-delegate.deals", details);
			} catch (e) { ctx.ui.notify(String(e), "error"); }
		},
	});
	pi.registerCommand("agents", {
		description: "Open finished delegate history without restarting children",
		handler: async (_args, ctx) => { await openHistory(ctx); },
	});
	// Ctrl+J is also Pi's default secondary newline (tui.input.newLine), so Pi reports the override
	// at startup until the user drops ctrl+j from that action in keybindings.json (see README).
	pi.registerShortcut("ctrl+j", {
		description: "Focus active delegates, or open finished history when idle",
		handler: async (ctx) => {
			if (navigationOpen) return;
			if (liveSource.all().some((r) => !r.settled)) panel?.focus();
			else await openHistory(ctx);
		},
	});

	pi.on("session_shutdown", async (event) => {
		panel?.dispose();
		panel = undefined;
		const previous = owner;
		owner = undefined;
		if (!previous || previous.binding?.pi !== pi) return;
		previous.binding = undefined;
		// A reload replaces only the binding. Actual exit/session replacement settles and parks children,
		// and releases this parent's ACP sessions before the Coordinator shuts down.
		if (event.reason !== "reload") {
			await closeOwner(previous);
			await acp.closeOwner(previous.key);
			// The Coordinator is process-wide: it stays while another parent in this process may hold runs on it.
			if (!state.owners.size) await shutdownAcpCoordinator();
		}
	});
}
