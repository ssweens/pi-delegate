import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { splitModelRef } from "../model-ref.ts";
import type { SessionReader } from "./feed.ts";
import { DEFAULT_BOOTSTRAP_POLICY } from "./bootstrap.ts";
import { settingsLine, type MomSettings } from "./engine.ts";
import { endpoint } from "./advisor.ts";
import { DEFAULT_MODEL, thinkingFor } from "./mother.ts";
import { modeFor, modeInstructions } from "./modes.ts";
import { TRAIL_OPERATION, TRAIL_PROMPT, WATCHER_EXTENSION, watcherLine } from "../trail/prompt.ts";

export interface SessionIdentity { cwd: string; sessionFile: string; sessionId: string }

/** One Path per lead session: the same key for the same project, session file and session. Its slice in oven has this key. */
export const ownerKey = (identity: SessionIdentity) => createHash("sha256").update(JSON.stringify([identity.cwd, identity.sessionFile, identity.sessionId])).digest("hex").slice(0, 32);

export function identityOf(manager: Pick<SessionReader, "getCwd" | "getSessionFile" | "getSessionId">, cwd = manager.getCwd()): SessionIdentity {
	const file = manager.getSessionFile();
	if (!file) throw new Error("Path needs a persisted Pi session.");
	return { cwd: realpathSync(cwd), sessionFile: join(realpathSync(dirname(file)), basename(file)), sessionId: manager.getSessionId() };
}

/** How every operation runs, after its standing instructions. */
/** M1 will select a mode at this prompt/configuration boundary; the frozen D2 baseline stays commit_graph-only. */
export const OPERATION_PROMPT = `
Every message you receive starts one operation: new activity in the lead's session, or a request from the user's session. Call mom_begin first, alone. When it reports nothing to do, stop without another call. Otherwise its result is your task (with any guidance for this operation): inspect evidence as needed, and finish with exactly one finalizer as a sole direct call: commit_graph (commit_graph {} when nothing changed).
`;

/** Path's bounded domain tools. Native filesystem and shell tools let a small local model leave the operation and wander. */
export const MOM_TOOLS = ["mom_begin", "commit_graph", "commit_v2", "commit_labels", "record_thread_map", "record_waypoints", "inspect_evidence", "search_history"] as const;

const number = (value: unknown, fallback: number) => { const n = Number(value); return value !== "" && Number.isFinite(n) && n >= 0 ? n : fallback; };

/**
 * Path's configuration in oven: its model and instructions, its extensions, and a follow of the lead's
 * session file, so oven delivers new lead activity to it (a fresh context each time) and retries its
 * failed turns. The `--path-*` flags become its settings.
 */
export interface ClassifierRegistry {
	findOfType?(type: "classifier", provider: string, model: string): { id: string; api: string; baseUrl?: string } | undefined;
	/** Any model Pi knows: a decision model its inference server did not tag as a classifier is found here. */
	find?(provider: string, model: string): { id: string; api: string; baseUrl?: string } | undefined;
}

/**
 * Resolve a decision model to its System One endpoint; model addresses stay in Pi's registry. A model tagged as a
 * classifier must speak System One; an untagged one (a server that does not tag its decision models) is taken at
 * its address, and the endpoint check still keeps it on a loopback or private IPv4 host.
 */
export function resolveClassifier(registry: ClassifierRegistry | undefined, ref: string): { url: string; model: string } | undefined {
	const split = splitModelRef(ref);
	if (!split) return undefined;
	const { provider, id } = split;
	const tagged = registry?.findOfType?.("classifier", provider, id);
	if (tagged && tagged.api !== "typesafe-system-one") return undefined;
	const model = tagged ?? registry?.find?.(provider, id);
	if (!model?.baseUrl || !model.id) return undefined;
	const base = model.baseUrl.replace(/\/+$/, "");
	const url = /\/systemone$/i.test(base) ? base : `${base.replace(/\/v1$/i, "")}/v1/systemone`;
	try { endpoint(url); } catch { return undefined; }
	return { url, model: model.id };
}

/** The decision model the flags (or Path's saved control) choose, and its endpoint when Pi can reach it.
 *  An unresolved choice leaves Path running without one; the client says so, Path never stops for it. */
export function deciderFor(flags: Record<string, string | boolean | undefined>, registry?: ClassifierRegistry): { ref: string; classifier?: { url: string; model: string } } {
	const ref = String(flags["mom-decider"] ?? "").trim();
	return { ref, ...(ref ? { classifier: resolveClassifier(registry, ref) } : {}) };
}

