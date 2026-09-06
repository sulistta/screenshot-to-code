import { FiLink, FiSettings, FiBox, FiPlay } from "react-icons/fi";
import React, { useEffect, useState } from "react";
import { BsCheckCircleFill, BsExclamationTriangleFill } from "react-icons/bs";
import { AppTheme, Settings } from "../../types";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { native } from "@/lib/native";
import ModelPicker from "@/components/studio/ModelPicker";
import ProvidersSection from "./ProvidersSection";
import type { ModelOption } from "@/components/studio/modelOptions";
import { modelDisplayName } from "@/components/studio/modelOptions";

interface PersistMeta {
  status: "saved" | "saving" | "error";
  error: string | null;
  retry: () => void;
}

interface Props {
  settings: Settings;
  setSettings: React.Dispatch<React.SetStateAction<Settings>>;
  settingsMeta: PersistMeta;
  appTheme: AppTheme;
  setAppTheme: React.Dispatch<React.SetStateAction<AppTheme>>;
  appThemeMeta: PersistMeta;
}

type SettingsSection = "providers" | "models" | "execution" | "general";
const SECTIONS: { id: SettingsSection; label: string; icon: React.ReactNode }[] = [
  { id: "providers", label: "Providers", icon: <FiLink aria-hidden /> },
  { id: "models", label: "Models", icon: <FiBox aria-hidden /> },
  { id: "execution", label: "Execution", icon: <FiPlay aria-hidden /> },
  { id: "general", label: "General", icon: <FiSettings aria-hidden /> },
];

