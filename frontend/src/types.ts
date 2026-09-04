import { Stack } from "./lib/stacks";
import { CodeGenerationModel } from "./lib/models";

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
  openAiBaseURL: string | null;
  // Kept for pre-migration clients; generation now reads customProviders.
  openAiCompatibleModel: string | null;
  // User-registered OpenAI-compatible endpoints.
  customProviders: CustomProvider[];
  activeCustomProviderId: string | null;
  replicateApiKey: string | null;
  screenshotOneApiKey: string | null;
  isImageGenerationEnabled: boolean;
  editorTheme: EditorTheme;
  generatedCodeConfig: Stack;
  codeGenerationModel: CodeGenerationModel;
  selectedDesignSystemId: string | null;
  // Only relevant for hosted version
  isTermOfServiceAccepted: boolean;
  anthropicApiKey: string | null;
  geminiApiKey: string | null;
}

export interface DesignSystem {
  id: string;
  name: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export enum AppState {
  INITIAL = "INITIAL",
  CODING = "CODING",
  CODE_READY = "CODE_READY",
}

export enum ScreenRecorderState {
  INITIAL = "initial",
  RECORDING = "recording",
  FINISHED = "finished",
}

export type PromptMessageRole = "user" | "assistant";
export type PromptAssetType = "image" | "video";

export interface PromptAsset {
  id: string;
  type: PromptAssetType;
  dataUrl: string;
}

export interface PromptContent {
  text: string; // What the user typed (displayed in the UI)
  // Full instruction for the model when it differs from `text`
  // (e.g. includes the selected-element reference)
  fullText?: string;
  images: string[]; // Array of data URLs
  videos?: string[]; // Array of data URLs
  selectedElementHtml?: string; // Raw HTML of selected element (for display only)
}

export interface PromptHistoryMessage {
  role: PromptMessageRole;
  text: string;
  images: string[];
  videos: string[];
}

export interface CodeGenerationParams {
  generationType: "create" | "update";
  inputMode: "image" | "video" | "text";
  prompt: PromptContent;
  history?: PromptHistoryMessage[];
  fileState?: {
    path: string;
    content: string;
  };
  optionCodes?: string[];
  isAssetExtractionEnabled?: boolean;
}

export type FullGenerationSettings = CodeGenerationParams &
  Settings & {
    designSystem?: string | null;
  };
