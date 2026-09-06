import type { Settings } from "@/types";

/** One entry of the bundled model catalogue (the `list_models` command). */
export interface CatalogModel {
  model: string;
  group: string;
  /** Effort levels the provider accepts for this model, weakest to strongest. */
  efforts: string[];
}

export interface ModelOption {
  value: string;
  group: string;
  efforts: string[];
}

/** Canonical effort levels, weakest to strongest. */
export const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export const EFFORT_LABELS: Record<string, string> = {
  "": "Default",
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** Display form of a model value: custom:<id> -> the id. */
export function modelDisplayName(value: string): string {
  if (!value) return "";
  if (value.startsWith("custom:")) return value.slice("custom:".length);
  return value;
}

/** Effort levels offered for a role: the model's supported set, or every
 *  level in the catalogue while the model is still "best available". */
export function effortsForModel(value: string, entries: CatalogModel[]): string[] {
  if (value.startsWith("custom:")) return [];
  if (!value) {
    const supported = new Set(entries.flatMap((entry) => entry.efforts));
    return EFFORT_ORDER.filter((level) => supported.has(level));
  }
  return entries.find((entry) => entry.model === value)?.efforts ?? [];
}

/** Build grouped options: built-in providers, then custom providers. */
export function buildModelOptions(
  entries: CatalogModel[],
  settings: Settings | null,
): ModelOption[] {
  const options = entries.map((entry) => ({
    value: entry.model,
    group: entry.group,
    efforts: entry.efforts ?? [],
  }));
  const active = (settings?.customProviders ?? []).find(
    (provider) =>
      provider.enabled && provider.id === settings?.activeCustomProviderId,
  );
  if (active) {
    for (const model of active.models) {
      options.push({
        value: `custom:${model.id}`,
        group: active.name,
        efforts: [],
      });
    }
  }
  return options;
}
