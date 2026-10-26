import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type InlineExtension,
	type LoadExtensionsResult,
	type RegisteredTool,
	buildSessionContext,
	convertToLlm,
	DefaultResourceLoader,
	loadProjectContextFiles,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { modelKey, parseModelSpec, matchesSpec } from "./model-ref.ts";
import { allModels, availableModels, findModel, scopedModels } from "./registry.ts";
import { clipText, errorMessage, textOf } from "./util/text.ts";
import { ageDays, formatDuration } from "./util/format.ts";
import { tildify } from "./util/path.ts";
import { readLegacySection, readSettings, writeSettings } from "./settings-file.ts";
import type { LiveSource } from "./inspector.js";
import { budgetText, clock, firstDeliverableAt, runHealth } from "./health.js";
import { type AAIndices, acpRowView, asRunView, boardLine, empty, framed, type LiveFacts, type ModelRow, type ModelsDetails, onBoard, resultLines, resultView, type RunView } from "./render.js";
import { type AcpRunView, firstDeliverableError, type LifecycleAction, type PiStartInput, OVEN_CAPABILITIES, PI_CAPABILITIES, requireAction, validateStartInput, validateSteer } from "./backend.js";
import { ACP_JOIN_LOST, AcpBackend, acpModelsText, acpResultText, acpStatusText, acpSummary, DelegateError, sessionLabel, unwrap } from "./acp-backend.js";
import { type Join, type JoinOutcome, joinRuns, waitCancelled } from "./wait.ts";
import { ProcessBackend, type ProcessRunView } from "./process-backend.js";
import { processText, processLines } from "./render.js";
import { shutdownAcpCoordinator } from "./acp/instance.js";
import { DELEGATION_TOOLS, droppedTools, EVERY_TOOL, loadRoles, roleSourcesText, toolAllowlist, WRITE_TOOLS } from "./roles.js";
import { tuiTemplate } from "./tui-template.js";
import { installTodo } from "./todo-ext.js";
import type { DealsDetails } from "./deals.js";
import { resolveChildTrust, type ChildTrust } from "./project-trust.js";
import { processOwner } from "./storage.js";
import { isPiStringsWorkerProcess } from "./util/process.ts";
import { installMom } from "./mom/index.js";
import { activityFor } from "./ui/activity.js";
import { installRecap } from "./recap.ts";
import { DEFAULT_DELEGATE_SETTINGS, pickModel, readDelegateSettings, saveDelegateSettings } from "./delegate-settings.ts";
import { DEFAULT_TODO_SETTINGS, readTodoSettings, saveTodoSettings } from "./todo-settings.ts";
import { DEFAULT_RECAP_SETTINGS, formatRecapThreshold, readRecapSettings, saveRecapSettings } from "./recap-settings.ts";
import type { SettingsRow } from "./ui/settings-panel.ts";
import { FULLSCREEN } from "./ui/overlay.ts";
import { AGENT_DIR, SETTINGS_PATH } from "./agent-dir.ts";
import {
	acknowledge, activeWriter, activityOf, admit, progressAt, allowlist, finishedNotice, PI_BUILTIN_TOOLS, notify, PiBackend, type PiCall, type PiRunSpec, cancelRun, cancelText, capacityError, changed, CHILD_SETTLED_PROMPT, childOwner, closeOwner, closingChildren, DEFAULT_TIMEOUT_MS, departed, finalResult, findDeparted, FORK_BRIDGE, harvest, inFlight, listeners, maxDepth, noticeKey, ownedRuns, type Owner, ownerPath, pointerDir, publish, recordedView, redeliver, restoreRun, resultText, type Run, runRecordPaths, runs, saveRun, state, summary, TRUST_UNKNOWN, view, type WaitRow,
} from "./pi-backend.ts";

export { AGENT_DIR };
export { CHILD_SETTLED_PROMPT, DELEGATE_MILESTONE_EVENT, type DelegateMilestone, FORK_BRIDGE, TRUST_UNKNOWN } from "./pi-backend.ts";
const STALE_DAYS = 30;
const RATINGS_STALE_DAYS = 14;
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_TTL_MS = 10 * 60 * 1000;
const OPENROUTER_TIMEOUT_MS = 8000;
/** The shipped depth limit. The root parent is depth 0 and its children depth 1; `maxDepth` in the settings replaces it. */
export const MAX_DELEGATION_DEPTH = 3;
/** The root session's delegation mode now (opportunistic, orchestrator, off). Children never get a mode. */
const mode = () => readDelegateSettings(SETTINGS_PATH).mode;
/**
 * The orchestrator's standing instruction, part of the root's `delegate` tool description while the mode
 * is on: a description is in every turn's loadout, including turns a completion starts, which a
 * before_agent_start prompt section is not; and it changes only when the mode does.
 */
const ORCHESTRATOR_PROMPT = ` Delegation mode: orchestrator (the user's setting). You coordinate; children execute. Hand every task the user gives you to a child with delegate, in the background, and stay free to keep talking with the user while children run. Do not block on delegate_ctl wait unless the user asks for a result now or your reply cannot be written without it. With nothing else to do, end your turn instead: completions and watchdog alerts start your next one, and a wait holds messages from peer sessions (intercom) and other extensions until it returns. Read the plan and the sources that define the mechanism before the first brief, and report each child's result when its completion arrives. Report to the user in at most 5 lines: what is moving, what is stuck, and the one thing you need from them. Keep briefs small: one deliverable per child, with firstDeliverableMin set on every writer (10-15 for a one-commit unit) and FIRST DELIVERABLE, STOP WHEN and KNOWN FACTS lines; for implementation ask for one commit-sized unit, then the next. Point each child at the plan clauses and the exact file and function it depends on; never tell it not to read them, and a summary does not replace that source. Watch with delegate_ctl status (one verdict per run), not transcripts. A timed check-in is fine: one fixed cron schedule per session, updated rather than recreated, reading live runs from delegate_ctl status instead of naming run ids. Act on exceptions: slow or silent, steer once (interrupt: true in a long think); looping or browsing, interrupt with the missing fact; no-artifact, interrupt and demand the first deliverable; still stuck after one interrupt, cancel and relaunch smaller. Extend a child's budget only on evidence (moving verdict, or it asked with EXTEND:), by delegate_ctl steer timeoutMs=<milliseconds from now, e.g. 600000 for 10 min>; never extend a silent, looping or no-artifact run. You cannot edit or write files yourself in this mode: those calls are refused. This overrides the delegate tool's own advice on when to delegate.`;
const SKILL_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "delegation", "SKILL.md");
// Every child gets this ahead of its role, including roles that bring their own STATUS contract and skip the footer.
const PLAN_CONFLICT_RULE = `## Plan conflicts come first
Before you build, check your brief against the plan or design doc it names, or the repo's plan for this work. If the brief, a steer, or what you find contradicts that plan, do not build the contradicting part. Stop with STATUS: blocked and report the brief's line, the plan's line (file:line), and the resolution you would propose. This outranks any instruction to keep going or never stop.

`;

const contractFooter = (delegates: boolean, atDepthCap = false, cap = MAX_DELEGATION_DEPTH) => `

## Delegated worker contract
You are working inside another agent's task. You do the work yourself with the tools listed above${delegates ? "" : `: you have no delegation tools and cannot start another agent, so a delegation call is not available to you${atDepthCap ? `. You run at the delegation depth limit, ${cap}` : ""}`}. That is your fixed toolset, not a broken setup — never ask anyone to reload, restart, or fix an extension, and never stop and wait for a reply. Whatever the conversation above shows another agent doing, your job is the brief below.

You are not alone in this repository: preserve unrelated and concurrent edits, do not revert work you do not own, stay within the ownership stated in the brief. Do not commit or push unless the brief says so. Inspect before editing; verify before claiming. End your final message with:
STATUS: complete | partial | blocked
CHANGES: <files changed, from the actual diff; or none>
VERIFIED: <commands or flows run and their concrete results>
GAPS: <unfinished work or blockers, or none>`;

/** Only for a child whose tools allow `delegate`. Its limits are stated, not implied. */
const childrenFooter = (depth: number, cap = MAX_DELEGATION_DEPTH) => `

## Your own children
Your role lets you start children of your own with \`delegate\` and control them with \`delegate_ctl\`. Read ${SKILL_PATH} before your first delegate call. Start a child only for work your brief assigns to others, such as an independent check or a separate piece of work; do everything else yourself. You run at delegation depth ${depth}. A delegate call that would start a child deeper than ${cap} fails, so a child at depth ${cap} gets neither \`delegate\` nor \`delegate_ctl\`. One writer per working directory still holds: a child that edits files needs a directory no other running writer uses, yours included. Join every child you start with delegate_ctl wait before your final report. A child that settles after your report wakes you again.`;

// Stripping the delegating agent's tool calls is not enough on its own: its prose still reads as
// "I am supervising a worker", and a child that adopts that voice inspects the job instead of doing it.
const FORK_FOOTER = `

## The conversation before your assignment
It belongs to the agent that delegated to you \u2014 its plans, its investigation, its supervision of workers. Read it as background only. You are not that agent and you are not observing anyone: you are the worker it hired, and the assignment that follows is yours to carry out with your own tools.`;

// --- A child's extensions. A child loads what Pi loads for a session in its folder, with its own trust
// deciding the project's part, so it has the extensions its parent has, Pi's built-ins included. Its role's
// `tools` line then decides which of their tools it gets.

/** The child's own pi-delegate, as Pi names an inline extension. */
const NESTED_PATH = "<inline:pi-delegate>";

/**
 * An extension's tool table that keeps only the tools a child may have. Pi registers a tool by setting it
 * here, when the extension loads and whenever it registers one later, as Pi's MCP extension does when a
 * server connects. A tool the child may not have is never in its registry, so neither the model nor a
 * codemode script can call it. Every name is recorded as offered.
 */
class GatedTools extends Map<string, RegisteredTool> {
	constructor(private readonly allows: (name: string) => boolean, private readonly offered: Set<string>) { super(); }
	override set(name: string, tool: RegisteredTool): this {
		this.offered.add(name);
		return this.allows(name) ? super.set(name, tool) : this;
	}
}

/** Path follows the root parent's session only. An extension that brings it is known by its tool or command (`mom` is the former name, still met in older installs). */
const bringsMom = (extension: LoadExtensionsResult["extensions"][number]) => ["path", "mom"].some(name => extension.tools.has(name) || extension.commands.has(name));

/**
 * The extensions a child's session runs. An installed pi-delegate would add the root parent's
 * `delegate`, `delegate_ctl` and `todo`, so it is left out. The child gets a separate todo extension
 * bound to its own session. Path is the root parent's alone: any extension that brings it (an installed
 * pi-delegate, or pi-tether) is left out too, so a child never follows, maps or advises on its own session.
 * Every other extension keeps only the tools the child may have.
 */
function gateExtensions(run: Run, base: LoadExtensionsResult): LoadExtensionsResult {
	const { allows } = allowlist(run);
	const offered = run.offered = new Set(PI_BUILTIN_TOOLS);
	const copies = new Set(base.extensions
		.filter((extension) => extension.path !== NESTED_PATH && ([...extension.tools.keys()].some((name) => DELEGATION_TOOLS.includes(name)) || bringsMom(extension)))
		.map((extension) => extension.path));
	const extensions = base.extensions.filter((extension) => !copies.has(extension.path));
	for (const extension of extensions) {
		const gated = new GatedTools(allows, offered);
		for (const [name, tool] of extension.tools) gated.set(name, tool);
		extension.tools = gated;
		// A child shares the parent's process; startup work (browsers, daemons, credential switching)
		// already ran for the parent. Only the nested pi-delegate needs session_start, to attach its children.
		if (extension.path !== NESTED_PATH) extension.handlers.delete("session_start");
	}
	// Pi reports a copy's tools as conflicting with the nested instance's; with the copy left out, they do not.
	const errors = base.errors.filter((error) => !copies.has(error.path) && ![...copies].some((path) => error.error.includes(path)));
	return { ...base, extensions, errors };
}

