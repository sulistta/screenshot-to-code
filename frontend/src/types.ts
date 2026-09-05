import { Stack } from "./lib/stacks";

export enum EditorTheme {
  ESPRESSO = "espresso",
  COBALT = "cobalt",
}

export enum AppTheme {
  SYSTEM = "system",
  LIGHT = "light",
  DARK = "dark",
}

export type CustomProviderProtocol = "chat_completions" | "responses";

export interface CustomProviderModel {
  id: string;
  name: string;
}

export interface CustomProvider {
  id: string;
  name: string;
  baseUrl: string;
  // null means the endpoint does not require authentication.
  apiKey: string | null;
  protocol: CustomProviderProtocol;
  models: CustomProviderModel[];
  headers: Record<string, string>;
  // A disabled provider keeps its configuration but is rejected by the
  // backend if still selected.
  enabled: boolean;
}

export interface Settings {
  openAiApiKey: string | null;
  // User-registered OpenAI-compatible endpoints.
  customProviders: CustomProvider[];
  activeCustomProviderId: string | null;
  replicateApiKey: string | null;
  isImageGenerationEnabled: boolean;
  editorTheme: EditorTheme;
  generatedCodeConfig: Stack;
  anthropicApiKey: string | null;
  geminiApiKey: string | null;
}
