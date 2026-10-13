/** Test doubles for Pi's extension API, temporary directories and deferred promises. Imports no test isolation: terminal-fixture.ts loads inside a real Pi. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** A fresh temporary directory, removed when the test (`t`, a node:test context) or the process ends. */
export function tempDir(prefix: string, t?: { after(fn: () => void): void }): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	const remove = () => rmSync(dir, { recursive: true, force: true });
	if (t) t.after(remove); else process.once("exit", remove);
	return dir;
}

/**
 * `pi` seen through a proxy that records every tool and command the extension registers (`tools`, `commands`)
 * and forwards everything. `overrides(target)` replaces named members, e.g. a flag or a message hook. Pass `{ tools, commands }` to collect into maps you already hold.
 */
export function capturePi<T extends object>(target: T, overrides: (target: any) => Record<string, unknown> = () => ({}), { tools, commands } = { tools: new Map<string, any>(), commands: new Map<string, any>() }) {
	const replaced = overrides(target);
	const pi = new Proxy(target as any, { get(real, key) {
		if (typeof key === "string" && key in replaced) return replaced[key];
		if (key === "registerTool") return (tool: any) => { tools.set(tool.name, tool); return real.registerTool(tool); };
		if (key === "registerCommand") return (name: string, options: any) => { commands.set(name, options); return real.registerCommand(name, options); };
		return real[key];
	} }) as T & ExtensionAPI;
	return { pi, tools, commands };
}

/** A stand-in Pi that records instead of acting: every call by name (`calls`), tools, commands, event handlers, session entries and sent user messages. */
export function fakePi() {
	const calls: string[] = [], sent: string[] = [], entries: { type: string; customType: string; data: unknown }[] = [];
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const members: Record<string, (...args: any[]) => unknown> = {
		on: (event: string, handler: (event: any, ctx: any) => unknown) => { handlers.set(event, [...handlers.get(event) ?? [], handler]); return () => {}; },
		appendEntry: (customType: string, data: unknown) => void entries.push({ type: "custom", customType, data }),
		sendUserMessage: (content: string) => void sent.push(content),
	};
	const recorder = new Proxy({}, { get: (_target, key) => (...args: any[]) => { calls.push(String(key)); return members[String(key)]?.(...args); } });
	const captured = capturePi(recorder);
	const fire = (event: string, payload: unknown, ctx?: unknown) => { for (const handler of handlers.get(event) ?? []) handler(payload, ctx); };
	return { ...captured, calls, handlers, entries, sent, fire };
}

export function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}
