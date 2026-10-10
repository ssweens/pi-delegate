import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { SessionReader } from "./feed.ts";
import { DEFAULT_BOOTSTRAP_POLICY } from "./bootstrap.ts";
import { settingsLine, type MomSettings } from "./engine.ts";
import { endpoint } from "./advisor.ts";
import { DEFAULT_MODEL, thinkingFor } from "./mother.ts";
import { modeFor, modeInstructions } from "./modes.ts";

export interface SessionIdentity { cwd: string; sessionFile: string; sessionId: string }

/** One Mom per lead session: the same key for the same project, session file and session. Her slice in oven has this key. */
export const ownerKey = (identity: SessionIdentity) => createHash("sha256").update(JSON.stringify([identity.cwd, identity.sessionFile, identity.sessionId])).digest("hex").slice(0, 32);

export function identityOf(manager: Pick<SessionReader, "getCwd" | "getSessionFile" | "getSessionId">, cwd = manager.getCwd()): SessionIdentity {
	const file = manager.getSessionFile();
	if (!file) throw new Error("Mom needs a persisted Pi session.");
	return { cwd: realpathSync(cwd), sessionFile: join(realpathSync(dirname(file)), basename(file)), sessionId: manager.getSessionId() };
}

/** How every operation runs, after her standing instructions. */
/** M1 will select a mode at this prompt/configuration boundary; the frozen D2 baseline stays commit_graph-only. */
export const OPERATION_PROMPT = `
Every message you receive starts one operation: new activity in the lead's session, or a request from the user's session. Call mom_begin first, alone. When it reports nothing to do, stop without another call. Otherwise its result is your task (with any guidance for this operation): inspect evidence as needed, and finish with exactly one finalizer as a sole direct call: commit_graph (commit_graph {} when nothing changed).
`;

/** Mom's bounded domain tools. Native filesystem and shell tools let a small local model leave the operation and wander. */
export const MOM_TOOLS = ["mom_begin", "commit_graph", "commit_v2", "commit_labels", "record_thread_map", "inspect_evidence", "search_history"] as const;

const number = (value: unknown, fallback: number) => { const n = Number(value); return value !== "" && Number.isFinite(n) && n >= 0 ? n : fallback; };

/**
 * Mom's configuration in oven: her model and instructions, her extensions, and a follow of the lead's
 * session file, so oven delivers new lead activity to her (a fresh context each time) and retries her
 * failed turns. The `--mom-*` flags become its settings.
 */
export interface ClassifierRegistry {
	findOfType?(type: "classifier", provider: string, model: string): { id: string; api: string; baseUrl?: string } | undefined;
}

/** Resolve a Pi classifier model to its System One endpoint; model addresses stay in Pi's registry. */
export function resolveClassifier(registry: ClassifierRegistry | undefined, ref: string): { url: string; model: string } | undefined {
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) return undefined;
	const model = registry?.findOfType?.("classifier", ref.slice(0, slash), ref.slice(slash + 1));
	if (!model?.baseUrl || !model.id || model.api !== "typesafe-system-one") return undefined;
	const base = model.baseUrl.replace(/\/+$/, "");
	const url = /\/systemone$/i.test(base) ? base : `${base}/systemone`;
	try { endpoint(url); } catch { return undefined; }
	return { url, model: model.id };
}

/** The decision model the flags (or Mom's saved control) choose, and its endpoint when Pi can reach it.
 *  An unresolved choice leaves Mom running without one; the client says so, Mom never stops for it. */
export function deciderFor(flags: Record<string, string | boolean | undefined>, registry?: ClassifierRegistry): { ref: string; classifier?: { url: string; model: string } } {
	const ref = String(flags["mom-decider"] ?? "").trim();
	return { ref, ...(ref ? { classifier: resolveClassifier(registry, ref) } : {}) };
}

export function assertSliceSupportsMode(modeName: string | undefined, missingTools: readonly string[] = []): void {
	const mode = modeFor(modeName);
	if (missingTools.includes(mode.finalizer)) throw new Error(`Mom's Oven extension is stale: mode ${mode.name} requires missing tool ${mode.finalizer}. Restart Oven to load the current Mom tools.`);
}

export function momConfiguration(identity: SessionIdentity, flags: Record<string, string | boolean | undefined>, registry?: ClassifierRegistry) {
	const model = String(flags["mom-model"] || DEFAULT_MODEL);
	// The mode is resolved here, at configuration time, so a bad --mom-mode fails loudly at start
	// rather than silently running the default. Unconfigured is byte-identical to before modes.
	const mode = modeFor(String(flags["mom-mode"] ?? ""));
	const retries = String(flags["mom-retry-ms"] ?? "5000,60000,300000").split(",").map(Number);
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
		...(classifier ? { classifier: { ...classifier, timeoutMs: 15000 } } : {}),
	};
	return {
		name: "mom", description: "Mom: keeps the lead session's map of goals, decisions and open work.", model, thinking: thinkingFor(model), context: false,
		instructions: modeInstructions(mode, OPERATION_PROMPT, settingsLine(settings)),
		extensions: ["mom"],
		tools: [...MOM_TOOLS],
		follow: { session: identity.sessionFile, minIntervalMs: number(flags["mom-interval-ms"], 0), maxBatch: 2000, fresh: true,
			turns: { maxWaitMs: number(flags["mom-max-wait-ms"], 1800000) } },
		retry: retries.length && retries.every(value => Number.isFinite(value) && value >= 0) ? retries : [5000, 60000, 300000],
	};
}
