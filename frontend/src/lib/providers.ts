import { HTTP_BACKEND_URL } from "../config";
import { CustomProvider } from "../types";

interface CustomProviderTestRequest {
  baseUrl: string;
  apiKey: string | null;
  modelId: string;
  protocol: CustomProvider["protocol"];
  headers: Record<string, string>;
}

interface CustomProviderTestResult {
  ok: boolean;
  error?: string | null;
  detail?: string | null;
  models: string[];
}

export type { CustomProviderTestResult };

export function createCustomProvider(
  providers: CustomProvider[]
): CustomProvider {
  return {
    id: `provider-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: `Provider ${providers.length + 1}`,
    baseUrl: "",
    apiKey: null,
    protocol: "chat_completions",
    models: [{ id: "", name: "" }],
    headers: {},
    enabled: true,
  };
}

export async function testCustomProviderConnection(
  request: CustomProviderTestRequest
): Promise<CustomProviderTestResult> {
  const response = await fetch(`${HTTP_BACKEND_URL}/api/custom-providers/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw new Error(`Backend returned HTTP ${response.status}`);
  }
  return (await response.json()) as CustomProviderTestResult;
}

export interface ProviderSettingsPatch {
  customProviders: CustomProvider[];
  activeCustomProviderId: string | null;
  openAiBaseURL: string | null;
  openAiCompatibleModel: string | null;
}

// Older settings only had flat OpenAI-compatible fields. They become a
// first provider entry so nothing the user configured is lost; the flat
// fields are cleared so both paths never apply at once.
export function migrateProviderSettings(
  settings: Record<string, unknown>
): ProviderSettingsPatch | null {
  const hasProviders = Array.isArray(settings.customProviders);
  const baseURL =
    typeof settings.openAiBaseURL === "string" ? settings.openAiBaseURL : "";
  const model =
    typeof settings.openAiCompatibleModel === "string"
      ? settings.openAiCompatibleModel
      : "";
  const needsLegacyImport = Boolean(baseURL && model);

  if (hasProviders && !needsLegacyImport) {
    return null;
  }

  const providers: CustomProvider[] = hasProviders
    ? (settings.customProviders as CustomProvider[])
    : [];

  if (needsLegacyImport) {
    const alreadyImported = providers.some(
      (provider) =>
        provider.baseUrl === baseURL &&
        provider.models.some((entry) => entry.id === model)
    );
    if (!alreadyImported) {
      providers.push({
        id: "legacy-openai-compatible",
        name: "OpenAI-compatible",
        baseUrl: baseURL,
        apiKey:
          typeof settings.openAiApiKey === "string" && settings.openAiApiKey
            ? settings.openAiApiKey
            : null,
        protocol: "chat_completions",
        models: [{ id: model, name: model }],
        headers: {},
        enabled: true,
      });
    }
  }

  return {
    customProviders: providers,
    activeCustomProviderId: providers.length
      ? providers[providers.length - 1].id
      : null,
    openAiBaseURL: null,
    openAiCompatibleModel: null,
  };
}
