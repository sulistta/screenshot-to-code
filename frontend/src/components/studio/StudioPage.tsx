import { native } from "@/lib/native";
import type { StudioProject } from "@/types/studio";
import StudioWorkbench, { PreviewWindowButton } from "./StudioWorkbench";
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
import { usePersistedState, PersistStatus } from "@/hooks/usePersistedState";
import { IoAdd, IoSettingsOutline } from "react-icons/io5";
import { AppTheme, Settings } from "@/types";
import { DEFAULT_SETTINGS } from "@/lib/defaultSettings";
import { Stack } from "@/lib/stacks";
import ModelPicker from "./ModelPicker";
import ProjectTools from "./ProjectTools";
import WindowTitlebar from "./WindowTitlebar";
import { FiImage, FiMessageSquare, FiFileText, FiCode, FiPlay, FiSettings, FiPlusSquare } from "react-icons/fi";
import { useImageAttachments } from "@/hooks/useImageAttachments";
import { savePendingPrompt } from "@/lib/pendingPrompt";

type ForgeTab = "planning" | "build" | "preview" | "files" | "settings";
type WorkbenchView = "preview" | "code" | "history" | "compare";

const STACK_LABEL: Record<string, string> = {
  [Stack.HTML_TAILWIND]: "Build (Full Stack)",
  [Stack.HTML_CSS]: "Build (Static)",
  [Stack.REACT_TAILWIND]: "Build (React)",
  [Stack.BOOTSTRAP]: "Build (Bootstrap)",
  [Stack.VUE_TAILWIND]: "Build (Vue)",
  [Stack.IONIC_TAILWIND]: "Build (Ionic)",
};

