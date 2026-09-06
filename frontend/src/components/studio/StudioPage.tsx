import { useShallow } from "zustand/react/shallow";
import { native } from "@/lib/native";
import type { StudioProject } from "@/types/studio";
import StudioWorkbench from "./StudioWorkbench";
import ProjectLibrary, { ProjectCollection } from "./ProjectLibrary";
import ConversationColumn from "./conversation/ConversationColumn";
import { useNavigate, useParams } from "react-router-dom";
import "./studio.css";
import { useEffect, useRef, useState } from "react";
import { useStudioStore } from "@/store/studio-store";
import { useProjectEvents } from "@/hooks/useProjectEvents";
import {
  createProject,
  getTranscript,
  listProjects,
  startRun,
  updateProject as updateProjectApi,
} from "@/lib/studioApi";
import { Button } from "@/components/ui/button";
import SettingsTab from "@/components/settings/SettingsTab";
import { usePersistedState } from "@/hooks/usePersistedState";
import { IoSettingsOutline } from "react-icons/io5";
import { AppTheme, Settings } from "@/types";
import { DEFAULT_SETTINGS } from "@/lib/defaultSettings";
import Composer from "./Composer";
import RunDetails from "./conversation/RunDetails";
import { runSettings } from "@/lib/runSettings";
import { useQuery } from "@tanstack/react-query";
import { getFiles } from "@/lib/projectApi";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import WindowTitlebar from "./WindowTitlebar";
import { FiPlusSquare } from "react-icons/fi";
import { useImageAttachments } from "@/hooks/useImageAttachments";
import { savePendingPrompt } from "@/lib/pendingPrompt";

