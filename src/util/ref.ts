/**
 * Evidence refs: `<stream>:<entryId>` names a transcript entry, `<stream>:<entryId>:b<n>` one block of it. The stream
 * is a session id (lead or worker), which never contains `:`. One composer and one parser, so every reader agrees on
 * what the entry id of a block ref is.
 */

export const makeRef = (stream: string, entryId: string, block?: number): string =>
	block === undefined ? `${stream}:${entryId}` : `${stream}:${entryId}:b${block}`;

/** A ref's parts; undefined when it is not `<stream>:<entryId>[:b<n>]`. */
export function parseRef(ref: string): { stream: string; entryId: string; block?: number } | undefined {
	const match = /^([^:]+):([^:]+)(?::b(\d+))?$/.exec(ref);
	if (!match) return undefined;
	return { stream: match[1]!, entryId: match[2]!, ...(match[3] !== undefined ? { block: Number(match[3]) } : {}) };
}

/** The transcript entry a ref names (its block suffix dropped), or undefined for a malformed ref. */
export const entryIdOf = (ref: string): string | undefined => parseRef(ref)?.entryId;
