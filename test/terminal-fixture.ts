import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import delegate from "../src/index.ts";
import { capturePi } from "./capture.ts";
import { momSettings } from "../src/mom/settings.ts";

/** Commands only control the fixture. All rendering and child work are the actual extension. */
export default function (pi: any) {
	const root = process.env.DELEGATE_SMOKE_ROOT!;
	const trace = (event: any) => appendFileSync(join(root, "trace.jsonl"), JSON.stringify(event) + "\n");
	const { pi: captured, tools } = capturePi(pi, (target) => ({
		sendMessage: (message: any, options: any) => {
			trace({ event: "complete", details: message.details });
			// This UI-only probe renders/persists real results without an unrelated parent reply.
			// Automatic wake-up is checked separately in lifecycle.test.ts.
			return target.sendMessage(message, { ...options, triggerTurn: false });
		},
	}));
	delegate(captured);
	pi.on("session_start", (_event: any, ctx: any) => {
		writeFileSync(join(root, "parent.json"), JSON.stringify({ file: ctx.sessionManager.getSessionFile() }));
		ctx.ui.setStatus("fixture", "FIXTURE-READY");
	});
	pi.registerCommand("fixture-mom-settings", { handler: async (_args: string, ctx: any) => {
		await ctx.ui.custom((tui: any, _theme: any, _keys: any, done: () => void) => momSettings(
			{ enabled: true, inject: false, hush: false, nudgedClasses: [], mode: "", model: "", decider: "" },
			async () => {}, () => tui.requestRender(), () => done(), 12),
		{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 } });
	} });
	pi.registerCommand("fixture-join", { handler: async (args: string, ctx: any) => {
		const result = await tools.get("delegate_ctl").execute("fixture", { action: "wait", runId: args.trim() }, undefined, undefined, ctx);
		trace({ event: "joined", details: result.details });
	} });
	pi.registerCommand("fixture-spawn", { handler: async (args: string, ctx: any) => {
		const result = await tools.get("delegate").execute("fixture", { role: "scout", model: "fixture/fixture:off", context: "fresh", cwd: ctx.cwd, task: args || "Native detail" }, undefined, undefined, ctx);
		trace({ event: "launch", details: result.details });
	} });
}
