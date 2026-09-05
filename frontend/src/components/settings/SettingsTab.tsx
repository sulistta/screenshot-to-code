import { FiLink, FiBox, FiPlay, FiSettings } from "react-icons/fi";
import React, { useEffect, useState } from "react";
import { BsCheckCircleFill, BsExclamationTriangleFill } from "react-icons/bs";
import { AppTheme, Settings } from "../../types";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { native } from "@/lib/native";
import ProvidersSection from "./ProvidersSection";
import { Stack } from "@/lib/stacks";
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

const STACK_LABEL: Record<string, string> = {
  [Stack.HTML_TAILWIND]: "Build (Full Stack)",
  [Stack.HTML_CSS]: "Build (Static)",
  [Stack.REACT_TAILWIND]: "Build (React)",
  [Stack.BOOTSTRAP]: "Build (Bootstrap)",
  [Stack.VUE_TAILWIND]: "Build (Vue)",
  [Stack.IONIC_TAILWIND]: "Build (Ionic)",
};

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

  return (
    <div className="flex-1 min-w-0">
      <div className="mb-5">
        <h1 className="text-[26px] font-bold tracking-tight">Settings</h1>
        <p className="mt-0.5 text-[13px] text-stone-500 dark:text-zinc-400">Configure providers, models, and execution defaults for your self-hosted instance.</p>
      </div>

      <div className="flex flex-col sm:flex-row gap-6 items-start">
        <nav className="hidden sm:flex w-44 shrink-0 flex-col gap-1" aria-label="Settings sections">
          {SECTIONS.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setSection(entry.id)}
              aria-current={section === entry.id ? "page" : undefined}
              className={`flex items-center gap-2.5 rounded-[10px] px-3 py-2 text-left text-[13px] transition-colors ${
                section === entry.id
                  ? "bg-stone-200/70 dark:bg-zinc-800 font-medium text-stone-900 dark:text-white"
                  : "text-stone-500 dark:text-zinc-400 hover:bg-stone-100 dark:hover:bg-zinc-800/50"
              }`}
            >
              <span className="text-[13px]">{entry.icon}</span>
              {entry.label}
            </button>
          ))}
        </nav>

        <div className="sm:hidden mb-3 w-full">
          <select
            aria-label="Settings section"
            value={section}
            onChange={(event) => setSection(event.target.value as SettingsSection)}
            className="forge-select w-full"
          >
            {SECTIONS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex-1 min-w-0 space-y-4">
          {section === "providers" && (
            <div className="forge-card p-5">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h2 className="text-[15px] font-semibold">Providers</h2>
                  <p className="text-[12.5px] text-stone-500">Connect and manage model providers for your self-hosted deployment.</p>
                </div>
              </div>
              <div className="mt-4">
                <ProvidersSection settings={settings} setSettings={setSettings} />
              </div>
            </div>
          )}
          {section === "models" && <ModelsSection />}
          {section === "execution" && (
            <ExecutionSection settings={settings} setSettings={setSettings} />
          )}
          {section === "general" && (
            <div className="space-y-4">
              <GeneralSection appTheme={appTheme} setAppTheme={setAppTheme} settings={settings} setSettings={setSettings} settingsMeta={settingsMeta} appThemeMeta={appThemeMeta} />
              <IntegrationsSection
                screenshotPreviewAvailable={screenshotPreviewAvailable}
                settings={settings}
                setSettings={setSettings}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
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
    <div className="forge-card p-5">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-[15px] font-semibold">Models</h2>
          <p className="text-[12.5px] text-stone-500">View and manage models from your configured providers.</p>
        </div>
        <Button variant="outline" size="sm" className="rounded-[9px]" onClick={load} disabled={loading}>⟳ {loading ? "Refreshing…" : "Refresh Models"}</Button>
      </div>
      {error && <p role="alert" className="mt-3 text-[12.5px] text-red-600">Could not refresh models: {error}</p>}
      <div className="mt-4 overflow-x-auto rounded-xl border border-stone-200/70 dark:border-zinc-800">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="bg-stone-50 dark:bg-zinc-800/50 text-left text-stone-500">
              <th className="px-3.5 py-2.5 font-medium">Model</th>
              <th className="px-3.5 py-2.5 font-medium">Provider</th>
              <th className="px-3.5 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {models.length === 0 && <tr><td colSpan={3} className="px-3.5 py-4 text-stone-400">No models reported. Configure a provider first.</td></tr>}
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

function ExecutionSection({ settings, setSettings }: Pick<Props, "settings" | "setSettings">) {
  return (
    <div className="forge-card p-5">
      <h2 className="text-[15px] font-semibold">Execution</h2>
      <p className="text-[12.5px] text-stone-500">Generation stack for new projects and whether the agent may produce images. Model selection stays per project (“Best available” resolves at run start).</p>
      <div className="mt-4 grid sm:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1.5 text-[12px] text-stone-500">Generation stack
          <span className="forge-select w-full"><select aria-label="Generation stack" value={settings.generatedCodeConfig} onChange={(e) => setSettings((s) => ({ ...s, generatedCodeConfig: e.target.value as Stack }))}>
            {Object.values(Stack).map((s) => <option key={s} value={s}>{STACK_LABEL[s] ?? s}</option>)}
          </select></span>
        </label>
        <label className="flex items-center gap-2 text-[12.5px] pt-6">
          <input
            type="checkbox"
            aria-label="Image generation"
            checked={settings.isImageGenerationEnabled}
            onChange={(event) =>
              setSettings((s) => ({ ...s, isImageGenerationEnabled: event.target.checked }))
            }
            className="h-4 w-4 accent-stone-900"
          /> Image generation
        </label>
      </div>
      <p className="mt-3 text-[11.5px] text-stone-400">When image generation is on, the agent may create images for the project; when off, it skips image work.</p>
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
    <div className="forge-card p-5">
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
      <div className="forge-card p-5">
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

      <div className="forge-card p-5">
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
