/** Backlog-state watches for todo 070.

 *  The source is the global `AGENTS.md`, whose backlog rule states a repository's `todos/` is its
 *  only backlog, that filing does not authorize starting, that only the operator promotes to
 *  `ready`, and that closing requires the closing commit's SHA cited in the todo's Evidence.
 *  Two consequences are mechanically checkable, and both are checks the notice path cannot make
 *  on its own: a `todos/` file is not a transcript event, so it can never satisfy
 *  `validateProcessNotice`'s requirement that every reference name visible feed evidence. The
 *  watch therefore runs host-side and reports findings for the operator, rather than inventing a
 *  citation class the validator would later reject.
 */

export type BacklogFindingKind = "stalled" | "unresolved_close";

export interface BacklogTodo { id: string; status: string; file: string }
export interface BacklogFinding { kind: BacklogFindingKind; todo: BacklogTodo; detail: string }

/** How the host asks the repository about its own history. Injected so the watch stays pure. */
export interface BacklogHistory {
	/** Does this commit exist in the repository? */
	resolves(sha: string): Promise<boolean>;
	/** When was this path last changed by a commit, or undefined if never committed? */
	lastCommittedAt(path: string): Promise<number | undefined>;
}

/** `status:` from the front matter, with the id taken from the file's `issue_id`. */
export function parseTodo(file: string, content: string): BacklogTodo {
	const id = /issue_id:\s*"([^"]+)"/.exec(content)?.[1] ?? "";
	const status = /^status:\s*(\S+)\s*$/m.exec(content)?.[1] ?? "";
	return { id, status, file };
}

/** Every SHA-shaped token cited anywhere in the todo's Evidence section. */
export function citedCommits(content: string): string[] {
	const evidence = /##\s*Evidence([\s\S]*)$/.exec(content);
	if (!evidence) return [];
	return [...new Set(evidence[1]!.match(/\b[0-9a-f]{7,40}\b/g) ?? [])];
}

export const STALL_AFTER_MS = 14 * 24 * 60 * 60 * 1000; // a fortnight of untouched work is stalled

/**
 *  A ready todo no commit has touched since promotion is stalled work; a complete todo whose
 *  Evidence cites a commit that does not resolve is a close that was never earned. Both quote the
 *  rule they come from, so a finding is auditable rather than a keyword match.
 */
export async function findBacklogFindings(todos: readonly BacklogTodo[],
	history: BacklogHistory, contents: ReadonlyMap<string, string>, now: number): Promise<BacklogFinding[]> {
	const findings: BacklogFinding[] = [];
	for (const todo of todos) {
		const detail = `todo ${todo.id} (${todo.file})`;
		if (todo.status === "ready") {
			const touched = await history.lastCommittedAt(todo.file);
			// Never committed means the promotion itself is unlanded: still stalled, and worse.
			if (touched === undefined || now - touched > STALL_AFTER_MS)
				findings.push({ kind: "stalled", todo, detail:
					`${detail} has been ready with no commit touching it since promotion. The backlog rule says filing does not authorize starting.` });
		}
		if (todo.status === "complete") {
			const content = contents.get(todo.file);
			for (const sha of citedCommits(content ?? "")) {
				if (!await history.resolves(sha))
					findings.push({ kind: "unresolved_close", todo, detail:
						`${detail} cites commit \`${sha}\` in its Evidence, which does not resolve in this repository. The backlog rule requires the closing commit's SHA.` });
			}
		}
	}
	return findings;
}
