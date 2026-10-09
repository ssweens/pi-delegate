// Mom's model switcher, modelled on pi-leash's: reuse Pi's own ModelSelectorComponent rather than
// maintain a near-copy, detect the Pi layout by capability instead of by version string, and keep
// the pick scoped to Mom's own configuration. Selecting a model for Mom must NEVER set Pi's global
// default — the legacy selector would do exactly that, so its persist callback is left inert.
import { ModelSelectorComponent, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

/** Minimal shape of Pi's ModelRuntime, so either Pi layout works without a hard dependency. */
interface ModelRuntimeLike { getAvailableSnapshot(): unknown }

/** Pi >= 0.8x routes model access through ModelRuntime on the registry facade. */
export function getModelRuntime(ctx: ExtensionContext): ModelRuntimeLike | undefined {
	const candidate = (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime as ModelRuntimeLike | undefined;
	return typeof candidate?.getAvailableSnapshot === "function" ? candidate : undefined;
}

/**
 * The model to show as current, as `provider/id`. `current` is Mom's durable setting; `fallback` is
 * what she is configured with when that is empty. Resolved against the registry so a stale name
 * still highlights the model actually in use.
 */
export function configuredMomModel(ctx: ExtensionContext, current: string | null | undefined, fallback: string): string {
	const wanted = (current ?? "").trim() || fallback;
	const separator = wanted.indexOf("/");
	if (separator > 0) {
		const found = ctx.modelRegistry.find(wanted.slice(0, separator), wanted.slice(separator + 1));
		if (found) return `${found.provider}/${found.id}`;
	}
	const active = ctx.model;
	return active ? `${active.provider}/${active.id}` : wanted;
}

/**
 * Pi's model selector as a component, for embedding in Mom's settings list. `onDone` receives
 * `provider/id`, or undefined when cancelled. Selecting a model for Mom must NEVER set Pi's global
 * default — the legacy selector would do exactly that, so its persist callback is left inert.
 */
export function momModelSelector(ctx: ExtensionContext, tui: unknown, current: string | null | undefined, fallback: string,
	onDone: (selected?: string) => void): Component {
	const runtime = getModelRuntime(ctx);
	const scopedModels = (ctx as ExtensionContext & { scopedModels?: readonly unknown[] }).scopedModels ?? [];
	const SelectorCtor = ModelSelectorComponent as unknown as new (...args: readonly unknown[]) => { focused?: boolean };
	const currentModel = configuredMomModel(ctx, current, fallback);
	const onSelect = (model: { provider: string; id: string }) => onDone(`${model.provider}/${model.id}`);
	const onCancel = () => onDone(undefined);
	// Pi >= 0.8x takes the runtime; older Pi takes a settings manager. Persisting as Pi's default is
	// a separate optional callback we never pass: Mom's model is Mom's alone.
	const selector = runtime
		? new SelectorCtor(tui, currentModel, runtime, scopedModels, onSelect, onCancel)
		: new SelectorCtor(tui, currentModel, { setDefaultModelAndProvider() { /* intentionally inert */ } }, ctx.modelRegistry, scopedModels, onSelect, onCancel);
	selector.focused = true;
	return selector as unknown as Component;
}

/**
 * Open Pi's model selector for Mom as its own overlay (the `/mom model` command). Returns
 * `provider/id`, or undefined when cancelled. The pick is written to Mom's durable `model` control
 * by the caller, never to Pi's settings.
 */
export async function pickMomModel(ctx: ExtensionContext, current: string | null | undefined, fallback: string): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, _theme, _keybindings, done) =>
		momModelSelector(ctx, tui, current, fallback, done) as never);
}
