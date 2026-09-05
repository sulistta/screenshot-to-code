import { useEffect, useMemo, useState } from "react";
import {
  LuLoader2,
  LuPlus,
  LuRefreshCw,
  LuTrash2,
} from "react-icons/lu";
import { BsCheckCircleFill, BsExclamationTriangleFill } from "react-icons/bs";
import {
  CustomProvider,
  CustomProviderModel,
  CustomProviderProtocol,
} from "../../types";
import { createCustomProvider, testCustomProviderConnection } from "../../lib/providers";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null opens the dialog in "add provider" mode. */
  provider: CustomProvider | null;
  onSave: (provider: CustomProvider) => void;
}

interface Draft {
  name: string;
  baseUrl: string;
  apiKey: string;
  protocol: CustomProviderProtocol;
  models: CustomProviderModel[];
  headers: { key: string; value: string }[];
}

interface TestResult {
  status: "idle" | "testing" | "ok" | "error";
  detail?: string;
  error?: string;
  discovered: string[];
}

const blankDraft = (providers: CustomProvider[]): Draft => {
  const fresh = createCustomProvider(providers);
  return {
    name: fresh.name,
    baseUrl: "",
    apiKey: "",
    protocol: "chat_completions",
    models: [{ id: "", name: "" }],
    headers: [],
  };
};

const draftFromProvider = (provider: CustomProvider): Draft => ({
  name: provider.name,
  baseUrl: provider.baseUrl,
  apiKey: provider.apiKey ?? "",
  protocol: provider.protocol,
  models: provider.models.length
    ? provider.models.map((model) => ({ ...model }))
    : [{ id: "", name: "" }],
  headers: Object.entries(provider.headers).map(([key, value]) => ({
    key,
    value,
  })),
});

