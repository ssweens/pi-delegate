/**
 * ACP model choices. Native ACP config metadata wins; these are the maintained
 * aliases used only when an adapter cannot advertise its choices.
 */
export interface AcpModelOption {
  id: string;
  name: string;
  description?: string;
}

export type AcpModelSource = "native" | "fallback";

const FALLBACK_MODELS: Readonly<Record<string, readonly AcpModelOption[]>> = {
  claude: [
    { id: "default", name: "Default", description: "Use the account's runtime default." },
    { id: "best", name: "Best", description: "Use Fable when available, otherwise Opus." },
    { id: "fable", name: "Fable", description: "Claude's long-running reasoning alias." },
    { id: "opus", name: "Opus", description: "Claude's complex-reasoning alias." },
    { id: "opus[1m]", name: "Opus (1M)", description: "Opus with a 1 million token context window." },
    { id: "sonnet", name: "Sonnet", description: "Claude's daily-coding alias." },
    { id: "sonnet[1m]", name: "Sonnet (1M)", description: "Sonnet with a 1 million token context window." },
    { id: "haiku", name: "Haiku", description: "Claude's fast, efficient alias." },
    { id: "opusplan", name: "Opus Plan", description: "Opus for planning, then Sonnet for execution." },
  ],
  codex: [
    { id: "gpt-5.5", name: "GPT-5.5" },
    { id: "gpt-5.4", name: "GPT-5.4" },
    { id: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
  ],
  amp: [
    { id: "low", name: "Low", description: "Amp's low-effort mode." },
    { id: "medium", name: "Medium", description: "Amp's medium-effort mode." },
    { id: "high", name: "High", description: "Amp's high-effort mode." },
    { id: "ultra", name: "Ultra", description: "Amp's ultra-effort mode." },
  ],
};

export function fallbackModelOptions(agent: string): readonly AcpModelOption[] {
  return FALLBACK_MODELS[agent.trim().toLowerCase()] ?? [];
}

type ConfigOptionRecord = {
  id?: unknown;
  type?: unknown;
  category?: unknown;
  name?: unknown;
  description?: unknown;
  currentValue?: unknown;
  options?: unknown;
};

function record(value: unknown): ConfigOptionRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ConfigOptionRecord : undefined;
}

function option(value: unknown): AcpModelOption | undefined {
  const item = record(value);
  if (!item || typeof (item as { value?: unknown }).value !== "string") return undefined;
  const id = ((item as { value: string }).value).trim();
  if (!id) return undefined;
  const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : id;
  const description = typeof item.description === "string" && item.description.trim() ? item.description.trim() : undefined;
  return { id, name, ...(description ? { description } : {}) };
}

function options(value: unknown): AcpModelOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((itemValue) => {
    const direct = option(itemValue);
    if (direct) return [direct];
    const group = record(itemValue);
    return group?.options ? options(group.options) : [];
  });
}

/** Extract the model selector from native ACP `configOptions`, preserving labels and descriptions. */
export function nativeModelOptions(configOptions: unknown): { configId: string; current?: string; options: AcpModelOption[] } | undefined {
  if (!Array.isArray(configOptions)) return undefined;
  for (const raw of configOptions) {
    const item = record(raw);
    if (!item || item.type !== "select" || (item.category !== "model" && item.id !== "model") || typeof item.id !== "string") continue;
    const parsed = options(item.options);
    if (!parsed.length) continue;
    const current = typeof item.currentValue === "string" ? item.currentValue.trim() : "";
    return {
      configId: item.id,
      ...(current && current.toLowerCase() !== "unknown" ? { current } : {}),
      options: parsed,
    };
  }
  return undefined;
}

export function optionIds(options: readonly AcpModelOption[]): string[] {
  return [...new Set(options.map((item) => item.id))];
}