const PROMPT_SUGGESTIONS = [
  "A SaaS landing page for a productivity tool",
  "An interactive data visualization",
  "A developer documentation site",
  "A full-stack web app with authentication",
];

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
  } = useStudioStore();
  const [settings, setSettings, settingsMeta] = usePersistedState<Settings>(
    DEFAULT_SETTINGS,
    "setting"
  );
  const [appTheme, setAppTheme, appThemeMeta] = usePersistedState<AppTheme>(
    AppTheme.SYSTEM,
    "app-theme"
  );
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [forgeTab, setForgeTab] = useState<ForgeTab>("planning");
  useEffect(() => { setIsSettingsOpen(false); }, [routeProjectId]);
  const [workbenchView, setWorkbenchView] = useState<WorkbenchView>("preview");

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
    setForgeTab("planning");
    setWorkbenchView("preview");
  }, [activeProjectId]);

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

  const onForgeTab = (tab: ForgeTab) => {
    setForgeTab(tab);
    if (tab === "preview") setWorkbenchView("preview");
    if (tab === "files") setWorkbenchView("code");
    if (tab === "planning" || tab === "build") setWorkbenchView("preview");
  };

  const focusComposer = () => {
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
        onViewAll={() => { setProjectSearch(""); setCollection("active"); }}
        onHome={() => { setIsSettingsOpen(false); navigate("/"); }}
        onNewProject={() => { setIsSettingsOpen(false); focusComposer(); }}
        onSettings={() => setIsSettingsOpen(true)}
        atHome={!routeProjectId}
      />

      <div className="forge-main">
        <WindowTitlebar
          crumb={
            isSettingsOpen ? "Settings" : activeProject ? (
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

        <div className="forge-content">
          {isSettingsOpen ? (
            <div className="forge-view mx-auto max-w-[1240px] pt-4">
              <SettingsTab settings={settings} setSettings={setSettings} settingsMeta={settingsMeta} appTheme={appTheme} setAppTheme={setAppTheme} appThemeMeta={appThemeMeta} />
            </div>
          ) : !routeProjectId ? (
            <NewProjectView
              settings={settings}
              setSettings={setSettings}
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
            <ProjectDetail
              project={activeProject}
              settings={settings}
              setSettings={setSettings}
              settingsMeta={settingsMeta}
              appTheme={appTheme}
              setAppTheme={setAppTheme}
              appThemeMeta={appThemeMeta}
              forgeTab={forgeTab}
              onForgeTab={onForgeTab}
              workbenchView={workbenchView}
              onWorkbenchView={setWorkbenchView}
            />
          )}
        </div>

        <footer className="forge-footer">
          <span><strong>Forge v0.1.0</strong> Self-hosted &nbsp;·&nbsp; Your data stays with you.</span>
          <span className="hidden sm:block">{activeProject ? `${activeProject.name} › ${forgeTab}` : "Create › Build › Observe › Refine"}</span>
        </footer>
      </div>

      {error && (
        <div
          role="alert"
          className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-[10px] bg-stone-900 dark:bg-white dark:text-black px-4 py-2 text-[13px] text-white cursor-pointer shadow-lg z-50"
          onClick={() => setError(null)}
        >
          {error}
        </div>
      )}
    </div>
  );
}

function ForgeSidebar({
  search, onSearch, collection, onCollectionChange, onViewAll, onHome, onNewProject, onSettings, atHome,
}: {
  search: string;
  onSearch: (v: string) => void;
  collection: ProjectCollection;
  onCollectionChange: (v: ProjectCollection) => void;
  onViewAll: () => void;
  onHome: () => void;
  onNewProject: () => void;
  onSettings: () => void;
  atHome: boolean;
}) {
  const { setError, setProjects } = useStudioStore();
  const navigate = useNavigate();
  return (
    <aside className="forge-sidebar" aria-label="Projects">
      <div className="forge-brand">
        <span className="forge-brand-mark" aria-hidden>
          <svg width="26" height="26" viewBox="0 0 26 26" fill="none"><path d="M13 2.5 23 21H3L13 2.5Z" fill="currentColor" /><path d="M13 8.5 18.5 18h-11L13 8.5Z" fill="var(--forge-sidebar)" /></svg>
        </span>
        <span>
          <span className="forge-brand-name">Forge</span>
          <span className="block forge-brand-tag">Build what&apos;s next.</span>
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
        <button onClick={onHome}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M2 7 8 2.5 14 7v6.5a.5.5 0 0 1-.5.5H9.5v-4h-3v4H2.5a.5.5 0 0 1-.5-.5V7Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
          Home
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
          <button title="New project" className="text-[15px] leading-none px-1" onClick={onNewProject}>+</button>
        </span>
      </div>
      <div className="forge-project-list">
        <ProjectLibrary search={search} onSelect={() => undefined} collection={collection} onCollectionChange={onCollectionChange} />
        <button className="px-3 py-1.5 text-[12px] text-stone-400 hover:text-stone-700" onClick={onViewAll}>View all…</button>
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

function NewProjectView({ settings, setSettings, onCreated }: { settings: Settings; setSettings: React.Dispatch<React.SetStateAction<Settings>>; onCreated: (id: string) => void }) {
  const [brief, setBrief] = useState("");
  const [primary, setPrimary] = useState("");
  const [subagent, setSubagent] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const creatingRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const briefRef = useRef<HTMLTextAreaElement>(null);
  const { images, attachError, addFiles, removeAt, clear } = useImageAttachments();

  useEffect(() => {
    if (sessionStorage.getItem("forge:focus-composer") === "1") {
      sessionStorage.removeItem("forge:focus-composer");
      briefRef.current?.focus();
    }
  }, []);

  const fillSuggestion = (suggestion: string) => {
    setBrief(suggestion);
    setCreateError(null);
    briefRef.current?.focus();
  };

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
          await updateProjectApi(project.id, { primaryModel: primary || undefined, subagentModel: subagent || undefined });
        } catch (error) {
          // Never continue silently with an unconfigured model: keep the
          // project, hand the brief back, and let the user retry inside it.
          const message = error instanceof Error ? error.message : String(error);
          savePendingPrompt(project.id, { text, images, savedAt: Date.now() });
          try { sessionStorage.setItem(`attachments:${project.id}`, JSON.stringify(images)); } catch { /* ignore */ }
          useStudioStore.getState().setError(`Project created, but the model configuration failed: ${message}. Your brief was kept — retry inside the project.`);
          onCreated(project.id);
          return;
        }
      }
      if (text || images.length > 0) {
        try {
          await startRun(project.id, text || "Build this project.", {
            generatedCodeConfig: settings.generatedCodeConfig,
            primaryModel: primary,
            subagentModel: subagent,
            customProviders: settings.customProviders,
            activeCustomProviderId: settings.activeCustomProviderId,
            openAiApiKey: settings.openAiApiKey,
            anthropicApiKey: settings.anthropicApiKey,
            geminiApiKey: settings.geminiApiKey,
            replicateApiKey: settings.replicateApiKey,
            isImageGenerationEnabled: settings.isImageGenerationEnabled,
          }, images);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          savePendingPrompt(project.id, { text, images, savedAt: Date.now() });
          try { sessionStorage.setItem(`attachments:${project.id}`, JSON.stringify(images)); } catch { /* ignore */ }
          useStudioStore.getState().setError(`Project created, but generation could not start: ${message}. Your brief was kept — retry inside the project without creating a duplicate.`);
          onCreated(project.id);
          return;
        }
      }
      setBrief("");
      clear();
      onCreated(project.id);
    } catch {
      setCreateError("Could not create project");
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  return (
    <div className="forge-new-project">
      <p className="text-center forge-eyebrow">A NEW PROJECT</p>
      <h1 className="mt-3 text-center forge-h1">What do you want to create?</h1>
      <p className="mt-3 text-center forge-sub mx-auto">Describe your idea, add any references, and Forge will help you design, build, and refine it into a working web experience.</p>

      <div className="mt-8 forge-prompt">
        <textarea
          ref={briefRef}
          aria-label="Project brief"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void create(); }}
          placeholder="e.g. A modern marketing website for a design studio with a striking homepage, case studies, and a CMS. Use a minimalist aesthetic…"
          rows={4}
        />
        {images.length > 0 && (
          <div className="flex gap-2 px-5 pb-2">
            {images.map((src, i) => (
              <span key={i} className="relative">
                <img src={src} alt={`Reference ${i + 1}`} className="h-14 w-14 rounded-lg object-cover border" />
                <button aria-label={`Remove reference ${i + 1}`} className="absolute -right-1.5 -top-1.5 rounded-full bg-stone-900 text-white text-[10px] w-4 h-4 leading-none" onClick={() => removeAt(i)}>×</button>
              </span>
            ))}
          </div>
        )}
        {attachError && <p role="alert" className="px-5 pb-2 text-[12px] text-red-600">{attachError}</p>}
        <div className="forge-toolbar">
          <div className="forge-tools">
            <button className="forge-tool forge-add" onClick={() => fileRef.current?.click()}><IoAdd /> Add</button>
            <button className="forge-tool" onClick={() => fileRef.current?.click()}><FiImage aria-hidden /> Image</button>
            <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
          </div>
          <div className="flex items-center gap-2">
            <span className="forge-select">
              <ModelPicker label="" value={primary} onChange={setPrimary} settings={settings} />
            </span>
            <button className="forge-send" disabled={creating || (!brief.trim() && images.length === 0)} onClick={() => void create()} title="Create project">↑</button>
          </div>
        </div>
      </div>
      {createError && <p role="alert" className="mt-3 text-[13px] text-red-600">{createError}</p>}

      <div className="forge-suggestions">
        {PROMPT_SUGGESTIONS.map((s) => <button key={s} className="forge-chip shrink-0" onClick={() => fillSuggestion(s)} title="Fill the brief for review">{s}</button>)}
      </div>

      <div className="forge-configuration">
        <span className="flex items-center gap-2 text-[13px] font-medium pb-2.5"><span className="text-stone-400">⧉</span> Configuration <span className="text-stone-400">^</span></span>
        <label className="flex flex-col gap-1.5 text-[12px] text-stone-500">Primary model
          <span className="forge-select min-w-[170px]"><ModelPicker label="Primary" value={primary} onChange={setPrimary} settings={settings} /></span>
        </label>
        <label className="flex flex-col gap-1.5 text-[12px] text-stone-500">Subagent model
          <span className="forge-select min-w-[170px]"><ModelPicker label="Sub" value={subagent} onChange={setSubagent} settings={settings} /></span>
        </label>
        <label className="flex flex-col gap-1.5 text-[12px] text-stone-500">Execution mode
          <span className="forge-select min-w-[170px]">
            <select aria-label="Execution mode" value={settings.generatedCodeConfig} onChange={(e) => setSettings((s) => ({ ...s, generatedCodeConfig: e.target.value as Stack }))}>
              {Object.values(Stack).map((s) => <option key={s} value={s}>{STACK_LABEL[s] ?? s}</option>)}
            </select>
          </span>
        </label>
        <span className="ml-auto"><button className="forge-btn-primary" disabled={creating || (!brief.trim() && images.length === 0)} onClick={() => void create()}>{creating ? "Creating…" : <>Create Project <span>→</span></>}</button></span>
      </div>
    </div>
  );
}

