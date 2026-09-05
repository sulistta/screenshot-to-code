import type { Settings } from "@/types";

export type RunSettings = Pick<Settings,
  "customProviders" | "activeCustomProviderId" | "openAiApiKey" |
  "anthropicApiKey" | "geminiApiKey" | "replicateApiKey" | "isImageGenerationEnabled"
> & { primaryModel: string; subagentModel: string };

/** Explicit allowlist: retired preferences never leak into generation requests. */
export function runSettings(settings: Settings, primaryModel = "", subagentModel = ""): RunSettings {
  return {
    primaryModel, subagentModel,
    customProviders: settings.customProviders,
    activeCustomProviderId: settings.activeCustomProviderId,
    openAiApiKey: settings.openAiApiKey,
    anthropicApiKey: settings.anthropicApiKey,
    geminiApiKey: settings.geminiApiKey,
    replicateApiKey: settings.replicateApiKey,
    isImageGenerationEnabled: settings.isImageGenerationEnabled,
  };
}
