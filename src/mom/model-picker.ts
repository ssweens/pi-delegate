// Path's model switcher, modelled on pi-leash's: reuse Pi's own ModelSelectorComponent rather than
// maintain a near-copy, detect the Pi layout by capability instead of by version string, and keep
// the pick scoped to Path's own configuration. Selecting a model for Path must NEVER set Pi's global
// default — the legacy selector would do exactly that, so its persist callback is left inert.
import { ModelSelectorComponent, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { resolveClassifier } from "./slice.ts";
import { modelKey } from "../model-ref.ts";
import { allModels, findModel, scopedModels } from "../registry.ts";

/** Minimal shape of Pi's ModelRuntime, so either Pi layout works without a hard dependency. */
interface ModelRuntimeLike { getAvailableSnapshot(): unknown }

/** Pi >= 0.8x routes model access through ModelRuntime on the registry facade. */
export function getModelRuntime(ctx: ExtensionContext): ModelRuntimeLike | undefined {
	const candidate = (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime as ModelRuntimeLike | undefined;
	return typeof candidate?.getAvailableSnapshot === "function" ? candidate : undefined;
}

/**
 * The model to show as current, as `provider/id`. `current` is Path's durable setting; `fallback` is
 * what it is configured with when that is empty. Resolved against the registry so a stale name
 * still highlights the model actually in use.
 */
export function configuredMomModel(ctx: ExtensionContext, current: string | null | undefined, fallback: string): string {
	const wanted = (current ?? "").trim() || fallback;
	const separator = wanted.indexOf("/");
	if (separator > 0) {
		const found = findModel(ctx, wanted.slice(0, separator), wanted.slice(separator + 1));
		if (found) return modelKey(found);
	}
	const active = ctx.model;
	return active ? modelKey(active) : wanted;
}

/** A model as Pi's selector lists it: `provider`, `id` and `name` are all it reads of an entry. */
export interface Listed { provider: string; id: string; name?: string }

/**
 * Pi's own model selector (type to search, Tab between its first list and all of Pi's models) for every model
 * Path picks, so there is one chooser in the app. `first` is the list it opens on (Pi's scoped models for Path's
 * model, the decision models for the decider); `onDone` receives `provider/id`, or undefined when cancelled.
 * Selecting a model for Path must NEVER set Pi's global default — the legacy selector would do exactly that, so
 * its persist callback is left inert.
 */
function modelSelector(ctx: ExtensionContext, tui: unknown, current: string, first: readonly Listed[] | readonly { model: Listed }[],
	onDone: (selected?: string) => void): Component {
	const runtime = getModelRuntime(ctx);
	const scoped = (first as readonly (Listed | { model: Listed })[]).map(item => "model" in item ? item : { model: item });
	const SelectorCtor = ModelSelectorComponent as unknown as new (...args: readonly unknown[]) => { focused?: boolean };
	// Pi marks the current model by comparing model objects, so a `provider/id` string is resolved to one.
	const slash = current.indexOf("/");
	const currentModel = scoped.find(item => modelKey(item.model) === current)?.model
		?? (slash > 0 ? findModel(ctx, current.slice(0, slash), current.slice(slash + 1)) : undefined);
	const onSelect = (model: Listed) => onDone(modelKey(model));
	const onCancel = () => onDone(undefined);
	// Pi >= 0.8x takes the runtime; older Pi takes a settings manager. Persisting as Pi's default is
	// a separate optional callback we never pass: Path's model is Path's alone.
	const selector = runtime
		? new SelectorCtor(tui, currentModel, runtime, scoped, onSelect, onCancel)
		: new SelectorCtor(tui, currentModel, { setDefaultModelAndProvider() { /* intentionally inert */ } }, ctx.modelRegistry, scoped, onSelect, onCancel);
	selector.focused = true;
	return selector as unknown as Component;
}

/** Path's model picker: Pi's selector over Pi's models, opening on its scoped ones. */
export function momModelSelector(ctx: ExtensionContext, tui: unknown, current: string | null | undefined, fallback: string,
	onDone: (selected?: string) => void): Component {
	return modelSelector(ctx, tui, configuredMomModel(ctx, current, fallback), scopedModels(ctx), onDone);
}

/**
 * Open Pi's model selector for Path as its own overlay (the `/path model` command). Returns
 * `provider/id`, or undefined when cancelled. The pick is written to Path's durable `model` control
 * by the caller, never to Pi's settings.
 */
export async function pickMomModel(ctx: ExtensionContext, current: string | null | undefined, fallback: string): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, _theme, _keybindings, done) =>
		momModelSelector(ctx, tui, current, fallback, done) as never);
}

/** Classifier models Pi knows — the decision models a decider may be. Mirrors yono's
 *  registryClassifierModels(): the registry's classifier catalog, which includes what
 *  pi-dynamic-models registers (models whose output modality is `decisions`). Path's direct client
 *  supports private IPv4 System One endpoints only. Sync catalog rather than getAvailableOfType:
 *  local System One endpoints need no credentials. */
export function deciderModels(ctx: ExtensionContext): Listed[] {
	const registry = ctx.modelRegistry as unknown as { getModelsOfType?: (type: string) => readonly (Listed & { api?: string })[] };
	return (registry.getModelsOfType?.("classifier") ?? [])
		.filter(model => model.provider && model.id && model.api === "typesafe-system-one" && resolveClassifier(ctx.modelRegistry, modelKey(model)))
		.map(({ provider, id, name }) => ({ provider, id, name: name ?? id }));
}

/** Every other model Path could call as a decider (its endpoint is on a loopback or private IPv4 host), for an
 *  inference server that does not tag its decision models. A remote model is left out: Path cannot reach it. */
export function untaggedDeciderModels(ctx: ExtensionContext, tagged: readonly Listed[]): Listed[] {
	const known = new Set(tagged.map(modelKey));
	return (allModels(ctx) as Listed[])
		.filter(model => !known.has(modelKey(model)) && resolveClassifier(ctx.modelRegistry, modelKey(model)))
		.map(({ provider, id, name }) => ({ provider, id, name: `${name && name !== id ? `${name} · ` : ""}not tagged as a decision model` }));
}

/** The picker's way to run with no decision model: listed last in its first list, saved as empty. */
const NO_DECIDER: Listed = { provider: "none", id: "no decider", name: "No decider: semantic gates are refused, never guessed" };

/** The decider picker: the same selector as Path's model picker, opening on the decision models and then every
 *  other model Path could call (for a server that does not tag them); Tab shows all of Pi's models. `done` is the
 *  settings row's own save trigger, and nothing here touches Pi's defaults. */
export function momDeciderSelector(ctx: ExtensionContext, tui: unknown, current: string | null | undefined,
	done: (selected?: string) => void): Component {
	const tagged = deciderModels(ctx), none = modelKey(NO_DECIDER);
	return modelSelector(ctx, tui, (current ?? "").trim() || none, [...tagged, ...untaggedDeciderModels(ctx, tagged), NO_DECIDER],
		selected => done(selected === none ? "" : selected));
}
