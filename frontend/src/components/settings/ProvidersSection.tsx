import React, { useState } from "react";
import { LuPencil, LuPlus, LuTrash2 } from "react-icons/lu";
import { CustomProvider, Settings } from "../../types";
import { IS_RUNNING_ON_CLOUD } from "../../config";
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
import ProviderDialog from "./ProviderDialog";

interface Props {
  settings: Settings;
  setSettings: React.Dispatch<React.SetStateAction<Settings>>;
}

interface BuiltinProviderRow {
  key: "openAiApiKey" | "anthropicApiKey" | "geminiApiKey";
  label: string;
  placeholder: string;
}

const BUILTIN_ROWS: BuiltinProviderRow[] = [
  { key: "openAiApiKey", label: "OpenAI", placeholder: "OpenAI API key" },
  {
    key: "anthropicApiKey",
    label: "Anthropic",
    placeholder: "Anthropic API key",
  },
  { key: "geminiApiKey", label: "Gemini", placeholder: "Gemini API key" },
];

function ProvidersSection({ settings, setSettings }: Props) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<CustomProvider | null>(
    null
  );
  const [deletingProvider, setDeletingProvider] = useState<CustomProvider | null>(
    null
  );

  const upsertProvider = (provider: CustomProvider) => {
    setSettings((prev) => {
      const existing = prev.customProviders ?? [];
      const exists = existing.some((p) => p.id === provider.id);
      const customProviders = exists
        ? existing.map((p) => (p.id === provider.id ? provider : p))
        : [...existing, provider];
      return {
        ...prev,
        customProviders,
        // A freshly added provider becomes the one in use; edits keep the
        // current selection.
        activeCustomProviderId: exists
          ? prev.activeCustomProviderId
          : provider.id,
      };
    });
  };

  const handleDelete = () => {
    if (!deletingProvider) return;
    const id = deletingProvider.id;
    setSettings((prev) => ({
      ...prev,
      customProviders: (prev.customProviders ?? []).filter(
        (p) => p.id !== id
      ),
      activeCustomProviderId:
        prev.activeCustomProviderId === id ? null : prev.activeCustomProviderId,
    }));
    setDeletingProvider(null);
  };

  const toggleUse = (provider: CustomProvider) => {
    setSettings((prev) => ({
      ...prev,
      activeCustomProviderId:
        prev.activeCustomProviderId === provider.id ? null : provider.id,
      // Selecting a disabled provider implicitly re-enables it.
      customProviders: prev.customProviders.map((p) =>
        p.id === provider.id && prev.activeCustomProviderId !== provider.id
          ? { ...p, enabled: true }
          : p
      ),
    }));
  };

  const handleBuiltinChange = (
    key: BuiltinProviderRow["key"],
    value: string
  ) => {
    setSettings((prev) => ({ ...prev, [key]: value || null }));
  };

  return (
    <div className="space-y-6">
      {/* Built-in providers */}
      <div className="settings-section">
        <div className="border-b border-gray-100 px-4 py-3 dark:border-zinc-700">
          <h2 className="text-sm font-medium text-gray-900 dark:text-white">
            Built-in providers
          </h2>
        </div>
        <div className="divide-y divide-gray-100 dark:divide-zinc-700">
          {BUILTIN_ROWS.map((row) => (
            <div key={row.key} className="px-4 py-3">
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-700 dark:text-zinc-300">
                  {row.label}
                </p>
                {settings[row.key] && (
                  <button
                    className="text-xs text-gray-400 hover:text-red-500 dark:text-zinc-500 dark:hover:text-red-400"
                    onClick={() => handleBuiltinChange(row.key, "")}
                  >
                    Disconnect
                  </button>
                )}
              </div>
              <Input
                id={row.key}
                aria-label={row.placeholder}
                type="password"
                autoComplete="off"
                className="mt-2"
                placeholder={row.placeholder}
                value={settings[row.key] || ""}
                onChange={(e) => handleBuiltinChange(row.key, e.target.value)}
              />
            </div>
          ))}
        </div>
        <p className="px-4 py-3 text-xs text-gray-500 dark:text-zinc-400">
          Keys are only stored in this browser and override your .env config.
        </p>
      </div>

      {/* Custom providers */}
      {!IS_RUNNING_ON_CLOUD && (
        <div className="settings-section">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-zinc-700">
            <h2 className="text-sm font-medium text-gray-900 dark:text-white">
              Custom providers
            </h2>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEditingProvider(null);
                setDialogOpen(true);
              }}
            >
              <LuPlus className="mr-1 h-3.5 w-3.5" />
              Add provider
            </Button>
          </div>
          {(settings.customProviders ?? []).length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-gray-500 dark:text-zinc-400">
              No custom providers yet. Add one to generate with any
              OpenAI-compatible endpoint.
            </p>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-zinc-700">
              {(settings.customProviders ?? []).map((provider) => {
                const isActive =
                  settings.activeCustomProviderId === provider.id &&
                  provider.enabled;
                return (
                  <div
                    key={provider.id}
                    className="flex items-center justify-between gap-3 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm text-gray-700 dark:text-zinc-300">
                          {provider.name}
                        </p>
                        {isActive && (
                          <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-400">Selected</span>
                        )}
                        {!provider.enabled && (
                          <span className="rounded-full border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            Disabled
                          </span>
                        )}
                      </div>
                      <p className="truncate text-xs text-gray-500 dark:text-zinc-400">
                        {provider.baseUrl || "No Base URL"} ·{" "}
                        {provider.models.length}{" "}
                        {provider.models.length === 1 ? "model" : "models"}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => toggleUse(provider)}
                      >
                        {isActive ? "Stop using" : "Use"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Edit ${provider.name}`}
                        onClick={() => {
                          setEditingProvider(provider);
                          setDialogOpen(true);
                        }}
                      >
                        <LuPencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete ${provider.name}`}
                        className="text-gray-400 hover:text-red-500 dark:text-zinc-500 dark:hover:text-red-400"
                        onClick={() => setDeletingProvider(provider)}
                      >
                        <LuTrash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <p className="px-4 py-3 text-xs text-gray-500 dark:text-zinc-400">
            Models from the selected provider are available in project model settings.
            Built-in models remain available when their keys are configured.
          </p>
        </div>
      )}

      <ProviderDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        provider={editingProvider}
        onSave={upsertProvider}
      />

      <Dialog
        open={deletingProvider !== null}
        onOpenChange={(open) => !open && setDeletingProvider(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete {deletingProvider?.name}?
            </DialogTitle>
            <DialogDescription>
              This removes the provider's configuration and saved API key.
              Built-in keys are used again until you add or select another
              provider.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingProvider(null)}>
              Cancel
            </Button>
            <Button
              className="bg-red-600 hover:bg-red-700"
              onClick={handleDelete}
            >
              Delete provider
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default ProvidersSection;
