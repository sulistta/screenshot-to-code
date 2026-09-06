import type { Settings } from "@/types";

/** Per-role model configuration: the model plus its reasoning effort. */
export interface RunModels {
  primaryModel?: string;
  subagentModel?: string;
  primaryEffort?: string;
  subagentEffort?: string;
}

export type RunSettings = Pick<Settings,
  "customProviders" | "activeCustomProviderId" | "openAiApiKey" |
  "anthropicApiKey" | "geminiApiKey" | "replicateApiKey" | "isImageGenerationEnabled"
> & { primaryModel: string; subagentModel: string; primaryEffort: string; subagentEffort: string };

/** Explicit allowlist: retired preferences never leak into generation requests. */
export function runSettings(settings: Settings, models: RunModels = {}): RunSettings {
  return {
    primaryModel: models.primaryModel ?? "",
    subagentModel: models.subagentModel ?? "",
    primaryEffort: models.primaryEffort ?? "",
    subagentEffort: models.subagentEffort ?? "",
    customProviders: settings.customProviders,
    activeCustomProviderId: settings.activeCustomProviderId,
    openAiApiKey: settings.openAiApiKey,
    anthropicApiKey: settings.anthropicApiKey,
    geminiApiKey: settings.geminiApiKey,
    replicateApiKey: settings.replicateApiKey,
    isImageGenerationEnabled: settings.isImageGenerationEnabled,
  };
}