function ProviderDialog({ open, onOpenChange, provider, onSave }: Props) {
  const [draft, setDraft] = useState<Draft>(() =>
    provider ? draftFromProvider(provider) : blankDraft([])
  );
  const [test, setTest] = useState<TestResult>({ status: "idle", discovered: [] });
  const [showHeaders, setShowHeaders] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(provider ? draftFromProvider(provider) : blankDraft([]));
      setTest({ status: "idle", discovered: [] });
    }
  }, [open, provider]);

  const trimmedName = draft.name.trim();
  const trimmedBaseUrl = draft.baseUrl.trim();
  const validModels = draft.models.filter((model) => model.id.trim());
  const orphanHeader = draft.headers.find(
    (header) => header.key.trim() === "" || header.value.trim() === ""
  );

  const errors = useMemo(() => {
    const map: Partial<Record<"name" | "baseUrl" | "models" | "headers", string>> = {};
    if (!trimmedName) map.name = "A display name is required.";
    if (!trimmedBaseUrl) {
      map.baseUrl = "A Base URL is required.";
    } else if (!/^https?:\/\//.test(trimmedBaseUrl)) {
      map.baseUrl = "Base URL must start with http:// or https://.";
    }
    if (validModels.length === 0) {
      map.models = "Add at least one model ID.";
    }
    if (orphanHeader) {
      map.headers = "Every header needs a name and a value (remove empty rows).";
    }
    return map;
  }, [trimmedName, trimmedBaseUrl, validModels.length, orphanHeader]);

  const isValid = Object.keys(errors).length === 0;
  const firstModelId = validModels[0]?.id.trim() ?? "";

  const headerRecord = useMemo(() => {
    const record: Record<string, string> = {};
    draft.headers.forEach((header) => {
      const key = header.key.trim();
      const value = header.value.trim();
      if (key && value) record[key] = value;
    });
    return record;
  }, [draft.headers]);

  const handleSave = () => {
    if (!isValid) return;
    onSave({
      id: provider?.id ?? `provider-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: trimmedName,
      baseUrl: trimmedBaseUrl,
      apiKey: draft.apiKey.trim() ? draft.apiKey.trim() : null,
      protocol: draft.protocol,
      models: validModels.map((model) => ({
        id: model.id.trim(),
        name: model.name.trim() || model.id.trim(),
      })),
      headers: headerRecord,
      enabled: provider?.enabled ?? true,
    });
    onOpenChange(false);
  };

  const runTest = async () => {
    if (!/^https?:\/\//.test(trimmedBaseUrl)) return;
    setTest({ status: "testing", discovered: [] });
    try {
      const result = await testCustomProviderConnection({
        baseUrl: trimmedBaseUrl,
        apiKey: draft.apiKey.trim() || null,
        modelId: firstModelId,
        protocol: draft.protocol,
        headers: headerRecord,
      });
      setTest({
        status: result.ok ? "ok" : "error",
        detail: result.detail ?? undefined,
        error: result.error ?? undefined,
        discovered: result.models ?? [],
      });
    } catch (error) {
      setTest({
        status: "error",
        error:
          error instanceof Error
            ? error.message
            : "Could not reach the backend.",
        discovered: [],
      });
    }
  };

  const addDiscoveredModels = () => {
    setDraft((prev) => {
      const known = new Set(
        prev.models.map((model) => model.id.trim()).filter(Boolean)
      );
      const additions = test.discovered
        .filter((id) => !known.has(id))
        .map((id) => ({ id, name: id }));
      return {
        ...prev,
        models: [
          ...prev.models.filter((model) => model.id.trim()),
          ...additions,
        ],
      };
    });
  };

  const testButtonDisabled =
    test.status === "testing" || !/^https?:\/\//.test(trimmedBaseUrl);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">
            {provider ? "Edit provider" : "Add provider"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Any endpoint that speaks the OpenAI API. Credentials stay in this
            browser and are sent through your backend to the configured provider.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Connection */}
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-zinc-500">
              Connection
            </p>
            <div>
              <label htmlFor="provider-name" className="block text-xs">
                Name
              </label>
              <Input
                id="provider-name"
                className="mt-1"
                placeholder="GMICloud"
                value={draft.name}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, name: e.target.value }))
                }
              />
              {errors.name && (
                <p className="mt-1 text-xs text-red-500">{errors.name}</p>
              )}
            </div>
            <div>
              <label className="block text-xs">Protocol</label>
              <select
                aria-label="Protocol"
                value={draft.protocol}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    protocol: event.target.value as CustomProviderProtocol,
                  }))
                }
                className="mt-1 w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-sm"
              >
                <option value="chat_completions">
                  Chat Completions (/v1/chat/completions)
                </option>
                <option value="responses">Responses (/v1/responses)</option>
              </select>
            </div>
            <div>
              <label htmlFor="provider-base-url" className="block text-xs">
                Base URL
              </label>
              <Input
                id="provider-base-url"
                className="mt-1"
                placeholder="https://provider.example.com/v1"
                value={draft.baseUrl}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, baseUrl: e.target.value }))
                }
              />
              {errors.baseUrl && (
                <p className="mt-1 text-xs text-red-500">{errors.baseUrl}</p>
              )}
            </div>
            <div>
              <label htmlFor="provider-api-key" className="block text-xs">
                API key{" "}
                <span className="font-normal text-gray-400 dark:text-zinc-500">
                  (optional for local endpoints)
                </span>
              </label>
              <Input
                id="provider-api-key"
                type="password"
                autoComplete="off"
                className="mt-1"
                placeholder="sk-…"
                value={draft.apiKey}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, apiKey: e.target.value }))
                }
              />
            </div>
          </div>

          {/* Models */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-zinc-500">
                Models
              </p>
              {test.discovered.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={addDiscoveredModels}
                >
                  <LuPlus className="mr-1 h-3.5 w-3.5" />
                  Add {test.discovered.length} discovered
                </Button>
              )}
            </div>
            {draft.models.map((model, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  placeholder="Model ID (e.g. qwen3-coder)"
                  value={model.id}
                  onChange={(e) =>
                    setDraft((prev) => {
                      const models = [...prev.models];
                      models[index] = { ...models[index], id: e.target.value };
                      return { ...prev, models };
                    })
                  }
                />
                <Input
                  placeholder="Display name"
                  className="flex-1"
                  value={model.name}
                  onChange={(e) =>
                    setDraft((prev) => {
                      const models = [...prev.models];
                      models[index] = {
                        ...models[index],
                        name: e.target.value,
                      };
                      return { ...prev, models };
                    })
                  }
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Remove model"
                  onClick={() =>
                    setDraft((prev) => ({
                      ...prev,
                      models: prev.models.filter((_, i) => i !== index),
                    }))
                  }
                >
                  <LuTrash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            {errors.models && (
              <p className="text-xs text-red-500">{errors.models}</p>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setDraft((prev) => ({
                  ...prev,
                  models: [...prev.models, { id: "", name: "" }],
                }))
              }
            >
              <LuPlus className="mr-1 h-3.5 w-3.5" />
              Add model
            </Button>
          </div>

          {/* Advanced: headers */}
          <button
            type="button"
            aria-expanded={showHeaders}
            className="text-xs font-semibold uppercase tracking-wide text-gray-400 hover:text-gray-600 dark:text-zinc-500 dark:hover:text-zinc-300"
            onClick={() => setShowHeaders((open) => !open)}
          >
            {showHeaders ? "▾" : "▸"} Advanced · HTTP headers
          </button>
          {showHeaders && (
            <div className="space-y-2 pt-2">
              {draft.headers.map((header, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    placeholder="Header name"
                    value={header.key}
                    onChange={(e) =>
                      setDraft((prev) => {
                        const headers = [...prev.headers];
                        headers[index] = {
                          ...headers[index],
                          key: e.target.value,
                        };
                        return { ...prev, headers };
                      })
                    }
                  />
                  <Input
                    type="password"
                    placeholder="Value"
                    value={header.value}
                    onChange={(e) =>
                      setDraft((prev) => {
                        const headers = [...prev.headers];
                        headers[index] = {
                          ...headers[index],
                          value: e.target.value,
                        };
                        return { ...prev, headers };
                      })
                    }
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Remove header"
                    onClick={() =>
                      setDraft((prev) => ({
                        ...prev,
                        headers: prev.headers.filter((_, i) => i !== index),
                      }))
                    }
                  >
                    <LuTrash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              {errors.headers && (
                <p className="text-xs text-red-500">{errors.headers}</p>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setDraft((prev) => ({
                    ...prev,
                    headers: [...prev.headers, { key: "", value: "" }],
                  }))
                }
              >
                <LuPlus className="mr-1 h-3.5 w-3.5" />
                Add header
              </Button>
            </div>
          )}

          {/* Test connection */}
          <div className="rounded-md border border-gray-200 p-3 dark:border-zinc-700">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-gray-700 dark:text-zinc-300">
                Test connection
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={testButtonDisabled}
                onClick={runTest}
              >
                {test.status === "testing" ? (
                  <LuLoader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <LuRefreshCw className="mr-1 h-3.5 w-3.5" />
                )}
                Run test
              </Button>
            </div>
            {test.status === "ok" && (
              <p className="mt-2 flex items-start gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                <BsCheckCircleFill className="mt-0.5 shrink-0" />
                <span>
                  {test.detail ?? "Connection OK"}
                  {test.discovered.length > 0 &&
                    ` · ${test.discovered.length} models discovered`}
                </span>
              </p>
            )}
            {test.status === "error" && (
              <p className="mt-2 flex items-start gap-1.5 text-xs text-red-500">
                <BsExclamationTriangleFill className="mt-0.5 shrink-0" />
                <span>{test.error ?? "Test failed."}</span>
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!isValid}>
            Save provider
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ProviderDialog;
