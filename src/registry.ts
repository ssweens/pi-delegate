/**
 * Pi's model registry and scope as the extension reads them, typed once and guarded the same way everywhere
 * (a test or an older host may lack a method). Models are Pi's `Model` objects, kept loose here.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type RegistryModel = any;
interface Registry { getAvailable?(): RegistryModel[]; getAll?(): RegistryModel[]; find?(provider: string, id: string): RegistryModel | undefined }

const registry = (ctx: ExtensionContext): Registry => (ctx.modelRegistry ?? {}) as Registry;

/** Models the session has credentials for. */
export const availableModels = (ctx: ExtensionContext): RegistryModel[] => registry(ctx).getAvailable?.() ?? [];
/** Every model in the catalog, credentials or not. */
export const allModels = (ctx: ExtensionContext): RegistryModel[] => registry(ctx).getAll?.() ?? [];
/** The exact `provider/id` offering, if the catalog has it. */
export const findModel = (ctx: ExtensionContext, provider: string, id: string): RegistryModel | undefined => registry(ctx).find?.(provider, id);
/** Pi's scoped models (`--models` / `enabledModels`); empty when none is configured. */
export const scopedModels = (ctx: ExtensionContext): RegistryModel[] =>
	((ctx as ExtensionContext & { scopedModels?: readonly { model: RegistryModel }[] }).scopedModels ?? []).map((scoped) => scoped.model);
