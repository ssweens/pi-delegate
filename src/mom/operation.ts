import type { AdvisorScreenRecord } from "./advisor.ts";
import type { Cut, FeedEvent } from "./feed.ts";
import type { SpecOp } from "./v2.ts";

/**
 * One Path step as its tools in oven see it: the header its tools read (from the first
 * message of the operation's fresh context) and the lead reads back after a reload. Everything else its
 * tools need is in the session file and its `.mom` file. The model never sees the header.
 */
export type OperationMode = "update" | "audit" | "check";

export interface OperationHeader {
	job: string;
	/** One fresh context per step: `map`, `audit-<n>`, or `check-<hash>`. */
	step: string;
	mode: OperationMode;
	/** Pinned at preparation, independent of later settings changes. */
	mapMode?: string;
	/** This is a host-compressed historical catch-up, not a frontier update. */
	digest?: boolean;
	/** This request repairs existing model labels without changing graph structure or evidence. */
	relabel?: boolean;
	/** A trail relabel that revises the whole trail from its own entries (`/path reindex`), not just titles. */
	repair?: boolean;
	session: { file: string; id: string; cwd: string; leaf: string | null };
	/** Evidence boundary: the feed its tools rebuild, and the coverage an accepted map records. */
	cut?: Cut;
	from?: Cut;
	/** The batch's evidence refs, in order: what it must review. */
	refs: string[];
	more?: boolean;
	gaps?: number;
	retryGap?: { id: string; remaining: string[] };
	/** Trail: the backfill range acceptance writes (new, advanced, or null when done). */
	backfill?: { id: string; next: string; through: string } | null;
	/** Trail: this operation indexes older history, not the live frontier. */
	backfilling?: boolean;
	/** A compaction review: its trigger is known evidence beyond the session's own entries. */
	trigger?: FeedEvent;
	auditedGaps?: string[];
	/** v2: the ops the decision model decided, when it read this batch. Its finalizer is checked
	 *  against them; absent means the batch ran with structural checks alone. */
	spec?: SpecOp[];
	screen?: AdvisorScreenRecord;
	/** The lead's own evidence could not be read; an empty commit cannot certify the batch. */
	leadUnreadable?: boolean;
	/** Audit steps: the chapters this section must state. */
	section?: { actor: string; chapterIds: string[]; sources?: Record<string, string>; needsInspection?: boolean };
}

const KEY = "mom", TEXT = "$text";

/** The first message of a step: the header, then the body (an object, or text the model sees as is). */
export const encodeOperation = (header: OperationHeader, body: Record<string, unknown> | string) =>
	JSON.stringify({ [KEY]: header, ...(typeof body === "string" ? { [TEXT]: body } : body) });

/** The header of an operation message, and the message as the model sees it (without the header). */
export function decodeOperation(text: string): { header?: OperationHeader; text: string } {
	if (!text.startsWith(`{"${KEY}":`)) return { text };
	try {
		const { [KEY]: header, ...body } = JSON.parse(text);
		return { header, text: typeof body[TEXT] === "string" ? body[TEXT] : JSON.stringify(body) };
	} catch { return { text }; }
}

/** A tool result that ends the operation because Path's own tooling failed, not because its notes were rejected. */
export const OPERATION_FAILED = "Path operation failed: ";

/** What the user did with Path's finding. */
export type FindingRequest = "understood" | "dismiss" | "incorrect" | "discuss";

/** What the lead's client asks of Path's slice; the session names the lead's session file. */
export type MomRequest =
	| { kind: "update" }
	| { kind: "refresh" }
	| { kind: "rebuild" }
	| { kind: "relabel"; repair?: boolean }
	| { kind: "resume" }
	| { kind: "controls"; id: string; change: { inject: boolean } | { nudgedClasses: string[] } | { enabled: boolean } | { mode: string } | { model: string } | { decider: string } }
	| { kind: "finding"; action: FindingRequest; finding: string };
const REQUEST = "mom.request";
export const encodeRequest = (session: string, request: MomRequest) => JSON.stringify({ [REQUEST]: { session, ...request } });

/** The prefix of oven's delivery of new entries of a followed Pi session. */
const DELIVERY = /^New entries in the followed Pi session (.+?) \(\d+: /;

/** How a message starts an operation: a delivery of new lead entries, a request, or a step's header. */
export type OperationStart =
	| { kind: "delivery"; session: string }
	| { kind: "request"; session: string; request: MomRequest }
	| { kind: "step"; header: OperationHeader };
export function decodeStart(text: string): OperationStart | undefined {
	const delivery = DELIVERY.exec(text);
	if (delivery) return { kind: "delivery", session: delivery[1] };
	if (text.startsWith(`{"${REQUEST}":`)) {
		try { const { session, ...request } = JSON.parse(text)[REQUEST]; return typeof session === "string" ? { kind: "request", session, request } : undefined; } catch { return undefined; }
	}
	const header = decodeOperation(text).header;
	return header ? { kind: "step", header } : undefined;
}