/**
 * The trust a child gets for its working directory, decided by its parent at delegate time and kept
 * on the run. Where the parent works, it is the parent's own decision. Elsewhere, see resolveChildTrust:
 * Pi's saved decision for that folder, else the person's answer when the parent is the root interactive
 * session, else the parent's own decision.
 */
function childTrust(cwd: string, ctx: ExtensionContext, depth: number, session: Map<string, boolean>, signal?: AbortSignal): Promise<ChildTrust> {
	if (cwd === realpathSync(ctx.cwd)) return Promise.resolve({ trusted: ctx.isProjectTrusted(), source: "parent" });
	// A nested child has no person to ask; only the root session's UI can prompt.
	const select = depth === 0 && ctx.hasUI ? (title: string, options: string[], opts: { signal?: AbortSignal }) => ctx.ui.select(title, options, opts) : undefined;
	return resolveChildTrust({ cwd, parentTrusted: ctx.isProjectTrusted(), agentDir: AGENT_DIR, select, session, signal });
}

const sortedRoles = (ctx: ExtensionContext) => [...loadRoles(ctx.cwd, ctx.isProjectTrusted(), AGENT_DIR).values()].sort((a, b) => a.name.localeCompare(b.name));

function resolveModel(spec: string | undefined, ctx: ExtensionContext) {
	if (!spec) return { model: ctx.model, thinking: undefined as string | undefined };
	const p = parseModelSpec(spec);
	// A named provider is a choice between offerings of the same weights, not a search key:
	// resolving it to another provider would silently change cost, limits, and serving.
	// A bare id is any provider's offering of it: prefer one the session has credentials for.
	const model = p.provider ? findModel(ctx, p.provider, p.id) : availableModels(ctx).find((m) => matchesSpec(m, p)) ?? allModels(ctx).find((m) => matchesSpec(m, p));
	if (!model) throw new Error(`model not found: ${spec}`);
	return { model, thinking: p.thinking };
}

/**
 * A role's own models. One entry is a pin: it resolves as an explicit model does, whatever Pi's scope.
 * Several are a preference order: the first with credentials (and, with `scoped` picking, in Pi's
 * scoped models) wins, and the run records which and why earlier entries were skipped. None usable is
 * an error naming each reason: a role that lists models never silently falls back to the parent's.
 * No list at all runs on the parent's model.
 */
function resolveRoleModels(models: readonly string[] | undefined, ctx: ExtensionContext): { model: any; thinking?: string; pick?: string } {
	if (!models?.length) return { model: ctx.model };
	if (models.length === 1) return resolveModel(models[0], ctx);
	const picked = pickModel(models, availableModels(ctx), scopedModels(ctx), readDelegateSettings(SETTINGS_PATH).modelPicking);
	if (!("entry" in picked)) throw new Error(`none of the role's models can be used: ${picked.skipped.join("; ")}`);
	const pick = picked.skipped.length ? `${picked.entry} (role list; skipped ${picked.skipped.join("; ")})` : `${picked.entry} (first of the role list)`;
	return { model: picked.model, thinking: picked.thinking, pick };
}

const userText = (message: any) => typeof message.content === "string" || Array.isArray(message.content) ? textOf(message.content, "") : undefined;
/**
 * A delegation call, direct or from a codemode script. A script calls a tool as `tools.<name>(` or
 * `tools["<name>"]`, so those shapes mark it as delegating; a script that only mentions the word, such
 * as searchTools("delegate"), is kept. A name built at run time is missed.
 */
