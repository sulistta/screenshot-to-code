import StudioWorkbench from "./StudioWorkbench";
import ProjectLibrary from "./ProjectLibrary";
import ConversationColumn from "./conversation/ConversationColumn";
import { useNavigate, useParams } from "react-router-dom";
import "./studio.css";
import { useEffect, useState } from "react";
import { useStudioStore } from "@/store/studio-store";
import {
  createProject,
  getTranscript,
  listProjects,
} from "@/lib/studioApi";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import SettingsTab from "@/components/settings/SettingsTab";
import { usePersistedState } from "@/hooks/usePersistedState";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  IoAdd,
  IoSettingsOutline,
} from "react-icons/io5";
import { AppTheme, Settings } from "@/types";
import { DEFAULT_SETTINGS } from "@/lib/defaultSettings";

export default function StudioPage() {
  const navigate = useNavigate();
  const { projectId: routeProjectId } = useParams();
  const [mobileView, setMobileView] = useState("preview");
  const [projectSearch, setProjectSearch] = useState("");
  const {
    projects,
    activeProjectId,
    setProjects,
    setActiveProject,
    setTranscript,
    error,
    setError,
  } = useStudioStore();
  const [newProjectName, setNewProjectName] = useState("");
  const [creating, setCreating] = useState(false);
  const [settings, setSettings] = usePersistedState<Settings>(
    DEFAULT_SETTINGS,
    "setting"
  );
  const [appTheme, setAppTheme] = usePersistedState<AppTheme>(
    AppTheme.SYSTEM,
    "app-theme"
  );
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // Mirror persisted settings into the store for ConfigBar.
  useEffect(() => {
    useStudioStore.getState().setSettings(settings);
  }, [settings]);

  // Apply the app theme to the document (dark-mode class on html/body).
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark =
        appTheme === AppTheme.DARK ||
        (appTheme === AppTheme.SYSTEM && media.matches);
      document.documentElement.classList.toggle("dark", dark);
      document.body.classList.toggle("dark", dark);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [appTheme]);

  useEffect(() => {
    if ((routeProjectId ?? null) !== activeProjectId) setActiveProject(routeProjectId ?? null);
  }, [routeProjectId, activeProjectId, setActiveProject]);

  useEffect(() => {
    listProjects()
      .then(setProjects)
      .catch(() => setError("Could not load projects"));
  }, [setProjects, setError]);

  useEffect(() => {
    if (!activeProjectId) return;
    let cancelled = false;
    getTranscript(activeProjectId)
      .then((messages) => { if (!cancelled) setTranscript(messages); })
      .catch(() => { if (!cancelled) setError("Could not load the conversation. Select the project again to retry."); });
    return () => { cancelled = true; };
  }, [activeProjectId, setTranscript, setError]);

  const onCreate = async () => {
    setCreating(true);
    try {
      const project = await createProject(
        newProjectName || "Untitled project",
        newProjectName,
      );
      setProjects([project, ...projects]);
      navigate(`/projects/${project.id}`);
      setNewProjectName("");
    } catch {
      setError("Could not create project");
    } finally {
      setCreating(false);
    }
  };



  return (
    <div className="studio-shell" data-mobile-view={mobileView}>
      <nav className="studio-mobile-nav" aria-label="Studio panels">
        {["projects", "chat", "preview"].map((item) => <button key={item} aria-current={mobileView === item ? "page" : undefined} onClick={() => setMobileView(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}
      </nav>
      <aside className="studio-projects">
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <span className="text-sm font-semibold">Studio</span>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            title="Settings"
            onClick={() => setIsSettingsOpen(true)}
          >
            <IoSettingsOutline className="h-4 w-4" />
          </Button>
        </div>
        <div className="px-3 pb-3">
          <div className="flex gap-1.5">
            <Input
              value={newProjectName}
              onChange={(event) => setNewProjectName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onCreate();
              }}
              placeholder="New project…"
              className="h-8 text-sm"
            />
            <Button
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={onCreate}
              disabled={creating}
              title="Create project"
            >
              <IoAdd className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <Input className="mx-3 mb-3 w-auto" aria-label="Search projects" placeholder="Search projects" value={projectSearch} onChange={(event) => setProjectSearch(event.target.value)} />
        <ScrollArea className="flex-1 px-2">
          <ProjectLibrary search={projectSearch} onSelect={() => setMobileView("preview")} />
        </ScrollArea>
        <Separator />
        <div className="px-4 py-3">
          <a
            href="/evals"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Model evals →
          </a>
        </div>
      </aside>

      <section className="studio-conversation">
        {activeProjectId ? (
          <ConversationColumn
            key={activeProjectId}
            projectId={activeProjectId}
            settings={settings}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center px-8 text-center text-sm text-muted-foreground">
            Select or create a project to start.
          </div>
        )}
      </section>

      <main className="studio-main">
        {activeProjectId ? <StudioWorkbench key={activeProjectId} projectId={activeProjectId} /> : <div className="workbench-empty"><span className="studio-eyebrow">SCREENSHOT TO CODE</span><h1>A space for your next idea.</h1><p>Create a project, bring a reference and build something that works.</p><Button className="studio-mobile-start" onClick={() => setMobileView("projects")}>Create a project</Button></div>}
      </main>

      <Dialog open={isSettingsOpen} onOpenChange={setIsSettingsOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
          </DialogHeader>
          <SettingsTab
            settings={settings}
            setSettings={setSettings}
            appTheme={appTheme}
            setAppTheme={setAppTheme}
          />
        </DialogContent>
      </Dialog>

      {error && (
        <div
          role="alert"
          className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-md bg-destructive px-4 py-2 text-sm text-destructive-foreground cursor-pointer"
          onClick={() => setError(null)}
        >
          {error}
        </div>
      )}
    </div>
  );
}
