/**
 * Model references (`provider/id`, optionally `:thinking`) with one parser, one formatter and one lookup, for the
 * delegate's roles and runs, its settings, and Path's model and decision model.
 */

/** A saved `provider/id`: both parts non-empty; the id may contain `/`, `.`, `:` and `-`. */
export const PROVIDER_MODEL = /^[\w.-]+\/[\w./:-]+$/;

/** Empty (meaning "the default" or "none", by field) or a well-formed `provider/id`. */
export const isModelRefOrEmpty = (value: string): boolean => value.trim() === "" || PROVIDER_MODEL.test(value.trim());

/** `provider/id` of a model. */
export const modelKey = (model: { provider: string; id: string }): string => `${model.provider}/${model.id}`;

/** `provider/id` split at its first `/`; undefined unless both parts are non-empty. */
export function splitModelRef(ref: string): { provider: string; id: string } | undefined {
	const slash = ref.indexOf("/");
	return slash > 0 && slash < ref.length - 1 ? { provider: ref.slice(0, slash), id: ref.slice(slash + 1) } : undefined;
}

/**
 * A model spec as a role or a request writes it: `provider/id`, a bare `id` (any provider's offering), either with
 * a `:thinking` suffix. A trailing `:x` is a thinking level only when no `/` follows it (ids may contain `:`).
 */
export function parseModelSpec(spec: string): { provider?: string; id: string; thinking?: string } {
	let rest = spec, thinking: string | undefined;
	const colon = rest.lastIndexOf(":");
	if (colon > 0 && !rest.slice(colon + 1).includes("/")) { thinking = rest.slice(colon + 1); rest = rest.slice(0, colon); }
	const split = splitModelRef(rest);
	return { ...(split ?? { id: rest }), ...(thinking !== undefined ? { thinking } : {}) };
}

/** Does `model` answer to `spec` (a parsed `provider/id` or bare id)? */
export const matchesSpec = (model: { provider: string; id: string }, spec: { provider?: string; id: string }): boolean =>
	model.id === spec.id && (spec.provider === undefined || model.provider === spec.provider);
