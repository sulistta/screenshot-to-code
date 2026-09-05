import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useStudioStore } from "@/store/studio-store";
import { listProjects } from "@/lib/studioApi";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import SettingsTab from "@/components/settings/SettingsTab";
import { usePersistedState } from "@/hooks/usePersistedState";
import { AppTheme, Settings } from "@/types";
import { DEFAULT_SETTINGS } from "@/lib/defaultSettings";
import ProjectLibrary from "./ProjectLibrary";
import ProjectSession from "./ProjectSession";
import "./studio.css";

export default function StudioPage() {
  const navigate = useNavigate();
  const { projectId } = useParams();
  const [surface, setSurface] = useState<"library" | "settings" | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [settings, setSettings] = usePersistedState<Settings>(DEFAULT_SETTINGS, "setting");
  const [appTheme, setAppTheme] = usePersistedState<AppTheme>(AppTheme.SYSTEM, "app-theme");
  const projects = useStudioStore((state) => state.projects);
  const activeProjectId = useStudioStore((state) => state.activeProjectId);
  const project = projects.find((item) => item.id === projectId);
  useEffect(() => { useStudioStore.getState().setSettings(settings); }, [settings]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = appTheme === AppTheme.DARK || (appTheme === AppTheme.SYSTEM && media.matches);
      document.documentElement.classList.toggle("dark", dark);
      document.body.classList.toggle("dark", dark);
    };
    apply(); media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [appTheme]);
  useEffect(() => { useStudioStore.getState().setActiveProject(projectId ?? null); }, [projectId]);
  const loadProjects = () => {
    setLoading(true); setLoadError(false);
    listProjects().then(useStudioStore.getState().setProjects).catch(() => setLoadError(true)).finally(() => setLoading(false));
  };
  useEffect(loadProjects, []);

  return <div className="studio-shell">
    <a className="skip-link" href="#creative-work">Skip to workspace</a>
    <header className="studio-header">
      <button className="studio-brand" onClick={() => navigate("/")} aria-label="Studio home"><span aria-hidden="true">▰</span> Studio</button>
      <span className="header-rule" aria-hidden="true" />
      <button className="project-switch" onClick={() => setSurface("library")} aria-label="Open project library">
        <span>{project?.name ?? "Your projects"}</span><span aria-hidden="true">⌄</span>
      </button>
      <nav aria-label="Studio" className="header-actions">
        {projectId && <button onClick={() => navigate("/")}>New project <span aria-hidden="true">＋</span></button>}
        <button onClick={() => setSurface("settings")}>Settings</button>
      </nav>
    </header>
    <main id="creative-work" className="studio-content">
      {projectId && loading ? <div className="session-loading" role="status">Opening your project…</div> :
        projectId && !project ? <div className="session-loading"><h1>{loadError ? "Projects couldn’t be loaded." : "Project not found."}</h1><button onClick={loadProjects}>Try again</button><button onClick={() => navigate("/")}>Start a project</button></div> :
        activeProjectId === (projectId ?? null) && <ProjectSession key={projectId ?? "new"} project={project} settings={settings} onSettings={() => setSurface("settings")} />}
    </main>
    <Dialog open={surface === "library"} onOpenChange={(open) => !open && setSurface(null)}>
      <DialogContent className="studio-dialog library-dialog">
        <DialogHeader><DialogTitle>Your projects</DialogTitle><DialogDescription>Pick up an idea where you left it.</DialogDescription></DialogHeader>
        <div className="library-search"><input aria-label="Search projects" placeholder="Find a project…" value={search} onChange={(event) => setSearch(event.target.value)} /><button onClick={() => { navigate("/"); setSurface(null); }}>New project ＋</button></div>
        {loading ? <p role="status">Loading projects…</p> : loadError ? <p role="alert">Could not load projects. <button onClick={loadProjects}>Retry</button></p> : <ProjectLibrary search={search} onSelect={() => setSurface(null)} />}
      </DialogContent>
    </Dialog>
    <Dialog open={surface === "settings"} onOpenChange={(open) => !open && setSurface(null)}>
      <DialogContent className="studio-dialog settings-dialog">
        <DialogHeader><DialogTitle>Studio settings</DialogTitle><DialogDescription>Connections, creative tools, and your workspace preferences.</DialogDescription></DialogHeader>
        <SettingsTab settings={settings} setSettings={setSettings} appTheme={appTheme} setAppTheme={setAppTheme} />
      </DialogContent>
    </Dialog>
  </div>;
}
