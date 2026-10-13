/** Path display with one definition. */
import { homedir } from "node:os";
import { sep } from "node:path";

/** `path` with a leading home directory shown as `~`; any other path is returned as is. */
export function tildify(path: string): string {
	const home = homedir();
	return path === home ? "~" : path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}