function ProjectDetail({ project, settings, setSettings, settingsMeta, appTheme, setAppTheme, appThemeMeta, forgeTab, onForgeTab, workbenchView, onWorkbenchView }: {
  project: StudioProject; settings: Settings; setSettings: React.Dispatch<React.SetStateAction<Settings>>;
  settingsMeta: { status: PersistStatus; error: string | null; retry: () => void };
  appTheme: AppTheme; setAppTheme: React.Dispatch<React.SetStateAction<AppTheme>>;
  appThemeMeta: { status: PersistStatus; error: string | null; retry: () => void };
  forgeTab: ForgeTab; onForgeTab: (t: ForgeTab) => void;
  workbenchView: WorkbenchView; onWorkbenchView: (v: WorkbenchView) => void;
}) {
  // The event subscription belongs to the active project, not to the
  // conversation column: switching to Files or Settings must not interrupt
  // run tracking.
  const handleEvent = useStudioStore((s) => s.handleEvent);
  const { send, connected } = useProjectEvents(project.id, handleEvent);
  const initials = project.name.split(/[\s—-]+/).map((p) => p[0]).join("").slice(0, 4).toUpperCase() || "P";
  return (
    <div className="mx-auto max-w-[1240px]">
      <div className="flex items-start justify-between gap-4 pt-2">
        <div className="flex items-start gap-3.5 min-w-0">
          <span className="grid place-items-center w-[68px] h-[68px] rounded-xl bg-stone-200/70 dark:bg-zinc-800 text-[15px] font-bold shrink-0">{initials}</span>
          <span className="min-w-0 pt-1">
            <h1 className="text-[24px] sm:text-[28px] font-bold tracking-tight truncate">{project.name}</h1>
            <p className="mt-0.5 text-[13px] text-stone-500 dark:text-zinc-400 truncate max-w-[560px]">{project.brief || "Add a brief to describe your project."}</p>
          </span>
        </div>
        <span className="flex items-center gap-2 shrink-0 pt-2">
          <PreviewWindowButton projectId={project.id} />
          <ProjectTools projectId={project.id} />
        </span>
      </div>

      <div className="forge-tabs mt-3" role="tablist" aria-label="Project">
        {([["planning", "Planning", FiFileText], ["build", "Build", FiCode], ["preview", "Preview", FiPlay], ["files", "Files", FiFileText], ["settings", "Settings", FiSettings]] as const).map(([tab, label, Icon]) => (
          <button key={tab} role="tab" aria-selected={forgeTab === tab} onClick={() => onForgeTab(tab)}><Icon aria-hidden />{label}</button>
        ))}
      </div>

      {forgeTab === "settings" ? (
        <div className="forge-card mt-4 p-5 sm:p-7">
          <SettingsTab settings={settings} setSettings={setSettings} settingsMeta={settingsMeta} appTheme={appTheme} setAppTheme={setAppTheme} appThemeMeta={appThemeMeta} />
        </div>
      ) : forgeTab === "preview" ? (
        <div className="mt-4 forge-view space-y-4">
          <StudioWorkbench key={project.id} projectId={project.id} view={workbenchView} onViewChange={onWorkbenchView} />
          <div className="forge-card p-4"><ConversationColumn key={`chat-${project.id}`} projectId={project.id} settings={settings} send={send} connected={connected} /></div>
        </div>
      ) : forgeTab === "files" ? (
        <div className="mt-4 forge-view"><StudioWorkbench key={project.id} projectId={project.id} view="code" onViewChange={onWorkbenchView} /></div>
      ) : (
        <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] items-start">
          <div className="min-w-0 space-y-4">
            {forgeTab === "planning" ? <PlanCard projectId={project.id} /> : <ProgressCard projectId={project.id} />}
            <div className="forge-card p-4">
              <div className="forge-eyebrow mb-2.5"><FiMessageSquare aria-hidden /> Project brief</div>
              <ConversationColumn key={`chat-${project.id}`} projectId={project.id} settings={settings} send={send} connected={connected} />
            </div>
          </div>
          <div className="min-w-0">
            <StudioWorkbench key={`wb-${project.id}`} projectId={project.id} view={workbenchView} onViewChange={onWorkbenchView} />
            <div className="mt-3 forge-card px-4 py-3 flex items-center justify-between text-[12px] text-stone-500">
              <span>Configuration</span>
              <Button variant="ghost" size="sm" className="h-7 text-[12px]" onClick={() => onForgeTab("settings")}>Edit</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PlanCard({ projectId }: { projectId: string }) {
  const team = useStudioStore((s) => s.team);
  const runStatus = useStudioStore((s) => s.runStatus);
  const members = Object.values(team).slice(0, 5);
  const steps = members.length > 0
    ? members.map((m, i) => ({ n: i + 1, title: `${m.name} — ${m.role}`, desc: m.objective || m.currentAction || m.status, status: m.status }))
    : [];
  void projectId;
  return (
    <div className="forge-card p-5">
      <div className="flex items-center justify-between">
        <span className="forge-eyebrow">↯ Project plan</span>
        <span className="forge-status green"><span className="forge-dot" /> {runStatus === "running" ? "Building" : runStatus === "waiting_for_user" ? "Awaiting input" : runStatus === "completed" ? "Completed" : "Ready to build"}</span>
      </div>
      <h2 className="mt-2 text-[20px] font-bold">Plan your build</h2>
      <p className="mt-1 text-[13px] text-stone-500 leading-relaxed">Forge will break your idea down into a clear plan. Use the conversation to refine the direction and add details.</p>
      <div className="mt-4">
        {steps.length === 0 && <p className="py-8 text-sm text-stone-500">Your plan will appear here when the team starts working.</p>}
        {steps.map((s) => (
          <div key={s.n} className="flex gap-3.5 py-3.5 border-b border-stone-100 dark:border-zinc-800 last:border-0">
            <span className="flex flex-col items-center"><span className="forge-step-dot">{s.n}</span></span>
            <span className="flex-1 min-w-0">
              <span className="block text-[13.5px] font-medium">{s.title}</span>
              <span className="block mt-0.5 text-[12.5px] text-stone-500 leading-relaxed">{s.desc}</span>
            </span>
            <span className="forge-status shrink-0 self-start capitalize">{String(s.status)}</span>
          </div>
        ))}
      </div>
      <button className="mt-2 forge-btn-secondary !bg-stone-100 !border-0" onClick={() => document.querySelector<HTMLTextAreaElement>(".forge-prompt textarea")?.focus()}>Refine the request</button>
    </div>
  );
}

function ProgressCard({ projectId }: { projectId: string }) {
  const runStatus = useStudioStore((s) => s.runStatus);
  const team = useStudioStore((s) => s.team);
  const members = Object.values(team);
  const completed = members.filter((member) => member.status === "completed").length;
  void projectId;
  return (
    <div className="forge-card p-5">
      <div className="forge-eyebrow">Project progress</div>
      <h2 className="mt-2 text-xl font-semibold">{runStatus === "waiting_for_user" ? "Your input is needed" : runStatus === "running" ? "Building your project" : runStatus ? runStatus.replace(/_/g, " ") : "Ready to begin"}</h2>
      <p className="mt-2 text-sm text-stone-500">{members.length ? `${completed} of ${members.length} agents completed` : "Start a run to follow the team's progress."}</p>
      <div className="mt-4 space-y-3">
        {members.map((member) => <div key={member.agentId} className="flex items-center gap-3 rounded-lg border border-stone-200 dark:border-zinc-800 p-3">
          <span className={`forge-step-dot ${member.status === "completed" ? "done" : ""}`}><FiCode aria-hidden /></span>
          <div className="min-w-0 flex-1"><p className="text-sm font-medium">{member.name}</p><p className="text-xs text-stone-500 truncate">{member.currentAction || member.objective}</p></div>
          <span className="forge-status capitalize">{member.status}</span>
        </div>)}
      </div>
    </div>
  );
}
