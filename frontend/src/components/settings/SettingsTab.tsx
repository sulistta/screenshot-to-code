import { Dispatch, SetStateAction, useEffect, useState } from "react";
import { AppTheme, Settings } from "@/types";
import { HTTP_BACKEND_URL, IS_RUNNING_ON_CLOUD } from "@/config";
import ProvidersSection from "./ProvidersSection";
interface Props {
  settings: Settings; setSettings: Dispatch<SetStateAction<Settings>>;
  appTheme: AppTheme; setAppTheme: Dispatch<SetStateAction<AppTheme>>;
}
const sections = ["Providers", "Appearance", "Creative tools", "Advanced"] as const;
export default function SettingsTab({ settings, setSettings, appTheme, setAppTheme }: Props) {
  const [section, setSection] = useState<typeof sections[number]>("Providers");
  const [capability, setCapability] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const check = () => {
    setChecking(true);
    fetch(`${HTTP_BACKEND_URL}/api/capabilities`).then((response) => response.ok ? response.json() : null)
      .then((data) => setCapability(typeof data?.screenshot_preview === "boolean" ? data.screenshot_preview : null))
      .catch(() => setCapability(null)).finally(() => setChecking(false));
  };
  useEffect(check, []);
  return <div className="settings-layout">
    <nav className="settings-navigation" aria-label="Settings categories">{sections.map((item) => <button key={item} aria-current={section === item ? "page" : undefined} onClick={() => setSection(item)}>{item}</button>)}</nav>
    <div className="settings-body">
      {section === "Providers" && <ProvidersSection settings={settings} setSettings={setSettings} />}
      {section === "Appearance" && <section className="settings-section"><h2>Make yourself at home</h2><p>Choose a light or dark workspace, or follow your device.</p><label className="setting-row">Theme<select aria-label="App theme" value={appTheme} onChange={(event) => setAppTheme(event.target.value as AppTheme)}><option value={AppTheme.SYSTEM}>System</option><option value={AppTheme.LIGHT}>Light</option><option value={AppTheme.DARK}>Dark</option></select></label><p>Motion follows your device’s reduced-motion preference.</p></section>}
      {section === "Creative tools" && <section className="settings-section"><h2>Visual assets</h2><p>Let the team create images when your project needs them.</p><label className="setting-row">Generate imagery<input type="checkbox" checked={settings.isImageGenerationEnabled} onChange={(event) => setSettings((current) => ({ ...current, isImageGenerationEnabled: event.target.checked }))} /></label>
        {!IS_RUNNING_ON_CLOUD && <><label htmlFor="replicate-key">Replicate API key</label><input id="replicate-key" type="password" autoComplete="off" value={settings.replicateApiKey || ""} onChange={(event) => setSettings((current) => ({ ...current, replicateApiKey: event.target.value }))} placeholder="Optional · use the backend key by default" /><p>Stored in this browser and used by your backend for image generation and editing.</p></>}
      </section>}
      {section === "Advanced" && <section className="settings-section"><h2>Inspection & diagnostics</h2><div className="setting-row"><span>Browser-based visual review</span><button onClick={check} disabled={checking}>{checking ? "Checking…" : "Check again"}</button></div>
        <p role="status">{checking ? "Checking browser capabilities…" : capability === true ? "Available. The team can render and inspect its work in Chromium." : capability === false ? "Unavailable. Install Playwright Chromium on the backend to enable visual review." : "Could not determine browser availability. Check that the backend is reachable."}</p>
        <div className="setting-row"><span>Model evaluations</span><a href="/evals">Open evaluations ↗</a></div><p>Inspect run records, tool calls, reports, and model comparisons.</p>
      </section>}
    </div>
  </div>;
}
