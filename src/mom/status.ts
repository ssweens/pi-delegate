const STATUS_PING =
	/^\s*(?:\?+|status\??|next\??|what'?s next\??|where are we\??|where are things\??|what are you doing\??|what'?s going on\??|what'?s up\??|progress\??|eta\??|how'?s it going\??)\s*[.!]*\s*$/i;
// A question about the state of the work: Mom answers it. Only status, progress and what-is-happening
// questions match — an ask for a deliverable does not, and neither does a long message.
const MOM_QUESTION = /^[^\n]{0,80}?\b(?:where are we|how are we|how'?s it going|how'?s (?:it|things|the work|progress)|what'?s (?:next|the status|going on|up|happening|taking so long|left)|what is (?:the status|taking so long|left|going on)|are we (?:done|there|finished|ready|good|close)|is (?:it|this|that|everything|the work) (?:done|finished|ready|fixed|in place|working|still (?:running|going|working))|should i be seeing|are things (?:still |going |working |moving )|any progress|getting (?:fixed|done|there|close)|why is (?:it|this|everything) taking|how much longer|what (?:the fuck |the hell )?is taking so long|what happened|what went wrong|what are you (?:doing|working on)|what (?:the fuck |the hell )?are you waiting for|what (?:the fuck |the hell )?is .{0,48} for)\b[^\n]{0,80}$/i;
// An ask for a deliverable is work for the lead, not a question for Mom.
const WORK_ASK = /\b(?:please|can you|could you|would you|will you|help me|gonna need you to|make sure|ensure|add|build|create|remove|delete|fix|update|implement|write|refactor|redesign|rework|replace|investigate|walk me|think through|show me|give me)\b/i;

/** True when the whole message is a question about the state of the work — Mom answers it, it is not a direction. */
export function isStatusPing(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed || trimmed.length > 240 || trimmed.includes("\n")) return false;
	if (WORK_ASK.test(trimmed)) return false;
	return STATUS_PING.test(trimmed) || MOM_QUESTION.test(trimmed);
}

export function formatElapsed(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Keep the actionable cause visible; full provider/file diagnostics belong in details. */
export function updateErrorSummary(error: string): string {
	if (/Graph transaction (defects|rejected)/.test(error)) return "The proposed notes did not pass consistency checks.";
	if (error.includes("Mom evidence remained unreadable")) return "An update was rejected while some source files were unavailable.";
	if (error.includes("ENOENT")) return "A file Mom needs is missing.";
	if (error.includes("Unchanged needs an existing map")) return "Mom's no-change reply could not be accepted.";
	if (/finished without an accepted.*graph transaction/.test(error)) return "Mom returned no usable update.";
	const message = error.replace(/^Error:\s*/, "").replace(/\s+/g, " ").trim();
	return message.length > 200 ? `${message.slice(0, 197)}…` : message;
}
