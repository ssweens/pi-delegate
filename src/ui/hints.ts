/**
 * Key hints built from Pi's keybindings, so a remapped key reads right. Plain text: the frame paints a legend dim, so
 * Pi's own `keyHint` colours (a dim key, a muted word) would fight it. Arrows are shown as arrows.
 */
import { keyText } from "@earendil-works/pi-coding-agent";

const DISPLAY: Record<string, string> = { up: "↑", down: "↓", left: "←", right: "→", escape: "Esc", pageup: "PgUp", pagedown: "PgDn", enter: "Enter", tab: "Tab", home: "Home", end: "End" };

/** One chord as it reads on screen: `ctrl+shift+j` → `Ctrl+Shift+J`, `escape` → `Esc`. */
export const chordLabel = (chord: string): string =>
	chord.split("+").map(part => DISPLAY[part.toLowerCase()] ?? part.charAt(0).toUpperCase() + part.slice(1)).join("+");

/** The first key bound to a Pi action, as it reads on screen. */
export const keyLabel = (action: Parameters<typeof keyText>[0]): string => chordLabel(keyText(action).split("/")[0] ?? "");

/** `↑↓` and `PgUp/PgDn`: the pairs hints name together. */
export const upDown = (): string => `${keyLabel("tui.select.up")}${keyLabel("tui.select.down")}`;
export const pageKeys = (): string => `${keyLabel("tui.select.pageUp")}/${keyLabel("tui.select.pageDown")}`;
const LEFT = () => keyLabel("tui.editor.cursorLeft"), RIGHT = () => keyLabel("tui.editor.cursorRight");

/** The hint phrases the panels share; join them with ` · `. */
export const hint = {
	move: (word: string) => `${upDown()} ${word}`,
	enter: (word: string) => `${keyLabel("tui.select.confirm")} ${word}`,
	cancel: (word: string) => `${keyLabel("tui.select.cancel")} ${word}`,
	left: (word: string) => `${LEFT()} ${word}`,
	right: (word: string) => `${RIGHT()} ${word}`,
	scroll: () => `${pageKeys()} scroll`,
	chord: (chord: string, word: string) => `${chordLabel(chord)} ${word}`,
} as const;

export const joinHints = (...parts: (string | false | undefined)[]): string => parts.filter(Boolean).join(" · ");

/** Help for browsing Path's map, shared by the map view and the rebuild review. */
export const graphHints = {
	expand: () => hint.right("expand/collapse"),
	parent: (word = "parent") => hint.left(word),
};

/** The Agents list's hint while it has focus. */
export const agentListHint = (): string => joinHints(hint.move("select"), hint.right("open"), hint.left("editor"));
