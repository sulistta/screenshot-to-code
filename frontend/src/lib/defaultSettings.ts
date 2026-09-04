import { EditorTheme, Settings } from "@/types";
import { Stack } from "@/lib/stacks";

/** Defaults for the persisted studio settings. */
export const DEFAULT_SETTINGS: Settings = {
  openAiApiKey: null,
  anthropicApiKey: null,
  geminiApiKey: null,
  replicateApiKey: null,
  isImageGenerationEnabled: true,
  editorTheme: EditorTheme.COBALT,
  generatedCodeConfig: Stack.HTML_TAILWIND,
  selectedDesignSystemId: null,
  openAiBaseURL: null,
  openAiCompatibleModel: null,
  customProviders: [],
  activeCustomProviderId: null,
};
