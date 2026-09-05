import { EditorTheme, Settings } from "@/types";

/** Defaults for the persisted studio settings. */
export const DEFAULT_SETTINGS: Settings = {
  openAiApiKey: null,
  anthropicApiKey: null,
  geminiApiKey: null,
  replicateApiKey: null,
  isImageGenerationEnabled: true,
  editorTheme: EditorTheme.COBALT,
  customProviders: [],
  activeCustomProviderId: null,
};
