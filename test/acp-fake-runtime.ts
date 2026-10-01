/**
 * An in-process ACP runtime for AcpBackend tests: created sessions only, every call recorded.
 * A prompt that starts with WAIT runs until it is cancelled; any other prompt completes at once
 * with "ACK". A session "resumes" by returning the session ID it was asked for.
 */
import type { NormalizedEvent, Profile, RuntimeHandle, RuntimePort, RuntimeTerminal, RuntimeTurn } from "../src/acp/domain/types.ts";

export interface FakeCalls {
	ensure: { name: string; resumeSessionId?: string }[];
	resume: string[];
	close: string[];
	cancel: string[];
}

export function fakeRuntime(calls: FakeCalls = { ensure: [], resume: [], close: [], cancel: [] }) {
	const handle = (name: string, sessionId: string): RuntimeHandle => ({ sessionKey: `fake:${name}`, backend: "fake", runtimeSessionName: name, backendSessionId: sessionId });
	const turn = (prompt: string, requestId: string): RuntimeTurn => {
		let finish!: (terminal: RuntimeTerminal) => void;
		const result = new Promise<RuntimeTerminal>((resolve) => { finish = resolve; });
		const waits = prompt.startsWith("WAIT");
		if (!waits) setImmediate(() => finish({ status: "completed", stopReason: "end_turn" }));
		async function* events(): AsyncGenerator<NormalizedEvent> {
			if (!waits) yield { type: "text", text: "ACK", stream: "output" };
			await result;
		}
		return {
			requestId, result, events: events(),
			async cancel() { calls.cancel.push(requestId); finish({ status: "cancelled", stopReason: "cancelled" }); },
			async closeStream() {},
		};
	};
	const port = (): RuntimePort => ({
		async ensureSession(input: { name: string; resumeSessionId?: string }) {
			calls.ensure.push({ name: input.name, ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}) });
			return handle(input.name, input.resumeSessionId ?? `sess-${input.name}`);
		},
		async resumeSession(input: { name: string; sessionId: string }) { calls.resume.push(input.name); return handle(input.name, input.sessionId); },
		startTurn: (input: { prompt: string; requestId: string }) => turn(input.prompt, input.requestId),
		async close(h: RuntimeHandle) { calls.close.push(h.runtimeSessionName); },
	});
	return { calls, factory: (_cwd: string, _stateDir: string, _profile: Profile) => port() };
}
