import React, { useEffect, useState } from "react";
import { BsCheckCircleFill, BsExclamationTriangleFill } from "react-icons/bs";
import { AppTheme, Settings } from "../../types";
import { Input } from "../ui/input";
import { native } from "@/lib/native";
import ProvidersSection from "./ProvidersSection";

interface Props {
  settings: Settings;
  setSettings: React.Dispatch<React.SetStateAction<Settings>>;
  appTheme: AppTheme;
  setAppTheme: React.Dispatch<React.SetStateAction<AppTheme>>;
}

type SettingsSection = "general" | "providers" | "generation" | "integrations";

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: "general", label: "General" },
  { id: "providers", label: "Providers" },
  { id: "generation", label: "Generation" },
  { id: "integrations", label: "Integrations" },
];

function SettingsTab({ settings, setSettings, appTheme, setAppTheme }: Props) {  // null = not yet known (loading / unreachable); otherwise the backend's answer.
  const [screenshotPreviewAvailable, setScreenshotPreviewAvailable] = useState<
    boolean | null
  >(null);
  const [section, setSection] = useState<SettingsSection>("general");

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
    <div className="flex-1 overflow-hidden">
      <div className="flex h-full flex-col px-4 py-4 lg:px-6 lg:py-6">
        {/* Header */}
        <div className="mb-4">
          <h1 className="text-lg font-semibold text-gray-900 dark:text-white">
            Settings
          </h1>
        </div>

        <div className="flex min-h-0 flex-1 gap-8">
          {/* Section navigation */}
          <nav className="hidden w-40 shrink-0 flex-col gap-1 sm:flex">
            {SECTIONS.map((entry) => (
              <button
                key={entry.id}
                onClick={() => setSection(entry.id)}
                className={`rounded-md px-3 py-2 text-left text-sm transition-colors ${
                  section === entry.id
                    ? "bg-gray-100 font-medium text-gray-900 dark:bg-zinc-800 dark:text-white"
                    : "text-gray-500 hover:bg-gray-50 hover:text-gray-700 dark:text-zinc-400 dark:hover:bg-zinc-800/50 dark:hover:text-zinc-200"
                }`}
              >
                {entry.label}
              </button>
            ))}
          </nav>

          {/* Mobile section switcher */}
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-6">
            <div className="mb-4 sm:hidden">
              <select
                aria-label="Settings section"
                value={section}
                onChange={(event) => setSection(event.target.value as SettingsSection)}
                className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-sm"
              >
                {SECTIONS.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="max-w-2xl">
              {section === "general" && (
                <GeneralSection
                  settings={settings}
                  setSettings={setSettings}
                  appTheme={appTheme}
                  setAppTheme={setAppTheme}
                />
              )}
              {section === "providers" && (
                <ProvidersSection settings={settings} setSettings={setSettings} />
              )}
              {section === "generation" && (
                <GenerationSection
                  settings={settings}
                  setSettings={setSettings}
                />
              )}
              {section === "integrations" && (
                <IntegrationsSection
                  screenshotPreviewAvailable={screenshotPreviewAvailable}
                  settings={settings}
                  setSettings={setSettings}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function GeneralSection({ appTheme, setAppTheme }: Props) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white dark:border-zinc-700 dark:bg-zinc-800/60">
      <div className="border-b border-gray-100 px-4 py-3 dark:border-zinc-700">
        <h2 className="text-sm font-medium text-gray-900 dark:text-white">
          Theme
        </h2>
      </div>
      <div className="divide-y divide-gray-100 dark:divide-zinc-700">
        <div className="flex items-center justify-between px-4 py-3">
          <div>
            <span className="text-sm text-gray-700 dark:text-zinc-300">
              App Theme
            </span>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-zinc-400">
              System default, with optional light/dark override
            </p>
          </div>
          <select
            name="app-theme"
            aria-label="App theme"
            value={appTheme}
            onChange={(event) => setAppTheme(event.target.value as AppTheme)}
            className="w-[140px] rounded-md border border-input bg-transparent px-2 py-1.5 text-sm"
          >
            <option value={AppTheme.SYSTEM}>System</option>
            <option value={AppTheme.LIGHT}>Light</option>
            <option value={AppTheme.DARK}>Dark</option>
          </select>
        </div>
      </div>
    </div>
  );
}

function GenerationSection({
  settings,
  setSettings,
}: Pick<Props, "settings" | "setSettings">) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white dark:border-zinc-700 dark:bg-zinc-800/60">
      <div className="border-b border-gray-100 px-4 py-3 dark:border-zinc-700">
        <h2 className="text-sm font-medium text-gray-900 dark:text-white">
          Image Generation
        </h2>
      </div>
      <div className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-gray-700 dark:text-zinc-300">
              Placeholder Images
            </p>
            <p className="mt-1 text-xs text-gray-500 dark:text-zinc-400">
              More fun with it but if you want to save money, turn it off.
            </p>
          </div>
          <input
            type="checkbox"
            id="image-generation"
            aria-label="Image generation"
            checked={settings.isImageGenerationEnabled}
            onChange={(event) =>
              setSettings((s) => ({
                ...s,
                isImageGenerationEnabled: event.target.checked,
              }))
            }
            className="h-4 w-4 accent-emerald-600"
          />
        </div>
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
    <div className="space-y-6">
      {/* Screenshot Preview (agent self-verification) */}
      <div className="rounded-lg border border-gray-200 bg-white dark:border-zinc-700 dark:bg-zinc-800/60">
        <div className="border-b border-gray-100 px-4 py-3 dark:border-zinc-700">
          <h2 className="text-sm font-medium text-gray-900 dark:text-white">
            Screenshot Preview
          </h2>
        </div>
        <div className="p-4">
          {screenshotPreviewAvailable === false ? (
            <div className="flex items-start gap-2.5 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-700/60 dark:bg-amber-900/20">
              <BsExclamationTriangleFill className="mt-0.5 shrink-0 text-amber-500" />
              <div>
                <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                  Screenshot preview is unavailable
                </p>
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                  Automatic visual verification is not available in this desktop build. Use the project preview to review the result.
                </p>
              </div>
            </div>
          ) : screenshotPreviewAvailable === true ? (
            <div className="flex items-start gap-2.5">
              <BsCheckCircleFill className="mt-0.5 shrink-0 text-emerald-500" />
              <div>
                <p className="text-sm text-gray-700 dark:text-zinc-300">
                  Available
                </p>
                <p className="mt-1 text-xs text-gray-500 dark:text-zinc-400">
                  The agent renders your generated page in a headless browser
                  to visually check its work and fix layout issues.
                </p>
              </div>
            </div>
          ) : (
            <p className="text-xs text-gray-500 dark:text-zinc-400">
              Checking available tools…
            </p>
          )}
        </div>
      </div>

      {/* Replicate (image generation/editing backend) */}
      {(
        <div className="rounded-lg border border-gray-200 bg-white dark:border-zinc-700 dark:bg-zinc-800/60">
          <div className="border-b border-gray-100 px-4 py-3 dark:border-zinc-700">
            <h2 className="text-sm font-medium text-gray-900 dark:text-white">
              Replicate
            </h2>
          </div>
          <div className="p-4">
            <p className="text-xs text-gray-500 dark:text-zinc-400">
              Used for image generation. The key is saved in your operating system’s credential store.
            </p>
            <Input
              id="replicate-api-key"
              type="password"
              autoComplete="off"
              className="mt-3"
              placeholder="Replicate API key"
              value={settings.replicateApiKey || ""}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  replicateApiKey: e.target.value,
                }))
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default SettingsTab;
