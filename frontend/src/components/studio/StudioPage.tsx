import { FiArrowUpRight } from "react-icons/fi";
import { native } from "@/lib/native";
import type { StudioProject } from "@/types/studio";
import StudioWorkbench from "./StudioWorkbench";
import ProjectLibrary from "./ProjectLibrary";
import ConversationColumn from "./conversation/ConversationColumn";
import { useNavigate, useParams } from "react-router-dom";
import "./studio.css";
import { useEffect, useRef, useState } from "react";
import { useStudioStore } from "@/store/studio-store";
import {
  createProject,
  getTranscript,
  listProjects,
  openPreview,
  startRun,
  updateProject as updateProjectApi,
} from "@/lib/studioApi";
import { Button } from "@/components/ui/button";
import SettingsTab from "@/components/settings/SettingsTab";
import { usePersistedState } from "@/hooks/usePersistedState";
import { IoAdd, IoSettingsOutline } from "react-icons/io5";
import { AppTheme, Settings } from "@/types";
import { DEFAULT_SETTINGS } from "@/lib/defaultSettings";
import { Stack } from "@/lib/stacks";
import ModelPicker from "./ModelPicker";
import ProjectTools from "./ProjectTools";
import WindowTitlebar from "./WindowTitlebar";
import { FiImage, FiVideo, FiLink, FiPaperclip, FiMessageSquare, FiFileText, FiCode, FiPlay, FiSettings, FiPlusSquare } from "react-icons/fi";

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
  const [settings, setSettings] = usePersistedState<Settings>(
    DEFAULT_SETTINGS,
    "setting"
  );
  const [appTheme, setAppTheme] = usePersistedState<AppTheme>(
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
    listProjects()
      .then(setProjects)
      .catch(() => setError("Could not load projects"));
  }, [routeProjectId, setProjects, setError]);

  useEffect(() => {
    if (!activeProjectId) return;
    let cancelled = false;
    getTranscript(activeProjectId)
      .then((messages) => { if (!cancelled) setTranscript(messages); })
      .catch(() => { if (!cancelled) setError("Could not load the conversation. Select the project again to retry."); });
    return () => { cancelled = true; };
  }, [activeProjectId, setTranscript, setError]);

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;

  const onForgeTab = (tab: ForgeTab) => {
    setForgeTab(tab);
    if (tab === "preview") setWorkbenchView("preview");
    if (tab === "files") setWorkbenchView("code");
    if (tab === "planning" || tab === "build") setWorkbenchView("preview");
  };

  return (
    <div className="studio-shell">
      <ForgeSidebar
        search={projectSearch}
        onSearch={setProjectSearch}
        onHome={() => { setIsSettingsOpen(false); navigate("/"); }}
        onSettings={() => setIsSettingsOpen(true)}
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
            <div className="forge-view mx-auto max-w-[1240px] pt-4"><SettingsTab settings={settings} setSettings={setSettings} appTheme={appTheme} setAppTheme={setAppTheme} /></div>
          ) : !activeProjectId || !activeProject ? (
            <NewProjectView
              settings={settings}
              setSettings={setSettings}
              onCreated={(id) => navigate(`/projects/${id}`)}
            />
          ) : (
            <ProjectDetail
              project={activeProject}
              settings={settings}
              setSettings={setSettings}
              appTheme={appTheme}
              setAppTheme={setAppTheme}
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

function ForgeSidebar({ search, onSearch, onHome, onSettings }: { search: string; onSearch: (v: string) => void; onHome: () => void; onSettings: () => void }) {
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
        <button aria-current={location.hash === "#/" ? "page" : undefined} onClick={onHome}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M2 7 8 2.5 14 7v6.5a.5.5 0 0 1-.5.5H9.5v-4h-3v4H2.5a.5.5 0 0 1-.5-.5V7Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
          New Project
        </button>
        <button onClick={onHome}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M2 7 8 2.5 14 7v6.5a.5.5 0 0 1-.5.5H9.5v-4h-3v4H2.5a.5.5 0 0 1-.5-.5V7Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
          Home
        </button>
        <button disabled title="Explore is not available">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3" /><path d="M8 2.5c-3 3-3 8 0 11M8 2.5c3 3 3 8 0 11M2.5 8h11" stroke="currentColor" strokeWidth="1.1" /></svg>
          Explore
        </button>
        <button disabled title="Templates are not available">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" /><rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" /><rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" /><rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" /></svg>
          Templates
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
                if (project) { setProjects(await listProjects()); navigate(`/projects/${project.id}`); }
              } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
            }}
          >Import…</button>
          <button title="New project" className="text-[15px] leading-none px-1" onClick={onHome}>+</button>
        </span>
      </div>
      <div className="forge-project-list">
        <ProjectLibrary search={search} onSelect={() => undefined} />
        <button className="px-3 py-1.5 text-[12px] text-stone-400 hover:text-stone-700" onClick={() => onSearch("")}>View all…</button>
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
  const { projects, setProjects, setError } = useStudioStore();
  const [brief, setBrief] = useState("");
  const [primary, setPrimary] = useState("");
  const [subagent, setSubagent] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const attach = (list: FileList | null) => {
    if (!list) return;
    Array.from(list).filter((f) => f.type.startsWith("image/")).slice(0, 5).forEach((file) => {
      const r = new FileReader();
      r.onload = () => setImages((p) => [...p, String(r.result)].slice(0, 5));
      r.readAsDataURL(file);
    });
  };

  const create = async (initialText?: string) => {
    const text = (initialText ?? brief).trim();
    if (creating || (!text && images.length === 0)) return;
    setCreating(true);
    try {
      const name = text ? text.split("\n")[0].slice(0, 48) || "Untitled project" : "Untitled project";
      const project = await createProject(name, text || "Untitled project");
      if (primary || subagent) {
        try {
          await updateProjectApi(project.id, { primaryModel: primary || undefined, subagentModel: subagent || undefined });
        } catch { /* keep defaults */ }
      }
      setProjects([project, ...projects]);
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
        } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
      }
      setBrief("");
      setImages([]);
      onCreated(project.id);
    } catch {
      setError("Could not create project");
    } finally {
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
          aria-label="Project brief"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void create(); }}
          placeholder="e.g. A modern marketing website for a design studio with a striking homepage, case studies, and a CMS. Use a minimalist aesthetic…"
          rows={4}
        />
        {images.length > 0 && <div className="flex gap-2 px-5 pb-2">{images.map((src, i) => <img key={i} src={src} alt="ref" className="h-14 w-14 rounded-lg object-cover border" />)}</div>}
        <div className="forge-toolbar">
          <div className="forge-tools">
            <button className="forge-tool forge-add" onClick={() => fileRef.current?.click()}><IoAdd /> Add</button>
            <button className="forge-tool" onClick={() => fileRef.current?.click()}><FiImage aria-hidden /> Image</button>
            <button className="forge-tool" disabled title="Only images are supported in this build"><FiVideo aria-hidden /> Video</button>
            <button className="forge-tool" disabled title="Only images are supported in this build"><FiLink aria-hidden /> Link</button>
            <button className="forge-tool" disabled title="Only images are supported in this build"><FiPaperclip aria-hidden /> Files</button>
            <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { attach(e.target.files); e.target.value = ""; }} />
          </div>
          <div className="flex items-center gap-2">
            <span className="forge-select">
              <ModelPicker label="" value={primary} onChange={setPrimary} settings={settings} />

            </span>
            <button className="forge-send" disabled={creating || (!brief.trim() && images.length === 0)} onClick={() => void create()} title="Create project">↑</button>
          </div>
        </div>
      </div>

      <div className="forge-suggestions">
        {PROMPT_SUGGESTIONS.map((s) => <button key={s} className="forge-chip shrink-0" onClick={() => void create(s)}>{s}</button>)}
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
        <span className="ml-auto"><button className="forge-btn-primary" disabled={creating || (!brief.trim() && images.length === 0)} onClick={() => void create()}>Create Project <span>→</span></button></span>
      </div>
    </div>
  );
}

