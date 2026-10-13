import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import type { RebuiltMap } from "../mom/rebuild.ts";
import { errorMessage } from "../util/text.ts";
import { GraphBrowser } from "./graph-browser.ts";
import { graphHints, hint, joinHints, keyLabel } from "./hints.ts";
import { navKeys } from "./keys.ts";
import { fitPad } from "./text.ts";
import type { WorkView } from "./presentation.ts";

/** Browse a completed reconstruction; only the explicit action writes Path's map. */
export class MomRebuildPanel implements Component {
	private browser?: GraphBrowser;
	private savedBrowser?: GraphBrowser;
	private showingSaved = false;
	private phase: "ready" | "saving" | "failed" = "ready";
	private message: string;
	private action = false;
	private details = false;
	private closed = false;

	constructor(private readonly tui: TUI, private readonly theme: Theme, private readonly rows: () => number,
		private readonly candidate: RebuiltMap, private readonly accept: (candidate: RebuiltMap) => Promise<void>,
		private readonly done: (result: "saved" | "cancelled") => void, currentCount: number, saved?: WorkView) {
		this.savedBrowser = saved ? new GraphBrowser(saved) : undefined;
		this.browser = new GraphBrowser(candidate.view);
		this.message = `Rebuilt ${candidate.checkpoint.graph.nodes.length} records in ${candidate.batches} pass${candidate.batches === 1 ? "" : "es"}. Current map: ${currentCount}. Nothing has been replaced.`;
	}

	handleInput(data: string): void {
		if (this.closed || this.phase === "saving") return;
		const nav = navKeys(data);
		if (nav === "cancel") {
			this.closed = true;
			this.done("cancelled");
			return;
		}
		if (this.phase !== "ready" || !this.browser || !this.candidate) return;
		const browser = this.showingSaved ? this.savedBrowser! : this.browser;
		if (this.action) {
			// The action row sits below the map: ↑ or ← returns to the map, Enter saves.
			if (nav === "up") { this.action = false; browser.move(Infinity); }
			else if (nav === "left") this.action = false;
			else if (nav === "confirm") { void this.save(); return; }
			else return;
		} else if (nav === "down") {
			const selected = browser.selected;
			browser.handleKey(data);
			if (!this.showingSaved && selected === browser.selected) this.action = true;
		} else if (nav === "left" && !browser.parentId && this.savedBrowser) this.showingSaved = true;
		else if (nav === "right" && this.showingSaved) this.showingSaved = false;
		else if (nav === "confirm") this.details = !this.details;
		else if (!browser.handleKey(data)) return;
		this.tui.requestRender();
	}

	private async save(): Promise<void> {
		if (!this.candidate || this.phase !== "ready") return;
		this.phase = "saving";
		this.message = "Saving the rebuilt map; its previous checkpoints remain available.";
		this.tui.requestRender();
		try {
			await this.accept(this.candidate);
			this.closed = true;
			this.done("saved");
		} catch (error) {
			this.phase = "failed";
			this.message = errorMessage(error);
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const fit = (line: string) => fitPad(line, width);
		const wrap = (text: string) => wrapTextWithAnsi(text, Math.max(1, width)).map(fit);
		const lines = [fit(this.theme.bold(this.theme.fg("accent", "Path · rebuild from transcript"))), "", ...wrap(this.message).slice(0, 3), ""];
		if (this.phase === "failed") lines.push(...wrap(this.theme.fg("warning", `Saved map unchanged. ${keyLabel("tui.select.cancel")} closes this modal; press B on F3 Status in /path to try again.`)));
		else if (this.browser) {
			const browser = this.showingSaved ? this.savedBrowser! : this.browser;
			lines.push(fit(this.theme.bold(this.showingSaved ? "Current saved map (before rebuild)" : "Rebuilt map (not yet saved)")));
			lines.push(fit(this.theme.fg("muted", this.showingSaved
				? joinHints(hint.move("browse"), hint.right("rebuilt map"), graphHints.parent(), hint.enter("details"), hint.cancel("cancels"))
				: joinHints(hint.move("browse"), graphHints.expand(), graphHints.parent("parent/current map"), hint.enter("details"), hint.cancel("cancels")))), "");
			const selected = browser.details();
			const detailLines = selected.length ? ["", ...selected.slice(0, this.details ? 7 : 2).flatMap(wrap)] : [];
			const footer = ["", fit(this.showingSaved ? this.theme.fg("muted", hint.right("Return to rebuilt map to save it"))
				: this.action ? this.theme.bg("selectedBg", this.theme.bold(`▶ Use rebuilt map · ${keyLabel("tui.select.confirm")}`))
					: this.theme.fg("muted", `  Use rebuilt map · ${keyLabel("tui.select.down")} to select, ${keyLabel("tui.select.confirm")} to save`))];
			const room = Math.max(1, this.rows() - lines.length - detailLines.length - footer.length);
			lines.push(...browser.render(this.theme, width, room), ...detailLines, ...footer);
		}
		const height = Math.max(5, this.rows());
		if (lines.length > height && this.candidate) return [...lines.slice(0, height - 2), ...lines.slice(-2)].map(fit);
		return lines.slice(0, height).map(fit);
	}
	invalidate(): void {}
	dispose(): void { this.closed = true; }
}