const DELEGATION_IN_SCRIPT = /\btools\s*(?:\.\s*delegate(?:_ctl)?\s*\(|\[\s*(["'`])delegate(?:_ctl)?\1\s*\])/;
export function isDelegationCall(block: any): boolean {
	if (block.name === "delegate" || block.name === "delegate_ctl") return true;
	return block.name === "codemode" && typeof block.arguments?.code === "string" && DELEGATION_IN_SCRIPT.test(block.arguments.code);
}
/**
 * A fork inherits the parent's work, not this package's orchestration of it. Delegation tool
 * calls, their results, and completion notices taught children to re-delegate a brief they were
 * handed — and children have no delegation tools, so that attempt only failed confusingly.
 *
 * Removing a notice, a revival prompt or a delegation result can leave two assistant messages in a
 * row. Pi's providers pass them on as they are, and some APIs refuse that (Bedrock's Converse needs
 * user and assistant turns to alternate), so a neutral user turn takes the removed turns' place.
 * Removing an assistant turn whose only content was delegation can likewise leave two user turns in a
 * row; those are merged into one user turn, in order. Merging adds nothing, where a bridging assistant
 * turn would put words in the model's mouth that it could take as its own earlier answer.
 */
export function stripDelegation(messages: any[]): any[] {
	const removed = new Set<string>();
	const out: any[] = [];
	let strippedSince = false;
	// Only a removed assistant turn can make two user turns adjacent that were not adjacent before.
	let strippedAssistant = false;
	const push = (message: any) => {
		if (strippedSince && message?.role === "assistant" && out.at(-1)?.role === "assistant") {
			out.push({ role: "user", content: [{ type: "text", text: FORK_BRIDGE }], timestamp: message.timestamp ?? out.at(-1).timestamp });
		}
		const merge = strippedAssistant && sentAsUser(message) && sentAsUser(out.at(-1));
		strippedSince = strippedAssistant = false;
		if (merge) out.push(mergeUserTurns(out.pop(), message));
		else out.push(message);
	};
	for (const message of messages) {
		if (message?.role === "custom" && message.customType === "delegate") { strippedSince = true; continue; }
		// The revival prompt points at a child report that is stripped above.
		if (message?.role === "user" && userText(message) === CHILD_SETTLED_PROMPT) { strippedSince = true; continue; }
		if (message?.role === "assistant" && Array.isArray(message.content)) {
			const content = message.content.filter((block: any) => {
				if (block?.type !== "toolCall" || !isDelegationCall(block)) return true;
				removed.add(block.id);
				return false;
			});
			if (content.length !== message.content.length) {
				if (content.length) push({ ...message, content });
				else strippedSince = strippedAssistant = true;
				continue;
			}
		}
		if (message?.role === "toolResult" && removed.has(message.toolCallId)) { strippedSince = true; continue; }
		push(message);
	}
	return out;
}
/** Messages convertToLlm sends as a user turn. */
const sentAsUser = (message: any) => ["user", "custom", "branchSummary", "compactionSummary"].includes(message?.role) || (message?.role === "bashExecution" && !message.excludeFromContext);
function mergeUserTurns(first: any, second: any) {
	const blocks = (message: any) => { const [user] = convertToLlm([message]) as any[]; return typeof user.content === "string" ? [{ type: "text", text: user.content }] : user.content; };
	return { role: "user", content: [...blocks(first), ...blocks(second)], timestamp: first.timestamp ?? second.timestamp };
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
	// The `defaults` section of the settings file, or the file this used to live in.
	const d = readSettings(SETTINGS_PATH).defaults ?? readLegacySection("defaults", AGENT_DIR);
	return { approved: d?.approved ?? {}, catalogAtApproval: d?.catalogAtApproval ?? [] };
}

/** Written by delegate_ctl approve after the user agreed in conversation, or by the user's editor. Snapshot is the full catalog. */
async function saveDefault(role: string, entry: ApprovedModel, available: any[]) {
	await writeSettings({ defaults: { approved: { [role]: entry }, catalogAtApproval: available.map(modelKey).sort() } }, SETTINGS_PATH);
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
	const d = readSettings(SETTINGS_PATH).ratings ?? readLegacySection("ratings", AGENT_DIR);
	return { updatedAt: d?.updatedAt ?? 0, entries: d?.entries ?? {} };
}

async function saveRatings(items: { model: string; score: number; source: string; note?: string }[]): Promise<Ratings> {
	const entries = Object.fromEntries(items.map(it => [it.model, { score: it.score, source: it.source, ...(it.note === undefined ? {} : { note: it.note }) }]));
	const written = await writeSettings({ ratings: { updatedAt: Date.now(), entries } }, SETTINGS_PATH);
	return { updatedAt: written.ratings?.updatedAt ?? Date.now(), entries: written.ratings?.entries ?? {} };
}

/** Live OpenRouter catalog: per-token pricing, tiered overrides, expiration, Artificial Analysis indices. Public endpoint, no key. */
interface LiveOR {
	at: number;
	byId: Map<string, any>;
	error?: string;
}
let liveOR: LiveOR | undefined;

/**
 * One OpenRouter read. The request itself is aborted at the timeout (a race that only stops waiting, as withTimeout
 * does, would leave the fetch running).
 */
async function openRouterJson(url: string): Promise<any> {
	const res = await fetch(url, { signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

async function fetchOpenRouter(force = false): Promise<LiveOR> {
	if (!force && liveOR && !liveOR.error && Date.now() - liveOR.at < OPENROUTER_TTL_MS) return liveOR;
	try {
		const data = (await openRouterJson(OPENROUTER_MODELS_URL))?.data;
		if (!Array.isArray(data)) throw new Error("unexpected payload");
		liveOR = { at: Date.now(), byId: new Map(data.map((m: any) => [m.id, m])) };
	} catch (e: any) {
		liveOR = { at: Date.now(), byId: liveOR?.byId ?? new Map(), error: errorMessage(e) };
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

async function fetchEndpoints(id: string, force = false): Promise<LiveEndpoints> {
	const c = liveEP.get(id);
	if (!force && c && !c.error && Date.now() - c.at < OPENROUTER_TTL_MS) return c;
	let r: LiveEndpoints;
	try {
		const eps = (await openRouterJson(`https://openrouter.ai/api/v1/models/${id}/endpoints`))?.data?.endpoints;
		if (!Array.isArray(eps)) throw new Error("unexpected payload");
		r = { at: Date.now(), endpoints: eps };
	} catch (e: any) {
		r = { at: Date.now(), endpoints: c?.endpoints ?? [], error: errorMessage(e) };
	}
	liveEP.set(id, r);
	return r;
}

async function discoverDeals(ctx: ExtensionContext, filter = "", signal?: AbortSignal, force = false): Promise<DealsDetails> {
	const { dealEligible, selectDeals } = await import("./deals.js");
	const live = await fetchOpenRouter(force);
	if (live.error) throw new Error(`OpenRouter deal discovery unavailable: ${live.error}. Cached data was not used.`);
	const term = filter.toLowerCase();
	const universe = [...live.byId.values()];
	const catalog = universe.filter((m) => dealEligible(m) && (!term || m.id.toLowerCase().includes(term)));
	// OpenRouter has no catalog-wide endpoint-discount listing. Scan all eligible model endpoints
	// in bounded batches; successful responses share the models view's ten-minute cache.
	const endpoints = new Map<string, LiveEndpoints>();
	for (let i = 0; i < catalog.length; i += 8) {
		if (signal?.aborted) throw new DOMException("Deal discovery cancelled", "AbortError");
		const batch = await Promise.all(catalog.slice(i, i + 8).map((m) => fetchEndpoints(m.id, force)));
		batch.forEach((result, j) => endpoints.set(catalog[i + j].id, result));
	}
	const configured = new Set<string>(availableModels(ctx).filter((m) => m.provider === "openrouter").map((m: any) => m.id));
	return selectDeals(catalog, endpoints, configured, new Date(), term ? universe : catalog);
}

async function dealsReport(d: DealsDetails): Promise<string> {
	const { formatPercent } = await import("./deals.js");
	const row = (r: DealsDetails["discounts"][number]) => `  ${r.id}  ${r.provider ?? "model rate"}  ${r.price}  ${r.discount !== undefined ? formatPercent(r.discount) : r.saving !== undefined ? `${formatPercent(r.saving)} vs peak · ${r.reason}${r.currentPrice ? ` (current ${r.currentPrice})` : ""}` : ""}  AA intel ${r.quality ?? "—"} coding ${r.coding ?? "—"}  ${r.configured ? "configured" : "not configured"}`;
	const section = (title: string, rows: DealsDetails["discounts"], cap: number) => `${title} (${rows.length} offers)\n${rows.length ? rows.slice(0, cap).map(row).join("\n") : "  none with available evidence"}${rows.length > cap ? `\n  … ${rows.length - cap} more; /deals opens the sortable sheet` : ""}`;
	const partial = d.endpointFailures ? `; ${d.endpointFailures} endpoint lookups failed (promotions incomplete)` : "";
	return `OPENROUTER DEALS evaluated ${d.evaluatedAt} (catalog and endpoint responses may be cached up to 10m) — ${d.eligible} eligible tool-capable text models; ${d.endpointsChecked} model endpoint catalogs checked${partial}.\nBasket for sorting value: 1M prompt + 250k completion tokens; free, batch and per-request-priced models excluded. AA is Artificial Analysis, a quality proxy. Endpoint discount percentages are already included in provider prices, not a comparison to the model-wide price. Peak/off-peak state is at evaluation time; window times are Pacific (PDT/PST). Off-peak $/M is the cheaper window's rate, not necessarily the active rate.\n\n${section("ENDPOINT DISCOUNTS", d.discounts, 4)}\n\n${section("OFF-PEAK RATES", d.offPeak, 3)}\n\n${section(`FRONTIER VALUE (AA intelligence top 15%, ≥128k context; floor ${d.frontierFloor ?? "unavailable"})`, d.frontier, 2)}\n\n${section(`LIGHT VALUE (AA intelligence top half below frontier, ≥32k context; floor ${d.lightFloor ?? "unavailable"})`, d.light, 2)}\n\nNot configured = add the exact model id to models.json before choosing it. No model was selected or approved.`;
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
	const age = formatDuration(Date.now() - live.at);
	const aaCount = [...live.byId.values()].filter((l) => l.benchmarks?.artificial_analysis).length;
	if (live.error) return `fetch failed (${live.error})${live.byId.size ? `, data from ${age} ago` : ""}`;
	return `${live.byId.size} live, ${aaCount} with AA, fetched ${age} ago (${new Date().toISOString().slice(11, 16)}Z)`;
}

function ratingStr(r: Ratings, name: string): string {
	const e = r.entries[name];
	if (!e) return "";
	const note = e.note ? ` ${clipText(e.note, 61)}` : "";
	return `  rated ${e.score} (${clipText(e.source, 41)})${note}`;
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

/** Approved defaults + drift against the live catalog. */
function defaultsFacts(ctx: ExtensionContext): ModelsDetails["defaults"] {
	const d = loadDefaults();
	const avail = availableModels(ctx);
	const byKey = new Map(avail.map((m) => [modelKey(m), m]));
	const approved: ModelsDetails["defaults"]["approved"] = [];
	const drift: string[] = [];
	for (const [role, a] of Object.entries(d.approved)) {
		const { provider, id } = parseModelSpec(a.spec);
		const base = provider ? modelKey({ provider, id }) : id;
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

/** A child whose tools allow either delegation tool runs its own pi-delegate. Revival reads that from the run. */
const delegating = (run: Run) => DELEGATION_TOOLS.some(allowlist(run).allows);
/** The delegation tools inside a delegating child's own session, as an inline extension of that session. */
const nestedExtension = (run: Run) => ({ name: "pi-delegate", factory: (pi: ExtensionAPI) => { installDelegate(pi, run); } });
/** Each SDK child gets its own session-backed todo; automatic reminders remain root-only. */
const childTodoExtension = (): InlineExtension => ({
	name: "pi-delegate-todo",
	factory: (pi: ExtensionAPI) => installTodo(pi, { remindersEnabled: () => false }),
});
/**
 * What a child's session takes from the session that started it. Pi caches each extension module's factory
 * for the folder it last loaded extensions for (the root session's), so a child whose loader loads from that
 * folder re-binds the factories the root already imported instead of importing them again. MCP tools are
 * the parent's: the child gets proxies that call the parent's live tool by name at call time.
 */
interface ParentLink {
	/** The folder the root session loaded its extensions for. */
	extensionCwd: string;
	/** The parent's MCP tools when the child's session is built. */
	mcpTools: () => ReturnType<ExtensionAPI["getAllTools"]>;
	/** The tools the parent's session can call now (its tool context's live `tools`). */
	callable: () => readonly any[] | undefined;
}
const parentLinks = new WeakMap<Run, ParentLink>();
/** A parent tool a child reaches through a proxy: an MCP server's tool, as Pi's MCP extension names it. */
const isMcpTool = (tool: { name: string; exposure?: string }) => tool.name.startsWith("mcp__") && tool.exposure !== "hidden";

/**
 * The parent's MCP tools in a child: each forwards to the parent's tool of the same name, looked up when
 * called, so a server that reconnected in the parent is reached through its new connection. The child
 * starts no MCP server. Proxies are direct tools, so the child needs no codemode or tool search for them.
 */
function mcpProxyExtension(run: Run): InlineExtension {
	return { name: "mcp-proxy", factory: (pi: ExtensionAPI) => {
		const link = parentLinks.get(run);
		if (!link) return;
		for (const info of link.mcpTools()) {
			pi.registerTool({
				name: info.name, label: info.name, description: info.description, parameters: info.parameters as any,
				...(info.promptGuidelines ? { promptGuidelines: info.promptGuidelines } : {}),
				...(info.annotations ? { annotations: info.annotations } : {}),
				async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any) {
					let tools: readonly any[] | undefined;
					try { tools = link.callable(); } catch { tools = undefined; }
					const tool = tools?.find((candidate) => candidate.name === info.name);
					if (!tool) throw new Error(`${info.name}: the parent session no longer offers this MCP tool.`);
					return tool.execute(toolCallId, params, signal, onUpdate);
				},
			} as any);
		}
	} };
}

/** A child's private todo, its own pi-delegate when it delegates, and its parent's MCP tools. */
function childExtensions(run: Run): InlineExtension[] {
	return [childTodoExtension(), ...(delegating(run) ? [nestedExtension(run)] : []), mcpProxyExtension(run)];
}
/**
 * The resource loader of a child's session. It loads from the folder the root session loaded its extensions
 * for, so Pi's factory cache hands it the factories the root already imported, each bound to the child's own
 * extension API; the child's trust in `settingsManager` still decides the project's part. Context files are
 * the child's folder's. Skills, prompt templates and themes stay out. A reopened session gets the context
 * files saved on the run.
 */
function childLoader(run: Run, settingsManager: SettingsManager, reopen: boolean): DefaultResourceLoader {
	const cwd = parentLinks.get(run)?.extensionCwd ?? run.cwd;
	return new DefaultResourceLoader({
		cwd, agentDir: AGENT_DIR, settingsManager, systemPrompt: run.systemPrompt,
		noSkills: true, noPromptTemplates: true, noThemes: true,
		extensionFactories: childExtensions(run),
		extensionsOverride: (base) => gateExtensions(run, base),
		...(reopen
			? { noContextFiles: true, agentsFilesOverride: () => ({ agentsFiles: run.contextFiles }), appendSystemPromptOverride: () => run.appendSystemPrompt }
			: { agentsFilesOverride: () => ({ agentsFiles: loadProjectContextFiles({ cwd: run.cwd, agentDir: AGENT_DIR }) }) }),
	});
}
export default function (pi: ExtensionAPI) {
	const work = installDelegate(pi), anchor = installMom(pi);
	installRecap(pi, activityFor(pi), { work, anchor });
}

/**
 * The delegation tools for one session. At the root, that is the parent's session. With `nesting`,
 * it is a delegating child's own session (its tools allow `delegate`): the same machinery, one
 * level down, with its children's completions delivered to that child.
 */
function installDelegate(pi: ExtensionAPI, nesting?: Run) {
	const activity = nesting ? undefined : activityFor(pi);
	// The session this instance serves runs at this depth; the children it starts run one deeper.
	const depth = nesting?.depth ?? 0;
	// ACP Pi workers (pi-acp) are full Pi processes that load installed extensions. They must not
	// receive `delegate`, or a worker could start its own orchestration and recurse.
	if (isPiStringsWorkerProcess()) return;
	// Trust answers given "for this session only" and dismissals, and one trust question at a time: a
	// second child bound for the same folder waits for the first answer instead of asking again. An
	// aborted delegate call closes its question, which releases the queue.
	const sessionTrust = new Map<string, boolean>();
	// The latest tool context of this session (a delegate or delegate_ctl call's): its live `tools` is what a
	// child's MCP proxies call. Its folder is where the root session loaded its extensions.
	let toolContext: any;
	let sessionCwd: string | undefined;
	const remember = (ctx: any) => {
		if (!ctx) return;
		if ("tools" in ctx) toolContext = ctx;
		if (typeof ctx.cwd === "string") sessionCwd ??= resolve(ctx.cwd);
	};
	const linkParent = (run: Run, ctx?: any) => {
		remember(ctx);
		parentLinks.set(run, {
			extensionCwd: nesting ? (parentLinks.get(nesting)?.extensionCwd ?? nesting.cwd) : (sessionCwd ?? run.cwd),
			mcpTools: () => pi.getAllTools().filter(isMcpTool),
			callable: () => toolContext?.tools,
		});
	};
	let trustQueue: Promise<unknown> = Promise.resolve();
	const decideTrust = (cwd: string, ctx: ExtensionContext, signal?: AbortSignal) => {
		const decided = trustQueue.then(() => childTrust(cwd, ctx, depth, sessionTrust, signal));
		trustQueue = decided.catch(() => undefined);
		return decided;
	};
	let owner: Owner | undefined;
	/** When the person last prompted: the status board drops acknowledged runs that settled before it. */
	let promptAt = 0;
	let attachError: string | undefined;
	// The acp backend (acp-backend.ts) over the process's one Coordinator. Its runs belong to a
	// parent as pi runs do, and a turn that settles with no wait joined wakes that parent the same way.
	const acp = new AcpBackend({
		ownerKey: () => requireOwner().key,
		changed,
		settled: (v, ownerKey) => {
			const target = state.owners.get(ownerKey);
			if (target?.binding && !target.closed) notify(target, finishedNotice(acpResultText(v), v));
		},
		// Next to this parent's pi run pointers, under the subsession directory.
		runDir: (ownerKey) => join(state.owners.get(ownerKey)?.dir ?? pointerDir(ownerKey), "acp"),
		admit,
	});
	const processes = new ProcessBackend({
		ownerKey: () => requireOwner().key,
		changed,
		settled: (v, ownerKey) => {
			const target = state.owners.get(ownerKey);
			if (target?.binding && !target.closed) notify(target, finishedNotice(processText(v), v));
		},
		runDir: (ownerKey) => join(state.owners.get(ownerKey)?.dir ?? pointerDir(ownerKey), "process"),
		admit,
	});
	// The pi backend (pi-backend.ts): this binding opens its runs' sessions, from its own model runtime.
	const piBackend = new PiBackend({
		owner: requireOwner,
		modelRegistry: () => requireOwner().binding!.ctx.modelRegistry,
		serves: (run) => state.owners.get(run.ownerKey)?.binding?.pi === pi,
		link: (run, ctx) => { if (ctx || !parentLinks.has(run)) linkParent(run, ctx); },
		loader: childLoader,
		resolve: resolvePi,
		resolveModel,
	});
	// The root todo reminder waits while this parent has active children because their completion
	// re-wakes its loop. SDK children install their own todo tool with reminders disabled.
	/** A wait returns early while a completion notice is on its way into this turn, so the model reads it. */
	const noticePending = () => Boolean(owner && inFlight(owner).size);
	const busy = (target: Owner) => ownedRuns(target).some((run) => !run.completion.settled) || acp.owned(target.key).some((run) => run.status === "running") || processes.owned(target.key).some((run) => run.status === "running");
	// Only the root owns reminder coordination; each SDK child gets its todo via childTodoExtension.
	if (!nesting) installTodo(pi, {
		hasActiveJobs: () => Boolean(owner && !owner.closed && busy(owner)),
		remindersEnabled: () => readTodoSettings(SETTINGS_PATH).reminders,
		activity,
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
		if (existing) processes.restore(existing.key);
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
				processes.restore(created.key);
			} catch (error) { await closeOwner(created); await acp.closeOwner(created.key); await processes.closeOwner(created.key); throw error; }
			existing = created;
		}
		owner = existing;
		owner.binding = { pi, ctx };
		const bound = owner;
		if (nesting) bound.parentRun = nesting;
		bound.resume = (run, message) => piBackend.steerRun(run, message);
		bound.steerFromUser = (run, message) => piBackend.steerRun(run, message, true);
		bound.acp = acp;
		bound.reopen = (run) => piBackend.openSession(run);
		if (!nesting) bound.live = liveSource;
		// This delegating child's runs are live again, restored from their records.
		else departed.delete(nesting.id);
		bound.busy = () => busy(bound);
		bound.detach = () => shutdown("quit");
		attachError = undefined;
		// The parent's persisted receipt is the durable delivery acknowledgement.
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom_message" && entry.customType === "delegate") acknowledge(owner, entry.details);
			if (entry.type === "message" && entry.message.role === "toolResult") acknowledge(owner, entry.message.details);
		}
		for (const run of ownedRuns(owner)) if (run.completion.settled) publish(run.completion);
		for (const notice of owner.pendingNotices?.splice(0) ?? []) notify(bound, notice);
	}
	/**
	 * This parent's whole tree, in tree order: each run, then the runs it started, while its children's
	 * owner is attached. A nested run's view carries its depth and parentRunId; an ACP run takes its owner's level.
	 */
	const treeViews = (root: Owner): RunView[] => {
		const out: RunView[] = [];
		const walk = (target: Owner, level: number) => {
			for (const run of ownedRuns(target).sort((a, b) => a.startedAt - b.startedAt)) {
				out.push(view(run));
				const nested = childOwner(run);
				if (nested) walk(nested, level + 1);
				else gone(run.id, level + 1);
			}
			const parentRunId = target.parentRun?.id;
			out.push(...acp.owned(target.key).map((v) => level === 1 ? acpRowView(v) : { ...acpRowView(v), depth: level, ...(parentRunId ? { parentRunId } : {}) }));
		};
		// Runs whose delegating child's session closed: listed as they were left, in the same place.
		const gone = (parentRunId: string, level: number) => {
			const entry = departed.get(parentRunId);
			if (!entry) return;
			for (const run of [...entry.pi].sort((a, b) => a.startedAt - b.startedAt)) { out.push(view(run)); gone(run.id, level + 1); }
			out.push(...entry.acp.map(({ view: v }) => ({ ...acpRowView(v), depth: level, parentRunId })));
		};
		walk(root, 1);
		return out;
	};
	/**
	 * Reopen the session of the delegating run that held departed run `id` (and, first, its own delegating
	 * run's, when that one departed too), so `id` is live again in its owner, restored from its record.
	 * Nothing runs: the delegating child's session opens, its children reattach, and the steer follows.
	 */
	const revive = async (id: string): Promise<void> => {
		const found = findDeparted(id);
		if (!found) return;
		await closingChildren.get(found.parentId)?.catch(() => undefined);
		let parent = runs.get(found.parentId);
		if (!parent && findDeparted(found.parentId)) { await revive(found.parentId); parent = runs.get(found.parentId); }
		if (!inTree(parent)) throw new Error(`${id}: the child that started it is no longer in this session's tree`);
		const reopen = state.owners.get(parent.ownerKey)?.reopen;
		if (!reopen) throw new Error(`${id}: ${parent.id}'s owner is not attached; steer ${parent.id} instead`);
		await reopen(parent);
		if (findDeparted(id)) throw new Error(`${id}: ${parent.id} reopened without restoring it`);
	};
	/**
	 * The owner in this parent's tree that owns ACP run `id`, with the backend that may act on it: this
	 * binding's for its own runs, a delegating child's binding's for the runs that child started.
	 */
	const acpOwner = (id: string): AcpBackend | undefined => {
		if (!owner) return undefined;
		const search = (target: Owner): AcpBackend | undefined => {
			if (acp.find(id, target.key)) return target === owner ? acp : target.acp;
			for (const run of ownedRuns(target)) {
				const nested = childOwner(run);
				const found = nested && search(nested);
				if (found) return found;
			}
			return undefined;
		};
		return search(owner);
	};
	/** A pi run anywhere in this parent's tree: its owner chain ends at this parent's owner. */
	const inTree = (run: Run | undefined): run is Run => {
		for (let key = run?.ownerKey; key;) {
			if (key === owner?.key) return true;
			key = state.owners.get(key)?.parentRun?.ownerKey;
		}
		return false;
	};
	const liveSource: LiveSource = {
		all: () => owner ? treeViews(owner) : [],
		processes: () => owner ? processes.owned(owner.key) : [],
		activity: (id) => {
			const r = runs.get(id);
			if (inTree(r)) return activityOf(r);
			const backend = acpOwner(id);
			if (backend) return backend.activity(id);
			const gone = findDeparted(id);
			return gone?.run ? activityOf(gone.run) : gone?.acp?.activity ?? { messages: [], activeTools: new Map() };
		},
		subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		steer: async (id, message) => {
			requireOwner();
			// As a root's settled child is revived by a steer: reopen what held it first, then steer it live.
			if (!runs.has(id) && !acpOwner(id) && findDeparted(id)) await revive(id);
			const backend = acpOwner(id);
			if (backend) {
				await backend.steer(id, { message }); return;
			}
			const r = runs.get(id);
			if (!inTree(r)) throw new Error(`${id}: child is not in this parent's tree`);
			// A message typed directly by the human is an explicit restart request. A nested run is steered
			// by the delegating child's binding, which owns its session and its revival.
			if (r.ownerKey === requireOwner().key) { await piBackend.steerRun(r, message, true); return; }
			const steerer = state.owners.get(r.ownerKey)?.steerFromUser;
			if (!steerer) throw new Error(`${id}: its delegating child's session is not open; steer that child instead`);
			await steerer(r, message);
		},
		cancel: async (id) => {
			const target = requireOwner();
			if (processes.find(id, target.key)) { await processes.cancel(id); return; }
			const backend = acpOwner(id);
			if (backend) { await backend.cancel(id, {}); return; }
			const r = runs.get(id); if (inTree(r)) await cancelRun(r);
		},
	};
	pi.on("message_end", (event) => {
		if (!owner?.binding || owner.binding.pi !== pi) return;
		const message = event.message;
		if ((message.role === "custom" && message.customType === "delegate") || message.role === "toolResult") acknowledge(owner, message.details);
	});

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
		const run = runs.get(args?.runId ?? "");
		if (!text || run?.completion.settled) { stopTicking(ctx); return empty(); }
		state.startedAt ??= Date.now();
		state.interval ??= setInterval(() => ctx.invalidate(), 1000);
		const child = run ? ` \u00b7 ${run.status === "running" ? run.activeTools.values().next().value?.name ?? "thinking" : run.status}` : "";
		return framed((width) => [truncateToWidth(theme.fg("accent", `\u23f3 ${text}`) + theme.fg("dim", `${child} \u00b7 ${formatDuration(Date.now() - state.startedAt!)} \u00b7 abort to stop waiting; the child keeps running`), width, "\u2026")]);
	};
	const stopTicking = (ctx: any) => {
		const state = ctx?.state as { interval?: ReturnType<typeof setInterval> } | undefined;
		if (state?.interval) { clearInterval(state.interval); state.interval = undefined; }
	};
	// The renderer must tolerate whatever shape is on disk from earlier versions; see resultView.
	const resultRenderer = (title: string) => (result: any, opts: any, theme: any, ctx: any) => {
		stopTicking(ctx);
		return framed((width) => resultView(title, ctx.args?.action, subject(ctx.args), result, opts, theme, width));
	};

	// What a start and a steer tell the model, either backend: the completion wakes it; wait joins it.
	const START_HINT = "Completion will wake you; use delegate_ctl wait with this runId when dependent work needs the result.";
	/** Warn-only: a long budget with no early deliverable or stop line tends to go silent. */
	const briefWarning = (timeoutMs: number, task: string | undefined) =>
		timeoutMs > 30 * 60_000 && !/FIRST DELIVERABLE/.test(task ?? "") && !/STOP WHEN/.test(task ?? "")
			? " Warning: a long budget with no FIRST DELIVERABLE / STOP WHEN line in the brief; long open-ended runs tend to go silent. Consider adding them, and pass firstDeliverableMin (minutes until the first file is due)." : "";
	const STEER_HINT = "Completion will wake you; use wait to join.";
	// --- acp results. A failure is reported by its code; it never becomes a different action.
	const failed = (error: unknown, details?: AcpRunView) => {
		if (!(error instanceof DelegateError)) throw error;
		const info = { error: { code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) } };
		return {
			content: [{ type: "text" as const, text: `${error.code}: ${error.message}` }], isError: true,
			details: details ? { ...info, run: details } : info,
		};
	};
	const settledBadly = (v: AcpRunView) => v.status !== "running" && v.status !== "idle" && v.status !== "complete";
	const acpRunResult = (v: AcpRunView) => ({ content: [{ type: "text" as const, text: acpResultText(v) }], details: v, isError: settledBadly(v) });
	const acpStartText = (v: AcpRunView) => {
		const session = sessionLabel(v);
		if (v.status === "idle") return `${v.id} idle (acp ${v.session.agent}, ${session}); no turn sent. Use delegate_ctl steer with this runId to send one, status or result to read it, close to disconnect.`;
		return `${v.id} running (acp ${v.session.agent}, ${session}). ${START_HINT}`;
	};
	const acpRow = (v: AcpRunView, settled: boolean): WaitRow => ({ id: v.id, settled, report: acpResultText(v), summary: acpSummary(v), details: v, bad: settledBadly(v) });
	/**
	 * A wait's report: a head saying why it ended, then each settled run's full report, then (unless the mode was
	 * satisfied) each pending run's summary. One run's details are its own; several runs' are their rows.
	 */
	const waitResult = (outcome: Pick<JoinOutcome<unknown>, "reason" | "lost" | "stranded">, rows: WaitRow[], runIds: readonly string[], timeoutMs?: number) => {
		const { reason } = outcome;
		const settled = rows.filter((row) => row.settled), pending = rows.filter((row) => !row.settled);
		const still = pending.map((row) => row.id).join(", ");
		const one = runIds.length === 1 ? settled[0] ?? pending[0] : undefined;
		const lost = () => {
			if (!outcome.stranded) return `wait lost ${outcome.lost}: ${still}`;
			if (!one) return `wait lost ${outcome.stranded}, which stopped without reporting completion (read its status or result; steer with restart:true if it must continue). Not settled: ${still}`;
			return `${one.id}: wait lost the child — status=${one.details.status}${one.details.error ? `: ${one.details.error}` : ""}\nThe child stopped without reporting completion, so this wait cannot return a result. Read status or result for details; steer with restart:true if it must continue.`;
		};
		const head = reason === "timeout" ? `wait timed out after ${timeoutMs} ms; nothing was cancelled. Still running: ${still}`
			: reason === "interrupted" ? one
				? `${one.id}: wait interrupted — queued messages are waiting for you; the child keeps running.\nAnswer the queued message(s) first, then call wait again to rejoin.`
				: `wait interrupted — queued messages are waiting for you; the runs keep going.\nAnswer the queued message(s) first, then call wait again to rejoin. Still running: ${still}`
			: reason === "lost" ? lost()
			: pending.length ? `${settled.length} settled; still running: ${still}` : "";
		const text = [head, ...settled.map((row) => row.report), ...(reason === "settled" ? [] : pending.map((row) => row.summary))].filter(Boolean).join("\n\n");
		const details = one ? one.details : { kind: "runs", rows: [...settled, ...pending].map((row) => row.details), wait: { reason, pending: pending.map((row) => row.id) } };
		return { content: [{ type: "text" as const, text }], details, isError: reason === "lost" || (reason === "settled" && settled.some((row) => row.bad)) };
	};

	/** Every run this parent owns, by ID, for a not-found error. */
	const knownRuns = (owner: Owner) => [...ownedRuns(owner).map((r) => r.id), ...acp.owned(owner.key).map((v) => v.id), ...processes.owned(owner.key).map((v) => v.id)].join(", ") || "none";
	/**
	 * delegate_ctl wait, for one run or several, of either backend, any or all (wait.ts). Each backend holds its
	 * runs (piJoin, AcpBackend.join), so a run that settles reports here instead of waking the parent. Queued
	 * parent messages end the wait early, a timeout ends it, and an abort only detaches: no run is ever cancelled.
	 * A run this wait reports is delivered by it; any other run keeps its own wake-up.
	 */
	async function waitRuns(owner: Owner, ids: readonly string[], mode: "any" | "all", ctx: ExtensionContext, signal?: AbortSignal, timeoutMs?: number) {
		const piIds: string[] = [], acpIds: string[] = [], processIds: string[] = [];
		for (const id of ids) {
			if (processes.find(id, owner.key)) processIds.push(id);
			else if (acp.find(id, owner.key)) acpIds.push(id);
			else if (piBackend.find(id, owner.key)) piIds.push(id);
			else throw new DelegateError("RUN_NOT_FOUND", `unknown runId ${id}; known: ${knownRuns(owner)}`, "runIds");
		}
		if (signal?.aborted) throw waitCancelled(ids.length === 1 ? "child" : "runs");
		const joins: Join<WaitRow | AcpRunView | ProcessRunView>[] = [];
		// Each join can refuse a run (a capability); take the ACP one before the pi runs are subscribed.
		if (acpIds.length) joins.push(acp.join(acpIds));
		if (piIds.length) joins.push(piBackend.join(piIds));
		if (processIds.length) joins.push(processes.join(processIds));
		const outcome = await joinRuns(joins, ids, mode, {
			...(signal ? { signal } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}),
			interrupted: () => ctx.hasPendingMessages() || noticePending(), lost: ACP_JOIN_LOST,
		});
		const row = (v: WaitRow | AcpRunView | ProcessRunView, settled: boolean): WaitRow => {
			if ("backend" in v && v.backend === "process") return { id: v.id, settled, report: processText(v), summary: processText(v, false), details: v, bad: v.status !== "running" && v.status !== "done" };
			return (v as AcpRunView).backend === "acp" ? acpRow(v as AcpRunView, settled) : v as WaitRow;
		};
		return waitResult(outcome, [...outcome.settled.map((v) => row(v, true)), ...outcome.pending.map((v) => row(v, false))], ids, timeoutMs);
	}

	/**
	 * What a pi start makes of the parent's call (PiBackend.start): the role, its offering, trust, tools and prompt.
	 * A refusal is a DelegateError, and nothing was started.
	 */
	async function resolvePi(p: PiStartInput, { ctx }: PiCall, signal?: AbortSignal): Promise<PiRunSpec> {
		const cap = maxDepth();
		requireOwner();
		const cwd = realpathSync(p.cwd ?? ctx.cwd);
		const { trusted: projectTrusted, source: projectTrustSource } = await decideTrust(cwd, ctx, signal);
		// Aborted while the trust question was open or queued: start nothing.
		if (signal?.aborted) throw new DelegateError("ABORTED", "the delegate call was aborted before the child started; nothing was started");
		// Again, after the trust await: parallel delegate calls each passed the first check before any of
		// them existed. From here to runs.set nothing awaits, so this count includes every earlier start.
		admit();
		const roles = loadRoles(cwd, projectTrusted, AGENT_DIR);
		const role = roles.get(p.role);
		if (!role) throw new DelegateError("ROLE_UNKNOWN", `unknown role "${p.role}". available: ${[...roles.keys()].sort().join(", ")}`, "role");
		// Model: explicit param, else the role's approved default, else the role's model list, else the parent's.
		// A tui child is another agent's own TUI in oven: its model comes from the role's template (or the call's
		// model, passed to oven as an override), never from this session's Pi models.
		const tui = p.tui ?? role.tui;
		if (tui && p.runtime === "in-process") throw new DelegateError("INPUT_INVALID", `role "${role.name}" runs as a ${tui} tui child in oven; runtime "in-process" does not apply`, "runtime");
		const approved = tui ? undefined : loadDefaults().approved[role.name];
		let resolved: { model: any; thinking?: string; pick?: string } = { model: undefined };
		if (!tui) {
			try { resolved = p.model ?? approved?.spec ? resolveModel(p.model ?? approved!.spec, ctx) : resolveRoleModels(role.models, ctx); }
			catch (error) { throw new DelegateError("MODEL_UNAVAILABLE", errorMessage(error), "model"); }
			if (!resolved.model) throw new DelegateError("MODEL_UNAVAILABLE", "no model available for child", "model");
		}
		const { model, thinking: specThinking, pick: modelPick } = resolved;
		const thinking = String(specThinking ?? (p.model ? undefined : approved && parseModelSpec(approved.spec).thinking) ?? role.thinking ?? (tui ? "default" : "medium"));
		const timeoutMs = p.timeoutMs ?? role.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		// Validated against the call's own timeoutMs already; the role's or the default budget is known only here.
		const late = p.firstDeliverableMin !== undefined ? firstDeliverableError(p.firstDeliverableMin, timeoutMs) : undefined;
		if (late) throw new DelegateError("INPUT_INVALID", late, "firstDeliverableMin");
		// A child at the cap could only fail its delegate calls, so it gets no delegation tools at all.
		const atDepthCap = depth + 1 >= cap;
		const tools = [...(role.tools ?? EVERY_TOOL)];
		const withheld = atDepthCap ? [...DELEGATION_TOOLS] : undefined;
		const { allows } = toolAllowlist(tools, withheld);
		// A Claude or Amp TUI has no delegate tools; a Pi TUI loads the user's extensions, pi-delegate among them.
		const delegates = (!tui || tui === "pi") && allows("delegate");
		const isWriter = WRITE_TOOLS.some(allows);
		// Like the model: the role's line is a default the call can override.
		const runtime = tui ? "oven" : p.runtime ?? role.runtime ?? "in-process";
		// An oven slice runs outside this process and never receives the conversation, as an ACP child.
		const context = runtime === "oven" ? "fresh" : p.context ?? role.context ?? "fork";
		const systemPrompt = PLAN_CONFLICT_RULE + role.systemPrompt + (role.systemPrompt.includes("STATUS:") ? "" : contractFooter(delegates, atDepthCap && toolAllowlist(tools).allows("delegate"), cap))
			+ (delegates ? childrenFooter(depth + 1, cap) : "") + (context === "fork" ? FORK_FOOTER : "");
		// An oven slice writes in its own copy, never in this tree.
		if (isWriter && runtime !== "oven") {
			const clash = activeWriter(cwd);
			if (clash) throw new DelegateError("WRITER_CWD_OWNED", `refused: ${clash.id} (${clash.role}) is already writing in ${cwd}. One writer per tree — wait, cancel it, or give this child its own cwd/worktree.`, "cwd");
		}
		const hosted = tui ? tuiTemplate(role, tui, systemPrompt) : undefined;
		return {
			role: role.name, task: p.task, cwd, model: tui ? `${tui}:${p.model ?? "template"}` : modelKey(model), thinking, contextWindow: model?.contextWindow, ...(modelPick ? { modelPick } : {}),
			systemPrompt, context, tools, ...(withheld ? { withheld } : {}), writer: isWriter && runtime !== "oven", timeoutMs,
			...(p.firstDeliverableMin !== undefined ? { firstDeliverableMin: p.firstDeliverableMin } : {}),
			depth: depth + 1, ...(nesting ? { parentRunId: nesting.id } : {}),
			...(runtime === "oven" ? { runtime: "oven" as const, extensions: role.extensions ?? [] } : {}),
			...(tui && hosted ? { tui, template: hosted.template, ...(hosted.taskPrefix ? { taskPrefix: hosted.taskPrefix } : {}), ...(p.model ? { modelOverride: p.model } : {}) } : {}),
			projectTrusted, projectTrustSource,
			inherited: () => context === "fork" ? convertToLlm(trimDangling(stripDelegation(buildSessionContext(ctx.sessionManager.buildContextEntries()).messages))) : [],
		};
	}
	// Held by name so /delegate fork:|fresh: starts a run through the very same path as the tool.
	const delegateTool = {
		name: "delegate",
		renderCall: () => empty(),
		renderResult: resultRenderer("delegate"),
		label: "Delegate",
		description:
			"Before using this tool, read skills/delegation/SKILL.md if you have not read it in this session. " +
			"Run a role on a task in its own session; returns its final report, changed files, tokens, cost, and a runId. The delegation skill covers when to delegate, review triggers, and the model-proposal procedure. " +
			"Delegate only for context isolation, parallelism, or a model-tier switch — if the brief would be longer than the expected diff, do the work yourself. " +
			"Start the brief with a short task title on its own line, then objective, ownership, interfaces/constraints, verification, return shape. " +
			'context "fork" (default) hands the child your conversation so far; "fresh" is for adversarial review. ' +
			"Runs in the background by default \u2014 the call returns a run id at once and you are woken once, when the child finishes. There are no progress pings by design; waiting is not your work. Do other work, or use delegate_ctl wait with that runId to block without polling when nothing else can proceed, or delegate_ctl status for a single progress read when someone asks. A launch never joins the child; use delegate_ctl wait only when dependent work needs its result. A child re-binds the extensions your session loaded and calls your session's MCP tools, and gets their tools (built-ins, extension tools, mcp__<server>__<tool>, delegate and delegate_ctl), limited to its role's tools list; at the depth limit (" + MAX_DELEGATION_DEPTH + " unless the user changed it) it gets no delegate or delegate_ctl. Model: run delegate_ctl models first; when model: is omitted a role's approved default is used, else the first usable entry of the role's model list. Starts beyond the user's limit on running children fail with CONCURRENCY_LIMIT: wait for one to finish. Proposing a model that is not the approved default is a conversation with the user, not a tool step: state the offering, price, rating and tradeoff, get their answer, then call delegate; if they want it kept, delegate_ctl action=approve. Use delegate_ctl to list roles, wait, check status, steer, or cancel. " +
			'backend "acp" runs an external ACP agent session instead (agent required, e.g. "pi", "amp", "codex", "claude"): it creates a session and sends task as its first turn, or with sessionId opens that exact native session (an Amp T-ID, say) without owning it and sends task only when given. ' +
			"An ACP child never receives your conversation (no context), and an opened session keeps its native role and model. Its report carries the agent's native session ID and each turn's request ID and delivery. Close an ACP run with delegate_ctl close when done. " +
			'backend "process" runs a shell command without an agent or model: command is required; task is an optional title. Returns immediately with runId, PID when spawned, outputFile. Agent-only fields fail validation. No execution deadline unless timeoutMs is supplied. Status/result read output and exit facts; wait joins without cancelling on timeout/abort; cancel stops the owned tree. Processes survive turns and reload; quit/session replacement stops them. Reopen reads records without replay or PID adoption.',
		parameters: Type.Object({
			backend: Type.Optional(Type.String({ description: '"pi" (default): Pi child; "acp": external agent; "process": OS command, no model or role' })),
			command: Type.Optional(Type.String({ description: "process only: shell command, preserved verbatim; stdin is closed" })),
			role: Type.Optional(Type.String({ description: 'pi: role name, required (delegate_ctl action=roles lists them). acp: "read-only" (default) or "writer" for a created session; not allowed with sessionId' })),
			task: Type.Optional(Type.String({ description: "agent brief; required except acp with sessionId. process: optional human title" })),
			model: Type.Optional(Type.String({ description: "override. pi: provider/id[:thinking]. acp: the agent's own model ID, created sessions only" })),
			context: Type.Optional(StringEnum(["fork", "fresh"] as const)),
			tui: Type.Optional(StringEnum(["pi", "claude", "amp"] as const, { description: 'pi only: run the child as that agent\'s own TUI hosted by oven (a tui slice), in a copy of cwd, on the role as an agent template (its claude:/amp: sections for those agents); model is passed to that agent. Default: the role\'s tui line. Implies runtime "oven"; attach with `oven attach <slice>`' })),
			runtime: Type.Optional(StringEnum(["in-process", "oven"] as const, { description: 'pi only: where the child runs. Default: the role\'s runtime line, else "in-process". "oven" runs it as a bounded oven slice in a copy of cwd; completion releases execution and steer resumes saved history. Parent quit releases it; reload only rebinds. It never receives your conversation' })),
			cwd: Type.Optional(Type.String()),
			timeoutMs: Type.Optional(Type.Number({ description: `process: execution deadline in ms, none by default. Agents: abort after this many ms; default ${DEFAULT_TIMEOUT_MS / 60000} min. Size it to the work: a build, suite, or training run that takes hours needs hours here, or it is killed mid-flight` })),
			firstDeliverableMin: Type.Optional(Type.Number({ description: "pi only: minutes from the start of each segment by which the child should have written its first file; must be under the timeout. Past it with nothing written the run reads no-artifact. Default for a writer: 15 min or 25% of the budget, whichever is sooner; a read-only child has none unless set" })),
			reason: Type.Optional(Type.String({ description: "one line: why this model for this role; recorded in the run log" })),
			agent: Type.Optional(Type.String({ description: "acp only: the ACP agent to run, e.g. pi, amp, codex, claude" })),
			sessionId: Type.Optional(Type.String({ description: "acp only: open this exact provider-native session (e.g. an Amp T-ID) instead of creating one" })),
			executionEnvironment: Type.Optional(Type.String({ description: 'acp only: "local" or "orb". Creating: where the session runs. Opening (Amp only): a verification hint' })),
			mode: Type.Optional(Type.String({ description: 'acp + amp only, created threads: Amp\'s agent mode (low, medium, high, ultra or a plugin mode), used for every turn. Not with model or sessionId' })),
		}),
		async execute(_id: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionContext): Promise<any> {
			remember(ctx);
			const start = validateStartInput(params as Record<string, unknown>);
			if (!start.ok) return failed(new DelegateError(start.error.code, start.error.message, start.error.field));
			// A session at the cap is launched without delegation tools. This check is the backstop for any
			// session that still has them; it covers both backends, since a child here would run at depth + 1.
			const cap = maxDepth();
			if (depth + 1 > cap) {
				return failed(new DelegateError("DEPTH_EXCEEDED", `delegation depth cap is ${cap}: you run at depth ${depth}, so a child would run at depth ${depth + 1}. Do this work yourself with your own tools.`));
			}
			if (!nesting && mode() === "off") return failed(new DelegateError("DELEGATION_OFF", "delegation is turned off in the pi-delegate settings (/delegate settings). Do this work yourself."));
			const full = capacityError();
			if (full) return failed(full);
			if (start.value.backend === "process") {
				try {
					const v = await processes.start({ ...start.value, cwd: start.value.cwd ?? ctx.cwd }, signal);
					return { content: [{ type: "text", text: `${processText(v, false)}\n${START_HINT}` }], details: v };
				} catch (error) { return failed(error); }
			}
			if (start.value.backend === "acp") {
				const input = start.value;
				try {
					requireOwner();
					// A created session works where the parent does unless told otherwise; an opened one keeps its native workspace.
					const cwd = input.cwd !== undefined ? realpathSync(input.cwd) : input.origin === "created" ? realpathSync(ctx.cwd) : undefined;
					const v = await acp.start({ ...input, ...(cwd !== undefined ? { cwd } : {}) });
					return { content: [{ type: "text", text: acpStartText(v) }], details: v };
				} catch (error) {
					const details = error instanceof DelegateError && error.runId ? await acp.result(error.runId).catch(() => undefined) : undefined;
					return failed(error, details);
				}
			}
			try {
				const v = await piBackend.start(start.value, signal, { ctx, onUpdate });
				const run = runs.get(v.id)!;
				const due = firstDeliverableAt(run);
				return { content: [{ type: "text", text: `${run.id} running (${run.runtime === "oven" ? "oven slice" : run.context}, ${run.model}), ${budgetText(runHealth(run))}${due !== undefined ? `, first deliverable due ${clock(due)}` : ""}. ${START_HINT}${briefWarning(run.timeoutMs, run.task)}` }], details: recordedView(run) };
			} catch (error) { return failed(error); }
		},
	};
	pi.registerTool(delegateTool);

	pi.registerTool({
		name: "delegate_ctl",
		renderCall: blockingCall((args) => args?.action === "wait" ? `Waiting for ${args.runId ?? (Array.isArray(args.runIds) && args.runIds.length ? args.runIds.join(", ") : "a child")}` : undefined),
		renderResult: resultRenderer("delegate_ctl"),
		label: "Delegate control",
		description:
			"Before using this tool, read skills/delegation/SKILL.md if you have not read it in this session. models without runId: every offering across all enabled providers, verbatim from the registry (provider/id, reasoning, context, $/M), plus live OpenRouter pricing, tiered rates, expirations and Artificial Analysis indices, your cached ratings, approved defaults and drift \u2014 call before the first delegate of a session. models with an ACP runId list that agent's current model and selectable native/fallback IDs with labels and descriptions. One-run status/result show the same catalog compactly. deals: read-only OpenRouter promotion and price/quality shortlist for frontier and light work; does not choose or approve a model. " +
			"rate: store quality ratings you researched, per exact offering (provider/id), so choices are grounded; stale after 14 days. approve: record a role's default model after the user agreed in conversation. " +
			"roles: list roles. status: one run or all \u2014 a nonblocking progress read: status, current tool, tool calls so far, elapsed, remaining time budget. result: current report without waiting. wait: join an existing runId; returns its final report, immediately if finished. If queued messages arrive while waiting it returns early with the child still running — answer them, then wait again to rejoin. If the child stops without reporting completion it returns an error report instead of blocking until the run budget. Cancelling wait only detaches; the child keeps running. An attached waiter receives completion instead of a separate wake-up. steer: queue a correction or resume a finished child in the background, keeping its context; returns immediately. A running child reads a plain steer only at its next turn boundary (status shows `steer pending` until it does); with interrupt: true the current turn is aborted and the message becomes its next prompt, same run and budget — use that when a child is silent, looping or in a long think. Use wait to join the resumed work. Saved children are restored on parent reopen without running; steer revives them with their original configuration unless you pass model:, which moves that child to another offering from the next segment on \u2014 propose it in conversation first, including when the saved offering is exhausted or gone. Explicitly stopped children require restart:true and the user's request. cancel: stop the child and prevent automatic revival. " +
			"Process runIds support status/result/wait/cancel, with outputFile, bounded output tail, status, exit code and signal. steer/close/models on a process fail ACTION_UNSUPPORTED. No model lookup is needed for commands. " +
			"wait with runIds joins pi, acp and process runs at once and returns when the first settles by default; pass mode=\"all\" when every result is required. timeoutMs only ends that wait, never the runs. " +
			"Runs started with backend acp take the same runId actions: status and result read the session and its latest turn; wait joins it; steer sends the next turn, queued behind another attachment's active Amp turn when needed; cancel stops only a turn this run started; close releases the session \u2014 a created one is disposed, an opened one only disconnected, never archived or deleted. close is acp only and final. " +
			"When the parent exits, its acp runs are parked, not closed: their sessions are released and their records stay readable after a restart; steer reopens one (an opened run by its native ID, a created run by native resume, else RUN_NOT_RESUMABLE). " +
			"status and result on an open Amp run read the native thread once by default (one amp threads export, never in the background) and return only messages after the last ones this attachment showed, from any participant; a failed read is reported as unknown. Other runs do not observe a native thread. " +
			"An Amp run's thread cost (amp threads usage) is read once per settled turn, which its wait result or wake-up reports, and by status or result with a runId unless the cached cost is current (a closed run, or a created run with no turn since); unknown when it was never read, and a failed read keeps the last cost with when it was read.",
		parameters: Type.Object({
			action: StringEnum(["models", "deals", "rate", "approve", "roles", "status", "result", "wait", "steer", "cancel", "close"] as const),
			role: Type.Optional(Type.String({ description: "approve: role name" })),
			model: Type.Optional(Type.String({ description: "approve: provider/id[:thinking] the user agreed to. steer: run the next segment on this offering instead of the child's saved one; the user chooses it, you never substitute silently" })),
			runId: Type.Optional(Type.String()),
			runIds: Type.Optional(Type.Array(Type.String(), { description: "wait: join pi, acp and process runs at once, with mode" })),
			mode: Type.Optional(StringEnum(["any", "all"] as const, { description: "wait with runIds: any (default) returns when the first run settles; all waits for every run" })),
			force: Type.Optional(Type.Boolean({ description: "close: cancel an active turn first instead of refusing" })),
			discardPersistentState: Type.Optional(Type.Boolean({ description: "close, created acp sessions only: do not keep the session resumable" })),
			restart: Type.Optional(Type.Boolean({ description: "steer only: restart an explicitly stopped child, only when the user requested it" })),
			interrupt: Type.Optional(Type.Boolean({ description: "steer only, a running in-process pi child: abort its current turn now and give it message as its next prompt, in the same run and budget. Without it a steer waits for the child's next turn boundary, which can be many minutes in a long think. Use it when the child is silent, looping or deep in a long think and that wait is unacceptable. Refused for a settled child (a plain steer resumes it), an oven run, and acp runs" })),
			timeoutMs: Type.Optional(Type.Number({ description: "steer: adds this much time from now to the child (ms) \u2014 on a running child the clock is re-armed at once and ends this long from now; an inactive child gets it as the budget of its next segment. wait: stop waiting after this many ms; the runs keep going" })),
			message: Type.Optional(Type.String({ description: "steer: the correction. global models/deals: substring filter. approve: one-line reason the user agreed to" })),
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
			remember(ctx);
			if (p.runId && processes.find(p.runId, requireOwner().key)) {
				try {
					if (p.action !== "status" && p.action !== "result" && p.action !== "cancel" && p.action !== "wait") {
						const reason = processes.capabilities().steer;
						throw new DelegateError("ACTION_UNSUPPORTED", `${p.action} is not supported on the process backend: ${!reason.supported ? reason.reason : "one-shot command"}`);
					}
					if (p.action !== "wait") {
						const v = p.action === "cancel" ? await processes.cancel(p.runId) : await processes.result(p.runId);
						return { content: [{ type: "text", text: processText(v) }], details: v, isError: v.status !== "running" && v.status !== "done" };
					}
				} catch (error) { return failed(error); }
			}
			if (p.action === "approve") {
				// Approval records the user's yes from the conversation. A delegating child never has that conversation.
				if (nesting) return { content: [{ type: "text", text: "approve records a default the user agreed to; only the root parent talks to the user. Report the proposal in your final report instead." }], isError: true, details: undefined };
				if (!p.role || !p.model) return { content: [{ type: "text", text: "approve requires role and model" }], isError: true, details: undefined };
				const { model, thinking } = resolveModel(p.model, ctx);
				if (!model) return { content: [{ type: "text", text: `model not found: ${p.model}` }], isError: true, details: undefined };
				const spec = `${modelKey(model)}${thinking ? `:${thinking}` : ""}`;
				await saveDefault(p.role, { spec, reason: p.message, approvedAt: Date.now(), cost: model.cost ? { input: model.cost.input, output: model.cost.output } : undefined }, availableModels(ctx));
				return { content: [{ type: "text", text: `${p.role} \u2192 ${spec} saved as default (${tildify(SETTINGS_PATH)}). Only call this after the user has agreed in conversation.` }], details: undefined };
			}
			if (p.action === "rate") {
				if (!p.ratings?.length) return { content: [{ type: "text", text: "rate requires ratings: [{model, score, source, note?}]" }], isError: true, details: undefined };
				const r = await saveRatings(p.ratings);
				return { content: [{ type: "text", text: `stored ${p.ratings.length}; ${Object.keys(r.entries).length} rated in total. Run models to see them applied.` }], details: undefined };
			}
			if (p.action === "deals") {
				try {
					const details = await discoverDeals(ctx, p.message, signal);
					return { content: [{ type: "text", text: await dealsReport(details) }], details };
				} catch (e) {
					return { content: [{ type: "text", text: String(e) }], details: undefined, isError: true };
				}
			}
			if (p.action === "models" && p.runId) {
				const owner = requireOwner();
				const target = acp.find(p.runId, owner.key);
				if (!target) return failed(new DelegateError("RUN_NOT_FOUND", `unknown ACP runId ${p.runId}`, "runId"));
				const models = await acp.models(p.runId);
				if (!models) return failed(new DelegateError("MODEL_DISCOVERY_UNSUPPORTED", `${p.runId} has no live ACP session to inspect.`, "runId"));
				const run = (await acp.status([p.runId]))[0]!;
				const rows = models.options?.length
					? models.options.map((option) => `  ${option.id}  ${option.name}${option.description ? ` — ${option.description}` : ""}${option.id === models.current ? "  * current" : ""}`)
					: (models.available ?? []).map((id) => `  ${id}${id === models.current ? "  * current" : ""}`);
				const text = [
					`${p.runId} ACP model catalog`,
					`agent: ${run.session.agent}`,
					acpModelsText(models),
					models.source ? `source: ${models.source}` : "",
					...rows,
				].filter(Boolean).join("\n");
				return { content: [{ type: "text", text }], details: { kind: "acp-models", runId: p.runId, agent: run.session.agent, ...models } };
			}
			if (p.action === "models") {
				const all = availableModels(ctx);
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
					await Promise.all(orIds.slice(0, EP_CAP).map((id) => fetchEndpoints(id)));
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
				const roles = sortedRoles(ctx);
				const approved = loadDefaults().approved;
				// The tools a child started from here would be offered: this session's, or, in a delegating child,
				// what its own session was offered.
				const offered = nesting ? [...(nesting.offered ?? [])] : pi.getAllTools().map((tool) => tool.name);
				const withheld = depth + 1 >= maxDepth() ? DELEGATION_TOOLS : [];
				const rows = roles.map((r) => {
					const tools = r.tools ?? EVERY_TOOL;
					const { allows } = toolAllowlist(tools, withheld);
					return {
						name: r.name,
						mode: `${r.context ?? "fork"}${r.thinking ? `:${r.thinking}` : ""}`,
						model: approved[r.name]?.spec ?? r.model ?? "needs approval",
						approved: Boolean(approved[r.name]),
						writes: WRITE_TOOLS.some(allows),
						// Its own tools may be read-only, but the children it starts may be writers.
						delegates: allows("delegate"),
						tools,
						dropped: droppedTools(tools, offered, withheld),
						timeoutMs: r.timeoutMs,
						description: r.description,
						source: r.source,
					};
				});
				const lines = rows.map((r, i) => `${r.name}  [${r.mode}]  ${approved[roles[i].name] ? "default" : "no default"}: ${r.model}${r.delegates ? (r.writes ? "  [writes; delegates]" : "  [delegates; can write via children]") : ""}  ${r.description}  (${r.source})`);
				return { content: [{ type: "text", text: lines.join("\n") || "no roles found" }], details: { kind: "roles", rows } };
			}
			const owner = requireOwner();
			if (p.action === "status" && !p.runId) {
				const owned = ownedRuns(owner);
				const external = acp.owned(owner.key);
				const commands = processes.owned(owner.key);
				const lines = [...owned.filter((r) => onBoard(r, promptAt)).map((r) => boardLine({ ...r, lastProgressAt: progressAt(r), durationMs: (r.status === "running" ? Date.now() : (r.endedAt ?? Date.now())) - r.segmentStartedAt })), ...external.map((v) => acpSummary(v).split("\n")[0]), ...commands.map((v) => processText(v, false))];
				return { content: [{ type: "text", text: lines.join("\n") || "no runs" }], details: { kind: "runs", rows: [...owned.map(recordedView), ...external, ...commands] } };
			}
			// One wait for one run or several, of either backend (waitRuns).
			if (p.action === "wait") {
				const ids = [...new Set(p.runIds ?? (p.runId ? [p.runId] : []))];
				try {
					if (!ids.length) throw new DelegateError("INPUT_INVALID", "wait needs runId or runIds", "runIds");
					return await waitRuns(owner, ids, p.mode ?? "any", ctx, signal, p.timeoutMs);
				} catch (error) { return failed(error); }
			}
			if (acp.find(p.runId, owner.key)) {
				const id = p.runId!;
				// The cost read, an observation's export and the model read are separate calls: run them together, then read the view they updated.
				const attached = acp.find(id, owner.key);
				const shouldObserve = (p.action === "status" || p.action === "result") && attached !== undefined && attached.closedAt === undefined && attached.origin === "opened" && attached.agent.toLowerCase() === "amp";
				const read = async (latest: () => Promise<AcpRunView>): Promise<AcpRunView> => {
					const [, observed, models] = await Promise.all([acp.refreshUsage(id), shouldObserve ? acp.observe(id) : undefined, acp.models(id)]);
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
						case "steer": {
							const current = await acp.result(id);
							const request = unwrap(validateSteer({ backend: "acp", origin: current.session.origin, agent: current.session.agent }, p as Record<string, unknown>));
							const v = await acp.steer(id, request);
							const queued = v.session.origin === "opened" && v.session.agent.toLowerCase() === "amp" && v.turns.at(-1)?.status === "running";
							return { content: [{ type: "text", text: `${id}: turn ${v.turns.at(-1)?.requestId} ${queued ? "queued" : "sent"}${request.model ? ` on model ${request.model}` : ""}. ${STEER_HINT}` }], details: v };
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
			if (!run || run.ownerKey !== owner.key) return failed(new DelegateError("RUN_NOT_FOUND", `unknown runId ${p.runId ?? "(none)"}; known: ${knownRuns(owner)}`, "runId"));
			// The pi backend's capability report decides what it cannot do; that fails, it never becomes another action.
			const capability = requireAction(run.runtime === "oven" ? OVEN_CAPABILITIES : PI_CAPABILITIES, p.action as LifecycleAction);
			if (!capability.ok) return failed(new DelegateError(capability.error.code, capability.error.message));

			switch (p.action) {
				case "status":
					if (run.session && run.status === "running") harvest(run);
					return { content: [{ type: "text", text: `${summary(run)}${run.status === "running" ? `\nnow: ${run.providerRetry ? `provider retry ${run.providerRetry.attempt}/${run.providerRetry.maxAttempts}` : run.activeTools.values().next().value?.name ?? (run.lastTool ? `thinking after ${run.lastTool}` : "thinking")} \u00b7 ${run.toolCalls.length} tool call${run.toolCalls.length === 1 ? "" : "s"} so far \u00b7 ${Math.max(0, Math.round((run.timeoutMs - (Date.now() - run.segmentStartedAt)) / 60000))} min of current segment budget left` : ""}` }], details: recordedView(run) };
				case "result":
					return run.completion.settled ? finalResult(run) : { content: [{ type: "text", text: resultText(run) }], details: recordedView(run) };
				case "cancel":
					await piBackend.cancel(run.id, {});
					return { content: [{ type: "text", text: cancelText(run) }], details: recordedView(run) };
				case "steer": {
					const request = unwrap(validateSteer({ backend: "pi" }, p as Record<string, unknown>));
					const running = run.status === "running";
					const previous = `${run.model}${run.thinking ? `:${run.thinking}` : ""}`;
					// An expired oven run is refused by its code, with oven's words; nothing was sent or started.
					try { await piBackend.steer(run.id, request, { ctx }); }
					catch (error) { if (error instanceof DelegateError && error.code === "RUN_EXPIRED") return failed(error); throw error; }
					const moved = request.model ? ` Model changed from ${previous} to ${run.model}${run.thinking ? `:${run.thinking}` : ""} for this and later segments; its earlier work keeps the model it ran on.` : "";
					const retimed = request.timeoutMs !== undefined ? ` Adds ${Math.round(request.timeoutMs / 60000)} min from now: ${budgetText(runHealth(run))}.` : "";
					const trust = run.projectTrustUnknown ? ` Note: ${TRUST_UNKNOWN}.` : "";
					return { content: [{ type: "text", text: `${run.id}: ${!running ? "resumed in the background" : request.interrupt ? "interrupted the current turn; the message is its next prompt, same run and budget" : "steer queued; read at the child's next turn boundary (status shows steer pending/read)"}.${moved}${retimed}${trust} ${STEER_HINT}` }], details: recordedView(run) };
				}
			}
			return { content: [{ type: "text", text: "unreachable" }], isError: true, details: undefined };
		},
	});

	pi.registerMessageRenderer("delegate", (message: any, { expanded }: any, theme: any) => {
		const v = message.details as RunView | undefined;
		if (!v || typeof v !== "object" || !("id" in v)) return undefined;
		if ((v as any).backend === "process") return framed((width) => processLines(v as unknown as ProcessRunView, expanded, theme, width));
		const shown = asRunView(v) ?? v;
		return framed((width) => resultLines(shown, expanded, theme, width));
	});

	const PARKED = "pi-delegate.parked";
	const baseDescription = delegateTool.description;
	let describedMode: string | undefined;
	/**
	 * Apply the root's delegation mode. `off` parks the delegation tools (takes them out of the active
	 * set); another mode brings back only what was parked, so a tool the person turned off themselves
	 * stays off. The parked set is a session entry on the branch, so a restart or /tree, which restore
	 * the active tools from the transcript, still knows what to bring back. The orchestrator
	 * instruction is the delegate tool's description, re-registered only when the mode changes.
	 */
	function syncMode(ctx: ExtensionContext) {
		const current = mode();
		const orchestrating = current === "orchestrator";
		if (describedMode === undefined ? orchestrating : (describedMode === "orchestrator") !== orchestrating) {
			delegateTool.description = baseDescription + (orchestrating ? ORCHESTRATOR_PROMPT : "");
			pi.registerTool(delegateTool);
		}
		describedMode = current;
		const entry = ctx.sessionManager.getBranch().findLast((e: any) => e.type === "custom" && e.customType === PARKED) as any;
		const parked: string[] = Array.isArray(entry?.data?.tools) ? entry.data.tools.filter((name: unknown) => DELEGATION_TOOLS.includes(name as string)) : [];
		const active = pi.getActiveTools();
		if (current === "off") {
			const drop = active.filter((name) => DELEGATION_TOOLS.includes(name));
			if (!drop.length) return;
			pi.setActiveTools(active.filter((name) => !drop.includes(name)));
			pi.appendEntry(PARKED, { tools: [...new Set([...parked, ...drop])] });
		} else if (parked.length) {
			pi.setActiveTools([...active, ...parked.filter((name) => !active.includes(name))]);
			pi.appendEntry(PARKED, { tools: [] });
		}
	}
	let navigationOpen = false;
	const childDrafts = new Map<string, string>();
	/** The roles page: what a delegate call without model: would run on now, and where each role comes from. */
	function roleLines(ctx: ExtensionContext): string[] {
		const roles = sortedRoles(ctx);
		const approved = loadDefaults().approved;
		const lines = roles.flatMap((r) => {
			let now: string;
			try {
				const resolved: { model: any; pick?: string } = approved[r.name] ? resolveModel(approved[r.name].spec, ctx) : resolveRoleModels(r.models, ctx);
				now = `${resolved.model ? modelKey(resolved.model) : "no model"}${approved[r.name] ? " (approved default)" : r.models?.length ? resolved.pick ? ` — ${resolved.pick}` : " (role file)" : " (this session's model)"}`;
			} catch (error) { now = `unavailable: ${errorMessage(error)}`; }
			return [`${r.name} — ${r.description}`,
				`  models: ${r.models?.join(", ") ?? "inherits this session's model"}`,
				`  runs on now: ${now}`,
				`  ${r.context ?? "fork"} context${r.thinking ? ` · thinking ${r.thinking}` : ""} · tools: ${r.tools?.join(", ") ?? "every tool"}`,
				`  ${r.source}`, ""];
		});
		return [...lines, `Edit a role's model: line to list models, most preferred first. Roles are read from ${roleSourcesText(AGENT_DIR)}.`];
	}
	async function openSettings(ctx: ExtensionContext) {
		if (ctx.mode !== "tui") {
			const d = readDelegateSettings(SETTINGS_PATH), t = readTodoSettings(SETTINGS_PATH), r = readRecapSettings(SETTINGS_PATH);
			ctx.ui.notify(`delegate settings: mode ${d.mode} · max depth ${d.maxDepth} · max running ${d.maxConcurrent || "no limit"} · model picking ${d.modelPicking} · todo reminders ${t.reminders ? "on" : "off"} · recap ${r.enabled ? "on" : "off"} after ${formatRecapThreshold(r.idleThresholdMs)} (${SETTINGS_PATH})`, "info");
			return;
		}
		const [{ delegateRows, recapRows, todoRows }, { SettingsPanel, textPage }] = await Promise.all([
			import("./ui/delegate-settings.ts"),
			import("./ui/settings-panel.ts"),
		]);
		let settings = readDelegateSettings(SETTINGS_PATH);
		let todoSettings = readTodoSettings(SETTINGS_PATH);
		let recapSettings = readRecapSettings(SETTINGS_PATH);
		await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
			const rows: SettingsRow[] = [
				...delegateRows(() => settings, async (change) => { settings = await saveDelegateSettings(change, SETTINGS_PATH); if ("mode" in change) syncMode(ctx); }),
				...todoRows(() => todoSettings, async (change) => { todoSettings = await saveTodoSettings(change, SETTINGS_PATH); }),
				...recapRows(() => recapSettings, async (change) => { recapSettings = await saveRecapSettings(change, SETTINGS_PATH); }),
				{ id: "roles", section: "Agents", label: "Roles", value: () => `${loadRoles(ctx.cwd, ctx.isProjectTrusted(), AGENT_DIR).size} roles`,
					help: "Each role's model list, the model a delegate call without model: runs on right now, and the file it comes from.",
					submenu: (close) => textPage("Roles", () => roleLines(ctx), close, Math.max(6, tui.terminal.rows - 12)) },
				// Path's own rows, in the same list: one settings screen for the whole package.
				...(activity?.momRows(ctx, tui) ?? [{ id: "mom", section: "Path", label: "Path", value: () => "not connected",
					help: "Path is not connected yet. Its settings are listed here once its saved view has loaded." }]),
				{ id: "restore", section: "Reset", label: "Restore defaults", value: () => "",
					help: "Set delegation, todo, and recap settings above back to their defaults. Path's settings, approved role models and ratings are kept.",
					action: async () => {
						settings = await saveDelegateSettings({ ...DEFAULT_DELEGATE_SETTINGS }, SETTINGS_PATH);
						todoSettings = await saveTodoSettings({ ...DEFAULT_TODO_SETTINGS }, SETTINGS_PATH);
						recapSettings = await saveRecapSettings({ ...DEFAULT_RECAP_SETTINGS }, SETTINGS_PATH);
						syncMode(ctx);
					} },
			];
			return new SettingsPanel("Delegate settings", rows, () => tui.requestRender(), () => done(), Math.max(6, Math.min(16, tui.terminal.rows - 10)));
		});
	}
	async function openChild(ctx: ExtensionContext, id: string) {
		if (navigationOpen) return;
		navigationOpen = true;
		try {
			const { ChildView, ProcessView } = await import("./inspector.js");
			if (processes.find(id, requireOwner().key)) {
				await ctx.ui.custom<undefined>((tui, theme, _kb, done) => new ProcessView(id, liveSource, theme, tui, () => done(undefined)), FULLSCREEN);
				return;
			}
			await ctx.ui.custom<undefined>(
				(childTui, childTheme, kb, done) => new ChildView(id, liveSource, childTheme, childTui, kb, SettingsManager.create(ctx.cwd, AGENT_DIR), () => done(undefined), childDrafts.get(id) ?? "", (draft) => { childDrafts.set(id, draft); }),
				FULLSCREEN,
			);
		} catch (e) { ctx.ui.notify(`Cannot open child: ${errorMessage(e)}`, "error"); }
		finally { navigationOpen = false; }
	}
	async function openHistory(ctx: ExtensionContext) {
		if (navigationOpen || ctx.mode !== "tui") return;
		const finished = liveSource.all().filter((r) => r.settled);
		if (!finished.length) { ctx.ui.notify("No finished agents.", "info"); return; }
		navigationOpen = true;
		let id: string | undefined;
		try {
			const { AgentHistory } = await import("./inspector.js");
			id = await ctx.ui.custom<string | undefined>(
				(tui, theme, _kb, done) => new AgentHistory(finished, theme, tui, done),
				{ overlay: true, overlayOptions: { width: "90%", maxHeight: "100%", anchor: "center", margin: 1 } },
			);
		} catch (e) { ctx.ui.notify(`Cannot open agent history: ${errorMessage(e)}`, "error"); }
		finally { navigationOpen = false; }
		if (id) await openChild(ctx, id);
	}
	pi.on("session_start", async (_ev, ctx) => {
		try { await attach(ctx); }
		catch (error) { attachError = String(error); ctx.ui.notify(attachError, "error"); return; }
		if (!nesting) syncMode(ctx);
		if (ctx.mode !== "tui") return;
		activity?.install(ctx, liveSource, (id) => openChild(ctx, id));
	});
	// A delegating child has no UI: its commands and shortcut stay the root parent's.
	if (!nesting) {
		// The mode applies from the next turn the person starts, and at session start: no reload.
		pi.on("before_agent_start", (_started, ctx) => { syncMode(ctx); });
		pi.on("tool_call", (event) => {
			if (mode() === "orchestrator" && WRITE_TOOLS.includes(event.toolName)) {
				return { block: true, reason: `Delegation mode is orchestrator: the main session does not ${event.toolName} files. Delegate this change to a writer role (delegate), in the background.` };
			}
			return undefined;
		});
		// A notice is delivered once it is in the conversation. One the run never took in (an abort clears
		// Pi's queues) is sent again when the run settles: shown without a new turn after an abort.
		let aborted = false;
		pi.on("agent_start", () => { aborted = false; });
		pi.on("message_end", (event) => {
			const message = event.message as any;
			if (message.role === "assistant" && message.stopReason === "aborted") aborted = true;
			if (message.role === "custom" && message.customType === "delegate" && owner) inFlight(owner).delete(noticeKey(message));
		});
		pi.on("agent_settled", () => { if (owner?.binding?.pi === pi) redeliver(owner, aborted); });
		// The person's prompt starts a new stretch of work: the Agents frame stops showing runs that settled before it.
		pi.on("input", (event) => { if (event.source === "interactive") { promptAt = Date.now(); activity?.markPrompt(); } });
		pi.registerEntryRenderer<DealsDetails>("pi-delegate.deals", (entry, opts, theme) =>
			framed((width) => resultView("OpenRouter", "deals", "", { content: [], details: entry.data }, opts, theme, width)));
		pi.registerCommand("deals", {
			description: "Find OpenRouter promotions and frontier/light value without calling a model (/deals [model substring])",
			handler: async (args, ctx) => {
				try {
					const filter = args.trim();
					let details = await discoverDeals(ctx, filter);
					if (ctx.mode === "tui") {
						const { DealSheet } = await import("./deals-sheet.js");
						details = await ctx.ui.custom<DealsDetails>((tui, theme, _keys, done) =>
							new DealSheet(details, filter, theme, tui, done, () => discoverDeals(ctx, filter, undefined, true)),
							FULLSCREEN);
					}
					// Custom entries render in chat but are excluded from the model context.
					pi.appendEntry("pi-delegate.deals", details);
				} catch (e) { ctx.ui.notify(String(e), "error"); }
			},
		});
		pi.registerCommand("agents", {
			description: "Open finished delegate history without restarting children",
			handler: async (_args, ctx) => { await openHistory(ctx); },
		});
		pi.registerCommand("delegate", {
			description: "Delegate settings (mode, limits, model picking, roles, Path) · fork:<role> <task> · fresh:<role> <task>",
			getArgumentCompletions: (prefix) => {
				const ctx = owner?.binding?.ctx;
				const roles = ctx ? sortedRoles(ctx) : [];
				const items = [{ value: "settings", label: "settings", description: "Every pi-delegate setting, below the prompt" },
					...roles.flatMap((r) => (["fork", "fresh"] as const).map((kind) => ({ value: `${kind}:${r.name} `, label: `${kind}:${r.name}`,
						description: `${kind === "fork" ? "with this conversation" : "no conversation"} · ${r.description}` })))];
				const matching = items.filter((item) => item.value.startsWith(prefix.trim()));
				return matching.length ? matching : null;
			},
			handler: async (args, ctx) => {
				const text = args.trim();
				const launch = /^(fork|fresh):(\S+)\s+([\s\S]+)$/.exec(text);
				try {
					if (!text || text === "settings") { await openSettings(ctx); return; }
					if (!launch) throw new Error("Use /delegate settings, /delegate fork:<role> <task>, or /delegate fresh:<role> <task>.");
					const [, context, role, task] = launch;
					// A child calls MCP tools through this session's last tool context; a command has none of its own.
					if (!toolContext) ctx.ui.notify("This child has no MCP tools: they reach a child through this session's tools, which pi-delegate sees once the model has called delegate or delegate_ctl here.", "warning");
					const result = await delegateTool.execute("user-command", { role, task, context }, undefined, undefined, ctx);
					const run = result.details?.id ? runs.get(result.details.id) : undefined;
					if (run && !result.isError) { run.userStarted = true; saveRun(run); changed(); }
					ctx.ui.notify(result.content?.[0]?.text ?? "delegate returned nothing", result.isError ? "error" : "info");
				} catch (error) { ctx.ui.notify(errorMessage(error), "error"); }
			},
		});
		// Ctrl+J is also Pi's default secondary newline (tui.input.newLine), so Pi reports the override
		// at startup until the user drops ctrl+j from that action in keybindings.json (see README).
		pi.registerShortcut("ctrl+j", {
			description: "Focus active delegates, or open finished history when idle",
			handler: async (ctx) => {
				if (navigationOpen) return;
				if (liveSource.all().some((r) => !r.settled) || liveSource.processes?.().length) activity?.focusAgents();
				else await openHistory(ctx);
			},
		});
	}

	async function shutdown(reason: string) {
		activity?.dispose();
		// A delegating child's ACP runs, as they stand, while its binding can still read them: parking them
		// waits on the Coordinator, and the root's tree keeps showing them meanwhile.
		const leaving = reason !== "reload" && owner?.parentRun && owner.binding?.pi === pi
			? { parentId: owner.parentRun.id, acp: acp.owned(owner.key).map((view) => ({ view, activity: acp.activity(view.id) })) } : undefined;
		if (leaving) departed.set(leaving.parentId, { pi: departed.get(leaving.parentId)?.pi ?? [], acp: leaving.acp });
		const previous = owner;
		owner = undefined;
		if (!previous || previous.binding?.pi !== pi) return;
		previous.binding = undefined;
		// A reload replaces only the binding. Actual exit/session replacement settles and parks children,
		// and releases this parent's ACP sessions before the Coordinator shuts down.
		if (reason !== "reload") {
			// A revival of this child waits for this close: reopening mid-close would restore ACP runs that
			// the close then parks out from under the steer.
			const closed = (async () => {
				try { await closeOwner(previous); }
				finally {
					await processes.closeOwner(previous.key);
					const parked = await acp.closeOwner(previous.key);
					if (leaving && departed.has(leaving.parentId)) departed.set(leaving.parentId, { pi: departed.get(leaving.parentId)!.pi, acp: parked });
				}
			})();
			if (leaving) closingChildren.set(leaving.parentId, closed);
			try { await closed; }
			finally {
				if (leaving && closingChildren.get(leaving.parentId) === closed) closingChildren.delete(leaving.parentId);
				// The Coordinator stays while another parent may hold runs, including when Oven release failed.
				if (!state.owners.size) await shutdownAcpCoordinator();
			}
		}
	}
	// A nested instance gets this too: closeSession emits it before disposing a child's session.
	pi.on("session_shutdown", async (event) => { await shutdown(event.reason); });
	return liveSource;
}