export default function StudioPage() {
  const navigate = useNavigate();
  const { projectId: routeProjectId } = useParams();
  const [projectSearch, setProjectSearch] = useState("");
  const [collection, setCollection] = useState<ProjectCollection>("active");
  const [projectsLoading, setProjectsLoading] = useState(true);
  useEffect(() => {
    const search = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('[aria-label="Search projects"]')?.focus();
      }
    };
    window.addEventListener("keydown", search);
    return () => window.removeEventListener("keydown", search);
  }, []);
  const {
    projects,
    activeProjectId,
    setProjects,
    setActiveProject,
    setTranscript,
    error,
    setError,
  } = useStudioStore(useShallow((s) => ({ projects: s.projects, activeProjectId: s.activeProjectId, setProjects: s.setProjects, setActiveProject: s.setActiveProject, setTranscript: s.setTranscript, error: s.error, setError: s.setError })));
  const [settings, setSettings, settingsMeta] = usePersistedState<Settings>(
    DEFAULT_SETTINGS,
    "setting"
  );
  const [appTheme, setAppTheme, appThemeMeta] = usePersistedState<AppTheme>(
    AppTheme.SYSTEM,
    "app-theme"
  );
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  useEffect(() => { setIsSettingsOpen(false); }, [routeProjectId]);

  useEffect(() => {
    useStudioStore.getState().setSettings(settings);
  }, [settings]);

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
    let cancelled = false;
    setProjectsLoading(true);
    listProjects()
      .then((items) => { if (!cancelled) setProjects(items); })
      .catch(() => { if (!cancelled) setError("Could not load projects"); })
      .finally(() => { if (!cancelled) setProjectsLoading(false); });
    return () => { cancelled = true; };
  }, [setProjects, setError]);

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;
  const routeProjectKnown = !routeProjectId || projects.some((p) => p.id === routeProjectId);

  useEffect(() => {
    if (!activeProjectId || projectsLoading) return;
    if (!projects.some((p) => p.id === activeProjectId)) return;
    let cancelled = false;
    getTranscript(activeProjectId)
      .then((messages) => { if (!cancelled) setTranscript(messages); })
      .catch(() => { if (!cancelled) setError("Could not load the conversation. Select the project again to retry."); });
    return () => { cancelled = true; };
  }, [activeProjectId, projects, projectsLoading, setTranscript, setError]);

  const focusComposer = () => {
    if (!routeProjectId) { document.querySelector<HTMLTextAreaElement>('[aria-label="Project brief"]')?.focus(); return; }
    sessionStorage.setItem("forge:focus-composer", "1");
    navigate("/");
  };

  return (
    <div className="studio-shell">
      <ForgeSidebar
        search={projectSearch}
        onSearch={setProjectSearch}
        collection={collection}
        onCollectionChange={setCollection}
        onNewProject={() => { setIsSettingsOpen(false); focusComposer(); }}
        onSettings={() => setIsSettingsOpen(true)}
        atHome={!routeProjectId}
      />

      <div className="forge-main">
        <WindowTitlebar
          crumb={
            isSettingsOpen ? <span>Settings</span> : activeProject ? (
              <>
                <span className="muted">Projects</span>
                <span className="muted">›</span>
                <span className="truncate">{activeProject.name}</span>
              </>
            ) : (
              <>
                <span className="inline-flex items-center gap-1.5 rounded-md border border-stone-200 dark:border-zinc-700 px-1.5 py-0.5 text-[11px] text-stone-400"><FiPlusSquare /></span>
                <span>New Project</span>
              </>
            )
          }
        />

        <div className="forge-content" style={isSettingsOpen ? { display: "none" } : undefined}>
          {!routeProjectId ? (
            <NewProjectView
              settings={settings}
              onCreated={(id) => navigate(`/projects/${id}`)}
            />
          ) : projectsLoading ? (
            <div className="mx-auto max-w-[880px] pt-16 text-center" role="status">
              <p className="text-[14px] text-stone-500">Loading project…</p>
            </div>
          ) : !routeProjectKnown || !activeProject ? (
            <div className="mx-auto max-w-[880px] pt-16 text-center">
              <p className="forge-eyebrow">NOT FOUND</p>
              <h1 className="mt-3 forge-h1">This project doesn&apos;t exist.</h1>
              <p className="mt-3 forge-sub mx-auto">It may have been moved to the trash or deleted outside the app.</p>
              <div className="mt-6 flex justify-center gap-2">
                <Button onClick={() => navigate("/")} className="rounded-[10px]">Back to projects</Button>
              </div>
            </div>
          ) : (
            <ProjectDetail key={activeProject.id} project={activeProject} settings={settings} />
          )}
        </div>

      </div>

      <Dialog modal={false} open={isSettingsOpen} onOpenChange={setIsSettingsOpen}>
        <DialogContent className="forge-settings-dialog" onCloseAutoFocus={(event) => { event.preventDefault(); document.querySelector<HTMLButtonElement>(".forge-sidebar-foot button")?.focus(); }}>
          <DialogTitle className="sr-only">Settings</DialogTitle>
          <DialogDescription className="sr-only">Providers and preferences. Your project keeps running while this panel is open.</DialogDescription>
          <SettingsTab settings={settings} setSettings={setSettings} settingsMeta={settingsMeta} appTheme={appTheme} setAppTheme={setAppTheme} appThemeMeta={appThemeMeta} />
        </DialogContent>
      </Dialog>

      {error && (
        <div
          role="alert"
          className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-[10px] bg-stone-900 dark:bg-white dark:text-black px-4 py-2 text-[13px] text-white cursor-pointer shadow-lg z-50"
          onClick={() => setError(null)}
        >
          {error}<button className="ml-3 underline" aria-label="Dismiss error" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}
    </div>
  );
}

function ForgeSidebar({
  search, onSearch, collection, onCollectionChange, onNewProject, onSettings, atHome,
}: {
  search: string;
  onSearch: (v: string) => void;
  collection: ProjectCollection;
  onCollectionChange: (v: ProjectCollection) => void;
  onNewProject: () => void;
  onSettings: () => void;
  atHome: boolean;
}) {
  const { setError, setProjects } = useStudioStore(useShallow((s) => ({ setError: s.setError, setProjects: s.setProjects })));
  const navigate = useNavigate();
  return (
    <aside className="forge-sidebar" aria-label="Projects">
      <div className="forge-brand">
        <span className="forge-brand-mark" aria-hidden>
          <svg width="26" height="26" viewBox="0 0 26 26" fill="none"><path d="M13 2.5 23 21H3L13 2.5Z" fill="currentColor" /><path d="M13 8.5 18.5 18h-11L13 8.5Z" fill="var(--forge-sidebar)" /></svg>
        </span>
        <span>
          <span className="forge-brand-name">Forge</span>
        </span>
      </div>

      <div className="forge-search">
        <label className="forge-search-box">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="shrink-0"><circle cx="6" cy="6" r="4.2" stroke="currentColor" strokeWidth="1.4" /><path d="m9.3 9.3 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          <input aria-label="Search projects" placeholder="Search projects…" value={search} onChange={(e) => onSearch(e.target.value)} />
        </label>
        <span className="forge-kbd">⌘ K</span>
      </div>

      <nav className="forge-nav" aria-label="Primary">
        <button aria-current={atHome ? "page" : undefined} onClick={onNewProject}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M2 7 8 2.5 14 7v6.5a.5.5 0 0 1-.5.5H9.5v-4h-3v4H2.5a.5.5 0 0 1-.5-.5V7Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
          New Project
        </button>

      </nav>

      <div className="forge-section-label">
        <span>Projects</span>
        <span className="flex items-center gap-1">
          <button
            title="Import project folder"
            className="text-[11px] px-1 hover:text-stone-900 dark:hover:text-zinc-100"
            onClick={async () => {
              try {
                const project = await native<StudioProject | null>("import_project_folder");
                if (project) {
                  setProjects(await listProjects());
                  navigate(`/projects/${project.id}`);
                }
              } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
            }}
          >Import…</button>
        </span>
      </div>
      <div className="forge-project-list">
        <ProjectLibrary search={search} onSelect={() => undefined} collection={collection} onCollectionChange={onCollectionChange} />
      </div>

      <div className="forge-sidebar-foot">
        <nav className="forge-nav !p-0">
          <button onClick={onSettings}>
            <IoSettingsOutline className="h-[15px] w-[15px]" />
            Settings
          </button>
        </nav>
      </div>
    </aside>
  );
}

