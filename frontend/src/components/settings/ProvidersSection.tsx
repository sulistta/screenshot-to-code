import React, { useState } from "react";
import { LuPencil, LuPlus, LuTrash2, LuLink } from "react-icons/lu";
import { CustomProvider, Settings } from "../../types";
import { readProviderTest } from "../../lib/providers";
import { writePreference } from "@/lib/preferences";
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
  const [builtinOpen, setBuiltinOpen] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<CustomProvider | null>(
    null
  );
  const [deletingProvider, setDeletingProvider] = useState<CustomProvider | null>(
    null
  );

  const upsertProvider = (provider: CustomProvider) => {
    const existing = settings.customProviders ?? [];
    const exists = existing.some((p) => p.id === provider.id);
    const customProviders = exists
      ? existing.map((p) => (p.id === provider.id ? provider : p))
      : [...existing, provider];
    const next: Settings = {
      ...settings,
      customProviders,
      // A freshly added provider becomes the one in use; edits keep the
      // current selection.
      activeCustomProviderId: exists
        ? settings.activeCustomProviderId
        : provider.id,
    };
    setSettings(next);
    // The dialog waits for this confirmation before closing.
    return writePreference("setting", next);
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
    <div className="settings-providers">
      <header className="settings-card-heading"><div><h2>Providers</h2><p>Connect and manage model providers for your workspace.</p></div><Button size="sm" onClick={() => { setEditingProvider(null); setDialogOpen(true); }}>Add provider <LuPlus className="ml-2" /></Button></header>
      <div className="settings-provider-list">
        {BUILTIN_ROWS.map((row) => <div key={row.key}>
          <div className="settings-provider-row"><span className="provider-symbol" aria-hidden>{row.label === "OpenAI" ? "◎" : row.label === "Anthropic" ? "AI" : "✦"}</span><div className="provider-identity"><strong>{row.label}</strong><small>{row.label === "OpenAI" ? "api.openai.com" : row.label === "Anthropic" ? "api.anthropic.com" : "generativelanguage.googleapis.com"}</small></div><span className="provider-state"><i />{settings[row.key] ? "Key saved" : "Not configured"}</span><button className="provider-more" aria-label={`Configure ${row.label}`} aria-expanded={builtinOpen === row.key} onClick={() => setBuiltinOpen(builtinOpen === row.key ? null : row.key)}>···</button></div>
          {builtinOpen === row.key && <div className="provider-key-editor"><label htmlFor={row.key}>{row.placeholder}</label><Input id={row.key} type="password" autoComplete="off" placeholder={row.placeholder} value={settings[row.key] || ""} onChange={(event) => handleBuiltinChange(row.key, event.target.value)} /><p>Stored in your operating system’s credential store. A saved key has not been connection-tested.</p>{settings[row.key] && <button onClick={() => handleBuiltinChange(row.key, "")}>Disconnect</button>}</div>}
        </div>)}
        {(settings.customProviders ?? []).map((provider) => {
          const active = settings.activeCustomProviderId === provider.id && provider.enabled;
          const test = readProviderTest(provider.id);
          return <div key={provider.id} className="settings-provider-row"><span className="provider-symbol" aria-hidden><LuLink /></span><div className="provider-identity"><strong>{provider.name}{active && <span className="provider-tag">In use</span>}</strong><small>{provider.baseUrl}</small></div><span className={`provider-state ${test?.ok ? "is-connected" : ""}`}><i />{!provider.enabled ? "Disabled" : test ? test.ok ? "Tested OK" : "Test failed" : "Configured"}</span><div className="provider-row-actions"><Button variant="ghost" size="sm" onClick={() => toggleUse(provider)}>{active ? "Stop using" : "Use"}</Button><Button variant="ghost" size="icon" aria-label={`Edit ${provider.name}`} onClick={() => { setEditingProvider(provider); setDialogOpen(true); }}><LuPencil /></Button><Button variant="ghost" size="icon" aria-label={`Delete ${provider.name}`} onClick={() => setDeletingProvider(provider)}><LuTrash2 /></Button></div></div>;
        })}
      </div>
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
