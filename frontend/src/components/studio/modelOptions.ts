import type { Settings } from "@/types";

export interface ModelOption {
  value: string;
  group: string;
}

/** Display form of a model value: custom:<id> -> the id. */
export function modelDisplayName(value: string): string {
  if (!value) return "";
  if (value.startsWith("custom:")) return value.slice("custom:".length);
  // Compact the effort suffix: "gpt-5.6-sol (max thinking)" -> "gpt-5.6-sol · max".
  const match = value.match(/^(.*) \((.*)\)$/);
  if (match) {
    const effort = match[2]
      .replace(" thinking", "")
      .replace(" effort", "")
      .replace("no", "default");
    return `${match[1]} · ${effort}`;
  }
  return value;
}

/** Build grouped options: built-in providers, then custom providers. */
export function buildModelOptions(
  entries: ModelOption[],
  settings: Settings | null,
): ModelOption[] {
  const options = [...entries];
  const active = (settings?.customProviders ?? []).find(
    (provider) =>
      provider.enabled && provider.id === settings?.activeCustomProviderId,
  );
  if (active) {
    for (const model of active.models) {
      options.push({
        value: `custom:${model.id}`,
        group: active.name,
      });
    }
  }
  return options;
}