function SettingsTab({ settings, setSettings, settingsMeta, appTheme, setAppTheme, appThemeMeta }: Props) {
  const [screenshotPreviewAvailable, setScreenshotPreviewAvailable] = useState<
    boolean | null
  >(null);
  const [section, setSection] = useState<SettingsSection>("providers");

  useEffect(() => {
    let cancelled = false;
    native<{ screenshot_preview: boolean }>("capabilities")
      .then((data) => {
        if (!cancelled && data && typeof data.screenshot_preview === "boolean") {
          setScreenshotPreviewAvailable(data.screenshot_preview);
        }
      })
      .catch(() => {
        /* leave as null — don't show a false alarm if the backend is unreachable */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const goTo = (id: SettingsSection) => {
    setSection(id);
    document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
  };
  return <div className="settings-page">
    <header className="settings-page-heading"><h1>Settings</h1><p>Configure providers, models, and defaults for your workspace.</p></header>
    <div className="settings-page-layout">
      <nav className="settings-section-nav" aria-label="Settings sections">{SECTIONS.map((entry) => <button key={entry.id} onClick={() => goTo(entry.id)} aria-current={section === entry.id ? "location" : undefined}>{entry.icon}{entry.label}</button>)}</nav>
      <div className="settings-page-sections">
        <section id="settings-providers" className="settings-card"><ProvidersSection settings={settings} setSettings={setSettings} /></section>
        <section id="settings-models" className="settings-card"><ModelsSection /></section>
        <section id="settings-execution" className="settings-card">
          <h2>Execution Defaults</h2><p>Set the default models for new projects and their agents.</p>
          <div className="settings-defaults">
            <div><span>Primary model</span><ModelPicker settings={settings} value={settings.defaultPrimaryModel ?? ""} onChange={(value) => setSettings((s) => ({ ...s, defaultPrimaryModel: value }))} label="Default primary" /></div>
            <div><span>Subagent model</span><ModelPicker settings={settings} value={settings.defaultSubagentModel ?? ""} onChange={(value) => setSettings((s) => ({ ...s, defaultSubagentModel: value }))} label="Default subagent" placeholder="Automatic" /></div>
          </div>
          <p className="settings-footnote">These defaults apply to new projects. You can override them in the composer.</p><PersistStatus meta={settingsMeta} what="Defaults" />
        </section>
        <section id="settings-general" className="settings-card">
          <GeneralSection appTheme={appTheme} setAppTheme={setAppTheme} settings={settings} setSettings={setSettings} settingsMeta={settingsMeta} appThemeMeta={appThemeMeta} />
          <label className="settings-image-toggle"><input type="checkbox" aria-label="Image generation" checked={settings.isImageGenerationEnabled} onChange={(event) => setSettings((s) => ({ ...s, isImageGenerationEnabled: event.target.checked }))} />Allow image generation</label>
          <IntegrationsSection screenshotPreviewAvailable={screenshotPreviewAvailable} settings={settings} setSettings={setSettings} />
        </section>
      </div>
    </div>
  </div>;
}

function ModelsSection() {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    setLoading(true);
    setError(null);
    native<ModelOption[]>("list_models")
      .then((items) => setModels(items))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);
  return (
    <div className="settings-card-content">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-[15px] font-semibold">Models</h2>
          <p className="text-[12.5px] text-stone-500">View and manage models from your configured providers.</p>
        </div>
        <Button variant="outline" size="sm" className="rounded-[9px]" onClick={load} disabled={loading}>⟳ {loading ? "Refreshing…" : "Refresh Models"}</Button>
      </div>
      {error && <p role="alert" className="mt-3 text-[12.5px] text-red-600">Could not refresh models: {error}</p>}
      <div className="settings-model-table">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="bg-stone-50 dark:bg-zinc-800/50 text-left text-stone-500">
              <th className="px-3.5 py-2.5 font-medium">Model</th>
              <th className="px-3.5 py-2.5 font-medium">Provider</th>
              <th className="px-3.5 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {models.length === 0 && <tr><td colSpan={3} className="px-3.5 py-4 text-stone-400">{loading ? "Loading models…" : "No models reported. Configure a provider first."}</td></tr>}
            {models.map((m) => (
              <tr key={`${m.group}:${m.value}`} className="border-t border-stone-100 dark:border-zinc-800">
                <td className="px-3.5 py-2.5 font-medium">{modelDisplayName(m.value) || m.value}</td>
                <td className="px-3.5 py-2.5 text-stone-500">{m.group}</td>
                <td className="px-3.5 py-2.5"><span className="forge-status green"><span className="forge-dot" /> Available</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PersistStatus({ meta, what }: { meta: PersistMeta; what: string }) {
  if (meta.status === "saving") return <span role="status" className="text-[11.5px] text-stone-400">Saving {what}…</span>;
  if (meta.status === "error") {
    return (
      <span role="alert" className="text-[11.5px] text-red-600">
        Could not save {what}: {meta.error}{" "}
        <button className="underline" onClick={meta.retry}>Retry</button>
      </span>
    );
  }
  return <span role="status" className="text-[11.5px] text-stone-400">{what} saved</span>;
}

function GeneralSection({ appTheme, setAppTheme, settingsMeta, appThemeMeta }: Props) {
  return (
    <div className="settings-card-content">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold">General</h2>
        <PersistStatus meta={appThemeMeta} what="Theme" />
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-stone-200/70 dark:border-zinc-800 px-4 py-3">
        <div>
          <span className="text-[13px] font-medium">App Theme</span>
          <p className="mt-0.5 text-[12px] text-stone-500">System default, with optional light/dark override</p>
        </div>
        <select
          name="app-theme"
          aria-label="App theme"
          value={appTheme}
          onChange={(event) => setAppTheme(event.target.value as AppTheme)}
          className="forge-select"
        >
          <option value={AppTheme.SYSTEM}>System</option>
          <option value={AppTheme.LIGHT}>Light</option>
          <option value={AppTheme.DARK}>Dark</option>
        </select>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-[12px] text-stone-500">Preferences</span>
        <PersistStatus meta={settingsMeta} what="Preferences" />
      </div>
    </div>
  );
}

function IntegrationsSection({
  screenshotPreviewAvailable,
  settings,
  setSettings,
}: Pick<Props, "settings" | "setSettings"> & {
  screenshotPreviewAvailable: boolean | null;
}) {
  return (
    <div className="space-y-4">
      <div className="settings-card-content">
        <h2 className="text-[15px] font-semibold">Screenshot Preview</h2>
        <div className="mt-3">
          {screenshotPreviewAvailable === false ? (
            <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/40 dark:bg-amber-950/20">
              <BsExclamationTriangleFill className="mt-0.5 shrink-0 text-amber-500" />
              <div>
                <p className="text-[13px] font-medium text-amber-800 dark:text-amber-200">Screenshot preview is unavailable</p>
                <p className="mt-1 text-[12px] text-amber-700 dark:text-amber-300">Automatic visual verification is not available in this desktop build. Use the project preview to review the result.</p>
              </div>
            </div>
          ) : screenshotPreviewAvailable === true ? (
            <div className="flex items-start gap-2.5">
              <BsCheckCircleFill className="mt-0.5 shrink-0 text-emerald-500" />
              <div>
                <p className="text-[13px]">Available</p>
                <p className="mt-1 text-[12px] text-stone-500">The agent renders your generated page in a headless browser to visually check its work and fix layout issues.</p>
              </div>
            </div>
          ) : (
            <p className="text-[12px] text-stone-400">Checking available tools…</p>
          )}
        </div>
      </div>

      <div className="settings-card-content">
        <h2 className="text-[15px] font-semibold">Replicate</h2>
        <p className="mt-1 text-[12px] text-stone-500">Used for image generation. The key is saved in your operating system’s credential store.</p>
        <Input
          id="replicate-api-key"
          type="password"
          autoComplete="off"
          className="mt-3 rounded-[10px]"
          placeholder="Replicate API key"
          value={settings.replicateApiKey || ""}
          onChange={(e) =>
            setSettings((s) => ({ ...s, replicateApiKey: e.target.value }))
          }
        />
      </div>
    </div>
  );
}

export default SettingsTab;
