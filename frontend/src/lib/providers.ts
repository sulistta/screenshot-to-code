import { native } from "./native";
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
  return native<CustomProviderTestResult>("test_provider", { request });
}
