/** The symbols the panels draw with, defined once. Distinct meanings stay distinct; the same meaning is one glyph everywhere. */

/** Run and step outcomes, shared by the Agents list, Path's trail and the status slot. */
export const GLYPH = {
	running: "●", done: "✓", idle: "○", failed: "✗", stopped: "⊘",
	checked: "☑", unchecked: "☐", pending: "⏳",
	/** Path is mid-update; the braille spinner frames follow. */
	paused: "‖", ask: "?", alert: "!",
	finding: "◆", here: "▸", detour: "↳", back: "↰", goal: "◎", learned: "•", open: "□", closed: "■", crumb: "›",
} as const;

/** Tree and frame drawing. */
export const TREE = { branch: "├─", last: "└─", vertical: "│" } as const;
export const BOX = { h: "─", v: "│", topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯" } as const;
