// Mom's model switcher, modelled on pi-leash's: reuse Pi's own ModelSelectorComponent rather than
// maintain a near-copy, detect the Pi layout by capability instead of by version string, and keep
// the pick scoped to Mom's own configuration. Selecting a model for Mom must NEVER set Pi's global
// default — the legacy selector would do exactly that, so its persist callback is left inert.
import { getSelectListTheme, ModelSelectorComponent, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SelectList, type Component, type SelectItem } from "@earendil-works/pi-tui";
import { resolveClassifier } from "./slice.ts";

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

/** Classifier models Pi knows — the decision models a decider may be. Mirrors yono's
 *  registryClassifierModels(): the registry's classifier catalog, which includes what
 *  pi-dynamic-models registers (models whose output modality is `decisions`). Mom's direct client
 *  supports private IPv4 System One endpoints only. Sync catalog rather than getAvailableOfType:
 *  local System One endpoints need no credentials. */
export function deciderModels(ctx: ExtensionContext): SelectItem[] {
	const registry = ctx.modelRegistry as unknown as { getModelsOfType?: (type: string) => readonly unknown[] };
	const entries = registry.getModelsOfType?.("classifier") ?? [];
	return entries.map(entry => {
		const model = entry as { provider?: unknown; id?: unknown; name?: unknown; api?: unknown };
		const provider = String(model.provider ?? ""), id = String(model.id ?? "");
		return { value: `${provider}/${id}`, label: `${provider}/${id}`,
			description: typeof model.name === "string" && model.name !== id ? model.name : undefined,
			api: model.api };
	}).filter(item => item.value.length > 1 && !item.value.endsWith("/") && item.api === "typesafe-system-one"
		&& resolveClassifier(ctx.modelRegistry, item.value))
		.map(({ value, label, description }) => ({ value, label, description }));
}

/** The decider picker as Mom's settings submenu: Pi's own SelectList over the decision models, the
 *  same rows yono's `/yono jev` chooser offers. `done` is the settings row's own save trigger — the
 *  same contract as momModelSelector — and nothing here touches Pi's defaults. */
export function momDeciderSelector(ctx: ExtensionContext, _tui: unknown, current: string | null | undefined,
	done: (selected?: string) => void): Component {
	const wanted = (current ?? "").trim();
	const items: SelectItem[] = [{ value: "", label: "(none)", description: "No decider: semantic gates are refused, never guessed" },
		...deciderModels(ctx)];
	const list = new SelectList(items, Math.max(4, Math.min(12, items.length)), getSelectListTheme());
	const active = items.findIndex(item => item.value === wanted);
	if (active >= 0) list.setSelectedIndex(active);
	list.onSelect = item => done(item.value);
	list.onCancel = () => done(undefined);
	return {
		render: (width: number) => ["Decision model (Mom's decider)", "", ...list.render(width)],
		invalidate: () => list.invalidate(),
		handleInput: (data: string) => list.handleInput(data),
		handleMouse: (event: Parameters<SelectList["handleMouse"]>[0]) => list.handleMouse(event),
	} as unknown as Component;
}
