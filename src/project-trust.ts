import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, hasTrustRequiringProjectResources, ProjectTrustStore, SettingsManager } from "@earendil-works/pi-coding-agent";
import { PROJECT_ROLES_DIR } from "./roles.js";

export interface TrustOption {
	label: string;
	trusted: boolean;
	/** Written to Pi's trust store as Pi writes them; none for a session-only answer. */
	updates: { path: string; decision: boolean | null }[];
}

/**
 * Pi's own choices for a project folder: getProjectTrustOptions(cwd, { includeSessionOnly: true }),
 * which Pi 0.99.1 and 1.0.2 do not export. test/trust.test.ts checks they agree. `cwd` is a
 * real path. "Trust parent folder" records the parent and clears the folder's own entry, so one answer
 * covers every sibling, such as each agent's copy-on-write repo copy under the same copies folder.
 */
export function trustOptions(cwd: string): TrustOption[] {
	const parent = dirname(cwd);
	return [
		{ label: "Trust", trusted: true, updates: [{ path: cwd, decision: true }] },
		...(parent === cwd ? [] : [{ label: `Trust parent folder (${parent})`, trusted: true, updates: [{ path: parent, decision: true }, { path: cwd, decision: null }] }]),
		{ label: "Trust (this session only)", trusted: true, updates: [] },
		{ label: "Do not trust", trusted: false, updates: [{ path: cwd, decision: false }] },
		{ label: "Do not trust (this session only)", trusted: false, updates: [] },
	];
}

export const trustPrompt = (cwd: string) =>
	`Trust project folder for a delegated child?\n${cwd}\n\nA child agent is about to work here. Trusting the folder lets the child load its ${CONFIG_DIR_NAME} settings, ${CONFIG_DIR_NAME}/mcp.json servers and ${CONFIG_DIR_NAME}/agents roles.`;

/**
 * Whether a folder holds anything a child would read from it only when the folder is trusted: what Pi
 * gates (hasTrustRequiringProjectResources), plus pi-delegate's own project roles, `.pi/agents`, which
 * Pi does not know about. A delegating child loads its roles from there, and a role sets the tools of the
 * children it starts.
 */
export function hasTrustGatedResources(cwd: string): boolean {
	return hasTrustRequiringProjectResources(cwd) || existsSync(join(cwd, PROJECT_ROLES_DIR));
}

/**
 * Why a child has its trust, recorded on its run. `parent`: it works where its parent does. `saved`:
 * Pi's trust store. `ungated`: nothing trust-gated in its folder, so the parent's decision. `setting`:
 * `defaultProjectTrust`. `prompted`: the person's answer. `session`: an earlier session-only answer or
 * dismissal in this delegating session. `dismissed`: the person dismissed the question (or the delegate
 * call was aborted while it was open). `inherited`: no one to ask, so the parent's decision. `unknown`: a
 * record from before 0.2.0.
 */
export type TrustSource = "parent" | "saved" | "ungated" | "setting" | "prompted" | "session" | "dismissed" | "inherited" | "unknown";
export interface ChildTrust { trusted: boolean; source: TrustSource }

export interface ChildTrustInput {
	/** The child's working directory, a real path other than the delegating session's own. */
	cwd: string;
	/** The delegating session's own trust decision for its project. */
	parentTrusted: boolean;
	agentDir: string;
	/** Present only where a person can answer: the root interactive session. */
	select?: (title: string, options: string[], opts: { signal?: AbortSignal }) => Promise<string | undefined>;
	/** Session-only answers and dismissals, kept for the delegating session's lifetime. */
	session: Map<string, boolean>;
	/** The delegate call's signal. Aborting it closes the question as a dismissal. */
	signal?: AbortSignal;
}

/** Resolves with undefined, as a dismissal, once `signal` aborts, whether or not `select` honors it. */
function ask(select: NonNullable<ChildTrustInput["select"]>, title: string, options: string[], signal?: AbortSignal): Promise<string | undefined> {
	if (!signal) return select(title, options, {});
	return new Promise((resolve, reject) => {
		const onAbort = () => resolve(undefined);
		signal.addEventListener("abort", onAbort, { once: true });
		select(title, options, { signal }).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

/**
 * The trust a child gets for a folder other than its parent's, and why. Pi's saved decision for the
 * folder (its nearest recorded ancestor) wins. A folder with nothing trust-gated in it
 * (hasTrustGatedResources), which Pi would never ask about, and any folder when no one can be asked, gets
 * the parent's own decision. Otherwise the person is asked with Pi's choices, and the answer is saved as
 * Pi saves it. `defaultProjectTrust` "always" or "never" answers instead of the person, as it does for Pi.
 * A dismissed question counts as "Do not trust (this session only)", so it is not asked again.
 */
export async function resolveChildTrust({ cwd, parentTrusted, agentDir, select, session, signal }: ChildTrustInput): Promise<ChildTrust> {
	const store = new ProjectTrustStore(agentDir);
	const saved = store.get(cwd);
	if (saved !== null) return { trusted: saved, source: "saved" };
	if (!hasTrustGatedResources(cwd)) return { trusted: parentTrusted, source: "ungated" };
	const setting = SettingsManager.create(cwd, agentDir, { projectTrusted: false }).getDefaultProjectTrust();
	if (setting !== "ask") return { trusted: setting === "always", source: "setting" };
	const remembered = session.get(cwd);
	if (remembered !== undefined) return { trusted: remembered, source: "session" };
	if (!select) return { trusted: parentTrusted, source: "inherited" };
	// Aborted before its turn in the queue: no one saw a question, so nothing is remembered.
	if (signal?.aborted) return { trusted: false, source: "dismissed" };
	const options = trustOptions(cwd);
	const label = await ask(select, trustPrompt(cwd), options.map((option) => option.label), signal);
	const choice = options.find((option) => option.label === label);
	if (!choice) {
		session.set(cwd, false);
		return { trusted: false, source: "dismissed" };
	}
	if (choice.updates.length) store.setMany(choice.updates);
	else session.set(cwd, choice.trusted);
	return { trusted: choice.trusted, source: "prompted" };
}