function ProjectDetail({ project, settings, setSettings, appTheme, setAppTheme, forgeTab, onForgeTab, workbenchView, onWorkbenchView }: {
  project: StudioProject; settings: Settings; setSettings: React.Dispatch<React.SetStateAction<Settings>>;
  appTheme: AppTheme; setAppTheme: React.Dispatch<React.SetStateAction<AppTheme>>;
  forgeTab: ForgeTab; onForgeTab: (t: ForgeTab) => void;
  workbenchView: WorkbenchView; onWorkbenchView: (v: WorkbenchView) => void;
}) {
  const setError = useStudioStore((s) => s.setError);
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
          <button className="forge-btn-secondary" onClick={() => openPreview(project.id).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))}>Open in Browser <FiArrowUpRight aria-hidden className="inline-block" /></button>
          <ProjectTools projectId={project.id} />
        </span>
      </div>

      <div className="forge-tabs mt-3" role="tablist" aria-label="Project">
        {([["planning", "Planning", FiFileText], ["build", "Build", FiCode], ["preview", "Preview", FiPlay], ["files", "Files", FiLink], ["settings", "Settings", FiSettings]] as const).map(([tab, label, Icon]) => (
          <button key={tab} role="tab" aria-selected={forgeTab === tab} onClick={() => onForgeTab(tab)}><Icon aria-hidden />{label}</button>
        ))}
      </div>

      {forgeTab === "settings" ? (
        <div className="forge-card mt-4 p-5 sm:p-7">
          <SettingsTab settings={settings} setSettings={setSettings} appTheme={appTheme} setAppTheme={setAppTheme} />
        </div>
      ) : forgeTab === "preview" ? (
        <div className="mt-4 forge-view space-y-4"><StudioWorkbench projectId={project.id} view={workbenchView} onViewChange={onWorkbenchView} /><div className="forge-card p-4"><ConversationColumn projectId={project.id} settings={settings} /></div></div>
      ) : forgeTab === "files" ? (
        <div className="mt-4 forge-view"><StudioWorkbench projectId={project.id} view="code" onViewChange={onWorkbenchView} /></div>
      ) : (
        <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] items-start">
          <div className="min-w-0 space-y-4">
            {forgeTab === "planning" ? <PlanCard projectId={project.id} /> : <ProgressCard projectId={project.id} />}
            <div className="forge-card p-4">
              <div className="forge-eyebrow mb-2.5"><FiMessageSquare aria-hidden /> Project brief</div>
              <ConversationColumn projectId={project.id} settings={settings} />
            </div>
          </div>
          <div className="min-w-0">
            <StudioWorkbench projectId={project.id} view={workbenchView} onViewChange={onWorkbenchView} />
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
  const activity = useStudioStore((s) => s.activity);
  const runStatus = useStudioStore((s) => s.runStatus);
  const members = Object.values(team).slice(0, 5);
  const steps = members.length > 0
    ? members.map((m, i) => ({ n: i + 1, title: `${m.name} — ${m.role}`, desc: m.objective || m.currentAction || m.status, status: m.status }))
    : [];
  void projectId;
  void activity;
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
      <button className="mt-2 forge-btn-secondary !bg-stone-100 !border-0" onClick={() => document.querySelector<HTMLTextAreaElement>(".forge-prompt textarea")?.focus()}>+ Add a step</button>
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
