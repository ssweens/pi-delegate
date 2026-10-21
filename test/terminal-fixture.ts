import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import delegate from "../src/index.ts";
import { capturePi } from "./capture.ts";
import { activityFor } from "../src/ui/activity.ts";
import { momSettings } from "../src/mom/settings.ts";
import { MomClient } from "../src/mom/client.ts";
import { loadState } from "../src/mom/checkpoint.ts";
import { glance } from "../src/trail/projection.ts";

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
	const trail = { waypoints: [{ id: "fixture:w1", sessionId: "fixture", at: Date.now(), kind: "set_out" as const,
		line: "Terminal verification", caption: "Verify the original Path tabs", refs: [], parent: null, by: "mom" as const }], struck: [] };
	// Replace the remote Path backend, not its opener, tab view, diagnostics, or SettingsPanel.
	MomClient.prototype.connect = async function () {
		this.state = await loadState({ load: async () => [] } as any, { getBranch: () => [] } as any);
		this.state.mode = "trail";
	};
	MomClient.prototype.reload = async function () {};
	Object.defineProperty(MomClient.prototype, "trail", { get: () => trail });
	MomClient.prototype.view = () => ({ status: "up to date", summary: "Verify the original Path tabs", trail: { glance: glance(trail), count: 1 } });
	MomClient.prototype.request = async function (command) {
		if (command.kind === "controls") { Object.assign(this.state!, command.change); trace({ event: "path-controls", change: command.change }); }
		return this.snapshot;
	};
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
	pi.registerCommand("fixture-activity", { handler: async (_args: string, ctx: any) => {
		const activity = activityFor(captured);
		if (_args.trim() === "clear") { activity.setTodos({ phases: [] }); return; }
		ctx.ui.setEditorText("OVERVIEW-PARENT-DRAFT");
		activity.setTodos({ phases: [
			{ name: "Closed phase", tasks: [{ content: "Completed-only task", status: "completed" }] },
			{ name: "Abandoned phase", tasks: [{ content: "Abandoned-only task", status: "abandoned" }] },
			{ name: "Empty phase", tasks: [] },
			{ name: "Current phase", tasks: [
				{ content: "Pending task", status: "pending" }, { content: "Active task", status: "in_progress" },
				{ content: "Blocked task with full content ending TASK-END", status: "blocked", blocker: `${"Long blocker detail ".repeat(12)}BLOCKER-END` },
				...Array.from({ length: 24 }, (_, i) => ({ content: `Overview task ${i + 1}`, status: "pending" as const })),
			] },
		] });
		activity.setRecap(`${"Full recap detail ".repeat(40)}RECAP-END`);
		const unsubscribe = ctx.ui.onTerminalInput((data: string) => {
			if (data !== "!") return;
			activity.setTodos({ phases: [{ name: "Settled live phase", tasks: [{ content: "LIVE-COMPLETED-TASK", status: "completed" }] }, { name: "Live empty phase", tasks: [] }] });
			activity.setRecap("LIVE-RECAP-END");
			unsubscribe();
			return { consume: true };
		});
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
