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

export interface ProviderTestRecord {
  ok: boolean;
  at: string;
}

const testKey = (providerId: string) => `provider-test:${providerId}`;

/** Last connection-test outcome per provider. Stored locally, never secret. */
export function recordProviderTest(providerId: string, ok: boolean): void {
  try {
    localStorage.setItem(testKey(providerId), JSON.stringify({ ok, at: new Date().toISOString() } satisfies ProviderTestRecord));
  } catch {
    /* best-effort */
  }
}

export function readProviderTest(providerId: string): ProviderTestRecord | null {
  try {
    const raw = localStorage.getItem(testKey(providerId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ProviderTestRecord>;
    if (typeof parsed.ok !== "boolean" || typeof parsed.at !== "string") return null;
    return { ok: parsed.ok, at: parsed.at };
  } catch {
    return null;
  }
}
