import type { WorkGraph } from "./graph.ts";

export interface AdvisorUsage { input: number; output: number }
/** One settled whole-batch screening question; never a per-message record. */
export interface SessionScreenInput {
	current: WorkGraph;
	newEvidence: string;
	contextBeforeBatch: string | null;
	pendingMore: boolean;
	unresolvedProcessRisks: string[];
}
export interface AdvisorScreen {
	status: "screened";
	model: string;
	needsUpdate: number;
	/** `needsUpdate >= threshold`. A negative verdict can only defer eligible evidence briefly. */
	wake: boolean;
	usage: AdvisorUsage;
	latencyMs: number;
}
/** Fail-open receipt: no verdict was produced, and no verdict is pretended. */
export interface AdvisorScreenUnavailable {
	status: "unavailable";
	model: string;
	error: string;
	latencyMs: number;
}
export type AdvisorScreenRecord = AdvisorScreen | AdvisorScreenUnavailable;
export interface SessionAdvisor {
	readonly model: string;
	readonly threshold: number;
	screen(input: SessionScreenInput, signal?: AbortSignal): Promise<AdvisorScreen>;
}

const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_REQUEST_BYTES = 96 * 1024;
const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_THRESHOLD = 0.25;

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const probability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const nonnegativeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function endpoint(value: string): URL {
	const url = new URL(value);
	const octets = url.hostname.split(".").map(Number);
	const privateAddress = octets.length === 4 && octets.every(part => Number.isSafeInteger(part) && part >= 0 && part <= 255) &&
		(octets[0] === 10 || octets[0] === 127 || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31));
	if (url.protocol !== "http:" || !privateAddress || url.pathname !== "/v1/systemone" || url.username || url.password || url.search || url.hash) {
		throw new Error("Mom advisor URL must be HTTP on a loopback or private IPv4 address and end in /v1/systemone.");
	}
	return url;
}

export async function boundedText(response: Response): Promise<string> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("Mom advisor response exceeds 16 KiB.");
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0, text = "";
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		bytes += value.byteLength;
		if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("Mom advisor response exceeds 16 KiB."); }
		text += decoder.decode(value, { stream: true });
	}
	return text + decoder.decode();
}

function parseScreen(value: unknown, latencyMs: number, threshold: number): AdvisorScreen {
	if (!record(value) || typeof value.model !== "string" || !record(value.answers) || !record(value.usage)) throw new Error("Mom advisor returned an invalid response.");
	const answer = value.answers.needs_update;
	if (!record(answer) || answer.type !== "noul" || !probability(answer.noul)) throw new Error("Mom advisor returned an invalid screen answer.");
	if (!nonnegativeInteger(value.usage.input_tokens) || !nonnegativeInteger(value.usage.output_tokens)) throw new Error("Mom advisor returned invalid usage.");
	return { status: "screened", model: value.model, needsUpdate: answer.noul, wake: answer.noul >= threshold,
		usage: { input: value.usage.input_tokens, output: value.usage.output_tokens }, latencyMs };
}

export class SystemOneAdvisor implements SessionAdvisor {
	readonly model: string;
	readonly threshold: number;
	private readonly url?: URL;
	private readonly timeoutMs: number;
	private readonly configurationError?: string;

	constructor(options: { url: string; model?: string; threshold?: number; timeoutMs?: number }) {
		this.model = options.model?.trim() || "beverly-4B";
		this.threshold = probability(options.threshold) ? options.threshold : DEFAULT_THRESHOLD;
		this.timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs! >= 100 && options.timeoutMs! <= 10000 ? options.timeoutMs! : DEFAULT_TIMEOUT_MS;
		try { this.url = endpoint(options.url); }
		catch (error) { this.configurationError = String(error); }
	}

	async screen(input: SessionScreenInput, signal?: AbortSignal): Promise<AdvisorScreen> {
		const started = performance.now();
		if (this.configurationError || !this.url) throw new Error(this.configurationError ?? "Mom advisor URL is unavailable.");
		const body = JSON.stringify({
			model: this.model,
			state: { current: input.current, newEvidence: input.newEvidence, contextBeforeBatch: input.contextBeforeBatch,
				pendingMore: input.pendingMore, unresolvedProcessRisks: input.unresolvedProcessRisks },
			questions: {
				needs_update: { type: "noul", instructions: "Compare newEvidence with the current work map in state.current. One binary decision: has this settled batch materially moved the session away from what the current work map already records? state.unresolvedProcessRisks are already-open process risks, not movement by themselves.",
					criteria: { true: "Material movement: the batch changes purpose or scope, records or withdraws assent, grants or withdraws a permission or prohibition, changes a return point, or lands an outcome, or it consequentially changes or resolves an unresolved process risk — so the current map would be wrong or incomplete without Mom's update.",
						false: "Status quo: routine mechanical progress, transient wording, or source-level detail with no material purpose, scope, assent, permission, return point, outcome, or process-risk change." } },
			},
		});
		if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new Error("Mom advisor request exceeds 96 KiB.");
		const response = await fetch(this.url, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body,
			signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]) });
		if (!response.ok) throw new Error(`Mom advisor returned HTTP ${response.status}.`);
		const text = await boundedText(response);
		let value: unknown;
		try { value = JSON.parse(text); } catch { throw new Error("Mom advisor returned invalid JSON."); }
		return parseScreen(value, Math.round(performance.now() - started), this.threshold);
	}
}

export function isAdvisorScreenRecord(value: unknown): value is AdvisorScreenRecord {
	if (!record(value) || typeof value.model !== "string" || typeof value.latencyMs !== "number" ||
		!Number.isFinite(value.latencyMs) || value.latencyMs < 0) return false;
	if (value.status === "unavailable") return typeof value.error === "string";
	if (value.status !== "screened" || !probability(value.needsUpdate) || typeof value.wake !== "boolean") return false;
	if (!record(value.usage)) return false;
	return nonnegativeInteger(value.usage.input) && nonnegativeInteger(value.usage.output);
}