export function assertSliceSupportsMode(modeName: string | undefined, missingTools: readonly string[] = []): void {
	const mode = modeFor(modeName);
	if (missingTools.includes(mode.finalizer)) throw new Error(`Path's Oven extension is stale: mode ${mode.name} requires missing tool ${mode.finalizer}. Restart Oven to load the current Path tools.`);
}

/** Entries one delivery to the trail watcher holds: a long backlog arrives in pieces of this many. */
export const WATCHER_BATCH = 200;

export function momConfiguration(identity: SessionIdentity, flags: Record<string, string | boolean | undefined>, registry?: ClassifierRegistry, watch: { after?: string } = {}) {
	const model = String(flags["mom-model"] || DEFAULT_MODEL);
	// The mode is resolved here, at configuration time, so a bad --path-mode fails loudly at start
	// rather than silently running the default. Unconfigured is byte-identical to before modes.
	const mode = modeFor(String(flags["mom-mode"] ?? ""));
	const retries = String(flags["mom-retry-ms"] ?? "5000,60000,300000").split(",").map(Number);
	const retry = retries.length && retries.every(value => Number.isFinite(value) && value >= 0) ? retries : [5000, 60000, 300000];
	const turns = { maxWaitMs: number(flags["mom-max-wait-ms"], 1800000), userWindowMs: number(flags["mom-user-window-ms"], 120000) };
	// The trail: a watcher with its own memory of the session (src/trail/watcher.ts). It reads every delivery as is,
	// keeps what it saw (no fresh context per delivery) and has one tool.
	if (mode.name === "trail") return {
		name: "path", description: "Path: watches the lead session and keeps its trail.", model, thinking: thinkingFor(model), context: false,
		instructions: `${TRAIL_PROMPT.trim()}\n\n${TRAIL_OPERATION.trim()}\n\n${watcherLine(identity.sessionFile)}`,
		extensions: [WATCHER_EXTENSION], tools: ["record_waypoints"],
		follow: { session: identity.sessionFile, minIntervalMs: number(flags["mom-interval-ms"], 0), maxBatch: WATCHER_BATCH, turns, ...(watch.after ? { after: watch.after } : {}) },
		retry,
	};
	const chapters = Number(flags["mom-bootstrap-chapters"] ?? DEFAULT_BOOTSTRAP_POLICY.maxChapters);
	const chars = Number(flags["mom-bootstrap-chars"] ?? DEFAULT_BOOTSTRAP_POLICY.maxDigestChars);
	const advisorUrl = String(flags["mom-advisor-url"] ?? "").trim();
	const deciderUrl = String(flags["mom-decider-url"] ?? "").trim();
	const { classifier } = deciderFor(flags, registry);
	const bootstrapOff = String(flags["mom-bootstrap"] ?? "1") === "0";
	const settings: MomSettings = {
		...(mode.name !== "commit_graph" ? { mapMode: mode.name } : {}),
		bootstrap: bootstrapOff ? false : Number.isSafeInteger(chapters) && chapters > 0 && Number.isSafeInteger(chars) && chars > 0
			? { ...DEFAULT_BOOTSTRAP_POLICY, maxChapters: chapters, maxDigestChars: chars } : DEFAULT_BOOTSTRAP_POLICY,
		...(advisorUrl ? { advisor: { url: advisorUrl, model: String(flags["mom-advisor-model"] ?? "beverly-4B"),
			threshold: number(flags["mom-advisor-threshold"], 0.25), timeoutMs: number(flags["mom-advisor-timeout-ms"], 1500) } } : {}),
		...(deciderUrl ? { decider: { url: deciderUrl, clear: number(flags["mom-decider-clear"], 0.9) } } : {}),
		...(classifier ? { classifier: { ...classifier, timeoutMs: 120000 } } : {}),
	};
	return {
		name: "mom", description: "Path: keeps the lead session's map of goals, decisions and open work.", model, thinking: thinkingFor(model), context: false,
		instructions: modeInstructions(mode, OPERATION_PROMPT, settingsLine(settings)),
		extensions: ["mom"],
		tools: [...MOM_TOOLS],
		follow: { session: identity.sessionFile, minIntervalMs: number(flags["mom-interval-ms"], 0), maxBatch: 2000, fresh: true,
			turns },
		retry,
	};
}
