import { AgentSession, type ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Whether a message is queued for the parent's model, whoever sent it. Pi's ctx.hasPendingMessages() counts only
 * what the person typed: a custom message another extension steers into a busy run (pi-intercom, a peer's report)
 * waits in the agent's queue unseen, so a wait that checks only it holds those messages until its runs settle.
 * Extensions share the host's module, so the session that queued one is found here by its session manager, the
 * object ctx.sessionManager is.
 */
const key = Symbol.for("pi-delegate.queued-sessions.v1");
const host = globalThis as typeof globalThis & { [key]?: WeakMap<object, AgentSession> };
// One map and one wrapper per process: a reloaded extension reuses both.
const sessions = host[key] ??= (() => {
	const map = new WeakMap<object, AgentSession>();
	const send = AgentSession.prototype.sendCustomMessage;
	AgentSession.prototype.sendCustomMessage = function (this: AgentSession, ...args: Parameters<typeof send>) {
		map.set(this.sessionManager, this);
		return send.apply(this, args);
	} as typeof send;
	return map;
})();

export const messagesQueued = (ctx: ExtensionContext) => ctx.hasPendingMessages() || Boolean(sessions.get(ctx.sessionManager)?.agent.hasQueuedMessages());