function NewProjectView({ settings, onCreated }: { settings: Settings; onCreated: (id: string) => void }) {
  const [brief, setBrief] = useState(() => sessionStorage.getItem("new-project-draft") ?? "");
  const [primary, setPrimary] = useState(settings.defaultPrimaryModel ?? "");
  const [subagent, setSubagent] = useState(settings.defaultSubagentModel ?? "");
  const modelsTouched = useRef(false);
  useEffect(() => {
    if (!modelsTouched.current) { setPrimary(settings.defaultPrimaryModel ?? ""); setSubagent(settings.defaultSubagentModel ?? ""); }
  }, [settings.defaultPrimaryModel, settings.defaultSubagentModel]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const creatingRef = useRef(false);
  const { images, attachError, addFiles, removeAt, clear } = useImageAttachments("new-project-attachments");
  useEffect(() => { sessionStorage.setItem("new-project-draft", brief); }, [brief]);

  const create = async () => {
    const text = brief.trim();
    if (creatingRef.current || (!text && images.length === 0)) return;
    creatingRef.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      const name = text ? text.split("\n")[0].slice(0, 48) || "Untitled project" : "Untitled project";
      const project = await createProject(name, text || "Untitled project");
      useStudioStore.getState().setProjects([project, ...useStudioStore.getState().projects]);
      if (primary || subagent) {
        try {
          const configured = await updateProjectApi(project.id, { primaryModel: primary, subagentModel: subagent });
          useStudioStore.getState().updateProject(configured);
        } catch (error) {
          // Never continue silently with an unconfigured model: keep the
          // project, hand the brief back, and let the user retry inside it.
          const message = error instanceof Error ? error.message : String(error);
          savePendingPrompt(project.id, { text, images, savedAt: Date.now(), error: `Could not start: ${message}. Your brief was kept — retry inside this project.` });
          try { sessionStorage.setItem(`attachments:${project.id}`, JSON.stringify(images)); } catch { /* ignore */ }
          sessionStorage.removeItem("new-project-draft");
          sessionStorage.removeItem("new-project-attachments");
          onCreated(project.id);
          return;
        }
      }
      if (text || images.length > 0) {
        try {
          await startRun(project.id, text || "Build this project.", runSettings(settings, primary, subagent), images);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          savePendingPrompt(project.id, { text, images, savedAt: Date.now(), error: `Could not start: ${message}. Your brief was kept — retry inside this project.` });
          try { sessionStorage.setItem(`attachments:${project.id}`, JSON.stringify(images)); } catch { /* ignore */ }
          sessionStorage.removeItem("new-project-draft");
          sessionStorage.removeItem("new-project-attachments");
          onCreated(project.id);
          return;
        }
      }
      setBrief("");
      sessionStorage.removeItem("new-project-draft");
      clear();
      onCreated(project.id);
    } catch {
      setCreateError("Could not create project");
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  return <div className="forge-new-project">
    <h1 className="forge-h1">What do you want to create?</h1>
    <p className="forge-sub">Start with an idea or a reference. We’ll build from there.</p>
    <Composer isNew value={brief} onChange={(value) => { setBrief(value); setCreateError(null); }} onSubmit={() => void create()}
      settings={settings} primary={primary} subagent={subagent}
      onModelsChange={(patch) => { modelsTouched.current = true; if (patch.primaryModel !== undefined) setPrimary(patch.primaryModel); if (patch.subagentModel !== undefined) setSubagent(patch.subagentModel); }}
      images={images} onFiles={addFiles} onRemove={removeAt} error={createError || attachError} busy={creating} />
  </div>;
}

type ResultLayout = "conversation" | "split" | "result";
function ProjectDetail({ project, settings }: { project: StudioProject; settings: Settings }) {
  const handleEvent = useStudioStore((s) => s.handleEvent);
  const { send, connected } = useProjectEvents(project.id, handleEvent);
  const [panel, setPanel] = useState<"result" | "agents">("result");
  const showAgents = () => { setPanel("agents"); changeLayout("split"); };
  const [layout, setLayout] = useState<ResultLayout>(() => {
    const saved = sessionStorage.getItem(`result-layout:${project.id}`);
    return saved === "split" || saved === "result" ? saved : "conversation";
  });
  const revealed = useRef(sessionStorage.getItem(`result-layout:${project.id}`) !== null);
  const files = useQuery({ queryKey: ["files", project.id], queryFn: () => getFiles(project.id) });
  const ready = Boolean(files.data?.files["index.html"] || files.data?.files["package.json"]);
  useEffect(() => {
    const showConversation = (event: Event) => {
      if ((event as CustomEvent<{ projectId: string }>).detail.projectId !== project.id) return;
      const next = window.matchMedia("(min-width: 1200px)").matches ? "split" : "conversation";
      setLayout(next);
      sessionStorage.setItem(`result-layout:${project.id}`, next);
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')?.focus());
    };
    window.addEventListener("studio:target", showConversation);
    return () => window.removeEventListener("studio:target", showConversation);
  }, [project.id]);
  const question = useStudioStore((s) => s.activeQuestion);

  useEffect(() => {
    if (ready && !revealed.current) {
      revealed.current = true;
      setLayout("split");
      sessionStorage.setItem(`result-layout:${project.id}`, "split");
    }
  }, [ready, project.id]);
  const changeLayout = (next: ResultLayout) => {
    revealed.current = true;
    setLayout(next);
    sessionStorage.setItem(`result-layout:${project.id}`, next);
  };
  return <section className={`project-workspace layout-${layout}`} aria-label="Project workspace">
    {question && <button className="workspace-question-notice" onClick={() => changeLayout("conversation")}>Your answer is needed · Review decision</button>}
    <header className="workspace-heading">
      <h1 title={project.name}>{project.name}</h1>
      <div className="workspace-actions">
        {layout !== "conversation" && <button onClick={() => changeLayout("conversation")}>Overview</button>}
        {layout === "conversation" && <button onClick={() => { setPanel("result"); changeLayout("split"); }}>Show result</button>}
        {layout === "split" && <button onClick={() => changeLayout("result")}>{panel === "agents" ? "Expand agents" : "Expand result"}</button>}
        {layout === "result" && <button onClick={() => changeLayout("split")}>Show overview</button>}
        <button aria-pressed={panel === "agents" && layout !== "conversation"} onClick={showAgents}>Agents</button>
      </div>
    </header>
    <div className="workspace-panels">
      <div className="workspace-conversation" aria-hidden={layout === "result" ? true : undefined}>
        <ConversationColumn projectId={project.id} settings={settings} send={send} connected={connected} onDetails={showAgents} />
      </div>
      <div className="workspace-result" aria-hidden={layout === "conversation" ? true : undefined}>
        <div className="workspace-panel-tabs" role="group" aria-label="Workspace panel"><button aria-pressed={panel === "result"} onClick={() => setPanel("result")}>Result</button><button aria-pressed={panel === "agents"} onClick={() => setPanel("agents")}>Agents</button><button aria-label="Close panel" onClick={() => changeLayout("conversation")}>×</button></div>
        <div className="workspace-panel-body" hidden={panel !== "result"}><StudioWorkbench projectId={project.id} /></div>
        <div className="workspace-panel-body" hidden={panel !== "agents"}><RunDetails visible={panel === "agents" && layout !== "conversation"} projectId={project.id} isApp={Boolean(files.data?.files["package.json"])} /></div>
      </div>
    </div>

  </section>;
}
