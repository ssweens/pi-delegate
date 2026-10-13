/** Navigation keys through Pi's keybinding action names, so a user's remapped keys work in every panel. */
import { getKeybindings } from "@earendil-works/pi-tui";

export type Nav = "up" | "down" | "pageUp" | "pageDown" | "confirm" | "cancel" | "left" | "right" | "home" | "end";

const ACTIONS: readonly (readonly [Nav, string])[] = [
	["up", "tui.select.up"], ["down", "tui.select.down"], ["pageUp", "tui.select.pageUp"], ["pageDown", "tui.select.pageDown"],
	["confirm", "tui.select.confirm"], ["cancel", "tui.select.cancel"],
	["left", "tui.editor.cursorLeft"], ["right", "tui.editor.cursorRight"], ["home", "tui.editor.cursorLineStart"], ["end", "tui.editor.cursorLineEnd"],
];

/** Which navigation action `data` is, if any. */
export function navKeys(data: string): Nav | undefined {
	const keys = getKeybindings();
	return ACTIONS.find(([, action]) => keys.matches(data, action as never))?.[0];
}
