import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { settingsFile } from "./settings-file.ts";

/** Resolved once, at load, by Pi's own rule (PI_CODING_AGENT_DIR with `~` expanded, else ~/.pi/agent), so pi-delegate and Pi read the same mcp.json and settings. */
export const AGENT_DIR = getAgentDir();
/** Every pi-delegate setting (settings-file.ts). */
export const SETTINGS_PATH = settingsFile(AGENT_DIR);
