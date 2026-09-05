import StudioWorkbench from "./StudioWorkbench";
import ProjectLibrary from "./ProjectLibrary";
import { useNavigate, useParams } from "react-router-dom";
import "./studio.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStudioStore } from "@/store/studio-store";
import { useProjectSocket } from "@/hooks/useProjectSocket";
import {
  cancelRun,
  createProject,
  getTranscript,
  listProjects,
  startRun,
  updateProject as updateProjectApi,
} from "@/lib/studioApi";
import type { StudioActivityItem } from "@/store/studio-store";
import ModelPicker from "@/components/studio/ModelPicker";
import { modelDisplayName } from "@/components/studio/modelOptions";
import type { StudioProject } from "@/types/studio";
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
import { Textarea } from "@/components/ui/textarea";
import {
  IoArrowUp,
  IoAdd,
  IoStop,
  IoRefreshOutline,
  IoSettingsOutline,
  IoImageOutline,
  IoCloseCircle,
} from "react-icons/io5";
import { AppTheme, Settings } from "@/types";
import { DEFAULT_SETTINGS } from "@/lib/defaultSettings";

const RUN_STATUS_LABEL: Record<string, string> = {
  running: "Working",
  waiting_for_user: "Waiting for you",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
  stuck: "Stuck",
};


/** Human phase for the current activity, derived from the latest tool. */
function phaseFromActivity(activity: StudioActivityItem[]): string | null {
  for (let i = activity.length - 1; i >= 0; i -= 1) {
    const tool = activity[i].toolName;
    if (!tool) continue;
    if (tool === "screenshot_preview") return "Reviewing the result visually";
    if (tool === "spawn_agent") return "Delegating to a specialist";
    if (tool === "research") return "Checking references";
    if (tool === "generate_images" || tool === "edit_images" || tool === "remove_backgrounds")
      return "Producing visual assets";
    if (tool === "extract_assets") return "Extracting assets from references";
    if (tool === "create_file" || tool === "edit_file") return "Writing the project";
    if (tool === "list_files" || tool === "read_file") return "Inspecting the project";
  }
  return null;
}

function ActivityItem({ item }: { item: StudioActivityItem }) {
  if (item.kind === "thinking") {
    return (
      <div className="text-xs italic text-muted-foreground/80 whitespace-pre-wrap leading-relaxed">
        {item.text}
      </div>
    );
  }
  if (item.kind === "assistant") {
    return (
      <div className="text-sm whitespace-pre-wrap leading-relaxed">
        {item.text}
      </div>
    );
  }
  if (item.kind === "tool") {
    const failed = item.ok === false;
    const summary = item.toolDetail || item.toolName;
    return (
      <div
        className={`flex items-center gap-2 text-xs ${
          failed ? "text-destructive" : "text-muted-foreground"
        }`}
        title={item.toolName}
      >
        <span
          className={`inline-block h-1 w-1 rounded-full ${
            failed ? "bg-destructive" : "bg-emerald-600"
          }`}
        />
        <span>{failed ? `${summary} — failed` : summary}</span>
      </div>
    );
  }
  return <div className="text-xs text-muted-foreground/70">{item.text}</div>;
}

function ConfigBar({ project }: { project: StudioProject }) {
  const updateProject = useStudioStore((state) => state.updateProject);
  const setError = useStudioStore((state) => state.setError);
  const settings = useStudioStore((state) => state.settings);
  const [editing, setEditing] = useState(false);

  const save = async (
    patch: Partial<StudioProject> & {
      primaryModel?: string;
      subagentModel?: string;
    },
  ) => {
    try {
      // Always send the full configuration: partial PATCHes raced with
      // re-renders between saves and could drop freshly-picked values.
      const full = {
        primaryModel: patch.primaryModel ?? project.primaryModel,
        subagentModel: patch.subagentModel ?? project.subagentModel,
      };
      const updated = await updateProjectApi(project.id, full);
      updateProject(updated);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };


  if (!editing) {
    return (
      <button
        className="flex items-center gap-2 text-left text-[11px] text-muted-foreground/80 hover:text-muted-foreground max-w-full overflow-hidden"
        onClick={() => setEditing(true)}
        title="Configure models"
      >
        <span className="truncate">
          {project.primaryModel
            ? modelDisplayName(project.primaryModel)
            : "Best available"}{" "}
          · Dynamic swarm
        </span>
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-0.5">
      <ModelPicker
        label="Primary"
        value={project.primaryModel}
        onChange={(value) => save({ primaryModel: value })}
        settings={settings}
      />
      <ModelPicker
        label="Subagents"
        value={project.subagentModel}
        placeholder="Same as primary"
        onChange={(value) => save({ subagentModel: value })}
        settings={settings}
      />
      <button
        className="text-[11px] text-muted-foreground hover:text-foreground"
        onClick={() => setEditing(false)}
      >
        Done
      </button>
    </div>
  );
}

function RunHandoff() {
  const { lastOutcome, iterations, previewNonce } = useStudioStore();
  if (!lastOutcome) return null;

  if (lastOutcome.status === "completed") {
    const iteration =
      iterations.find((it) => it.id === lastOutcome.iterationId) ?? null;
    return (
      <div className="rounded-md bg-emerald-500/[0.07] px-3 py-2.5 text-xs space-y-1.5">
        <div className="font-medium text-foreground">
          ✓ {iteration?.label ?? "Completed"}
          {iteration ? (
            <span className="ml-2 font-normal text-muted-foreground">
              saved as {iteration.id}
            </span>
          ) : null}
        </div>
        {lastOutcome.filesChanged.length > 0 && (
          <div className="text-muted-foreground">
            Changed{" "}
            {lastOutcome.filesChanged
              .slice(0, 4)
              .map((f) => f.split("/").pop())
              .join(", ")}
            {lastOutcome.filesChanged.length > 4
              ? ` +${lastOutcome.filesChanged.length - 4} more`
              : ""}
          </div>
        )}
        <div className="text-muted-foreground/80">
          Continue below — describe a change, give feedback, or inspect the
          preview.
          {previewNonce < 0 ? "" : ""}
        </div>
      </div>
    );
  }

  if (lastOutcome.status === "cancelled" || lastOutcome.status === "stuck") {
    return (
      <div className="rounded-md bg-secondary px-3 py-2.5 text-xs text-muted-foreground">
        {lastOutcome.status === "cancelled"
          ? "Stopped. The work written so far is kept — continue whenever you're ready."
          : "The agent repeated itself without progress and was stopped. Try rephrasing the request."}
      </div>
    );
  }

  return (
    <div className="rounded-md bg-destructive/[0.07] px-3 py-2.5 text-xs">
      <span className="font-medium text-destructive">Failed.</span>{" "}
      <span className="text-muted-foreground">
        See the error above for details about what failed.
      </span>
    </div>
  );
}

function QuestionCard({ send }: { send: (payload: Record<string, unknown>) => void }) {
  const { activeQuestion, handleEvent, setError } = useStudioStore();
  const [answer, setAnswer] = useState("");
  if (!activeQuestion) return null;

  const submit = (value: string) => {
    if (!value.trim()) return;
    try {
      send({
        type: "answer",
        answer: value,
        questionId: activeQuestion.questionId,
      });
      handleEvent({ type: "run_status", status: "running" });
      setAnswer("");
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/[0.06] p-3 space-y-2.5">
      <div className="text-sm font-medium">{activeQuestion.question}</div>
      <p className="text-xs text-muted-foreground">Choose one of the four suggestions, or write your own answer.</p>
      {activeQuestion.options && activeQuestion.options.length > 0 && (
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {activeQuestion.options.map((option) => (
            <Button
              key={option}
              size="sm"
              variant="outline"
              className="h-auto min-h-9 justify-start whitespace-normal text-left text-xs"
              onClick={() => submit(option)}
            >
              {option}
            </Button>
          ))}
        </div>
      )}
      <div className="flex gap-1.5">
        <Input
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit(answer);
          }}
          placeholder="Other answer (optional)"
          className="h-8 text-sm"
        />
        <Button size="sm" className="h-8" onClick={() => submit(answer)}>
          Reply
        </Button>
      </div>
    </div>
  );
}

function ConversationColumn({
  projectId,
  settings,
}: {
  projectId: string;
  settings: Settings;
}) {
  const {
    transcript,
    activity,
    runStatus,
    handleEvent,
    bumpPreview,
    setError,
  } = useStudioStore();
  const { send, connected } = useProjectSocket(projectId, handleEvent);
  const [draft, setDraft] = useState(() => sessionStorage.getItem(`conversation-draft:${projectId}`) ?? "");
  useEffect(() => { sessionStorage.setItem(`conversation-draft:${projectId}`, draft); }, [projectId, draft]);
  useEffect(() => {
    const target = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId: string; selector: string; text: string }>).detail;
      if (detail.projectId !== projectId) return;
      setDraft((current) => `${current}${current ? "\n\n" : ""}Update element ${detail.selector} (${detail.text}): `);
    };
    window.addEventListener("studio:target", target);
    return () => window.removeEventListener("studio:target", target);
  }, [projectId]);
  const [images, setImages] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const submitInFlight = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const project = useStudioStore(
    (state) => state.projects.find((p) => p.id === projectId),
  );

  const runSettings = useMemo(
    () => ({
      generatedCodeConfig: settings.generatedCodeConfig,
      primaryModel: project?.primaryModel ?? "",
      subagentModel: project?.subagentModel ?? "",
      executionMode: project?.executionMode ?? "auto",
      // Provider credentials and feature flags travel with the run; the
      // backend snapshots what it needs at execution start.
      customProviders: settings.customProviders,
      activeCustomProviderId: settings.activeCustomProviderId,
      openAiApiKey: settings.openAiApiKey,
      anthropicApiKey: settings.anthropicApiKey,
      geminiApiKey: settings.geminiApiKey,
      replicateApiKey: settings.replicateApiKey,
      isImageGenerationEnabled: settings.isImageGenerationEnabled,
    }),
    [
      settings.generatedCodeConfig,
      settings.customProviders,
      settings.activeCustomProviderId,
      settings.openAiApiKey,
      settings.anthropicApiKey,
      settings.geminiApiKey,
      settings.replicateApiKey,
      settings.isImageGenerationEnabled,
      project?.primaryModel,
      project?.subagentModel,
      project?.executionMode,
    ],
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [transcript.length, activity.length, runStatus]);

  const submit = async () => {
    const text = draft.trim();
    if ((!text && images.length === 0) || working || submitInFlight.current) return;
    submitInFlight.current = true;
    setSubmitting(true);
    try {
      const runId = await startRun(projectId, text, runSettings, images);
      if (useStudioStore.getState().activeProjectId !== projectId) return;
      handleEvent({ type: "user_message", projectId, runId, text, images });
      setDraft("");
      setImages([]);
    } catch (error) {
      if (useStudioStore.getState().activeProjectId === projectId) {
        setError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      submitInFlight.current = false;
      setSubmitting(false);
    }
  };

  const attachFiles = (files: FileList | File[] | null) => {
    if (!files) return;
    Array.from(files)
      .filter((file) => file.type.startsWith("image/"))
      .slice(0, 5)
      .forEach((file) => {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = String(reader.result);
          setImages((prev) =>
            prev.includes(dataUrl) ? prev : [...prev, dataUrl].slice(0, 5),
          );
        };
        reader.readAsDataURL(file);
      });
  };

  const working = runStatus === "running" || runStatus === "waiting_for_user";
  const phase = working ? phaseFromActivity(activity) : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 pt-2.5 pb-1">
        {project ? (
          <ConfigBar project={project} />
        ) : (
          <span className="text-[11px] text-muted-foreground">…</span>
        )}
        <div className="flex items-center gap-1 shrink-0">
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            title="Reload preview"
            onClick={() => bumpPreview()}
          >
            <IoRefreshOutline className="h-3.5 w-3.5" />
          </Button>
          {working && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              title="Stop the current run"
              onClick={() => cancelRun(projectId).catch((error: unknown) =>
                setError(error instanceof Error ? error.message : String(error)),
              )}
            >
              <IoStop className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>
      <div className="px-4 pb-1.5 text-[11px] text-muted-foreground/70">
        {connected ? "" : "connecting…"}
        {working ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-600" />
            {runStatus === "waiting_for_user"
              ? RUN_STATUS_LABEL.waiting_for_user
              : phase ?? RUN_STATUS_LABEL.running}
          </span>
        ) : (
          runStatus ? RUN_STATUS_LABEL[runStatus] ?? "" : ""
        )}
      </div>

      <ScrollArea className="flex-1 px-4">
        <div className="space-y-4 pb-4" ref={scrollRef}>
          {transcript.length === 0 && activity.length === 0 && (
            <div className="pt-8 text-sm text-muted-foreground/80 leading-relaxed">
              Describe what you want to build or attach a reference image. The
              agent will inspect the project and ask only material questions.
            </div>
          )}
          {transcript.map((message, index) => (
            <div key={index}>
              {message.role === "user" ? (
                <div className="flex flex-col items-end gap-1">
                  {message.images.length > 0 && (
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {message.images.map((image, imageIndex) => (
                        <img
                          key={imageIndex}
                          src={image}
                          alt="reference"
                          className="h-12 w-12 rounded object-cover border"
                        />
                      ))}
                    </div>
                  )}
                  <div className="rounded-lg bg-secondary px-3 py-2 text-sm max-w-[92%]">
                    {message.text}
                  </div>
                </div>
              ) : (
                <div
                  className={`text-sm whitespace-pre-wrap leading-relaxed ${
                    message.text.startsWith("Run failed")
                      ? "text-destructive"
                      : ""
                  }`}
                >
                  {message.text}
                </div>
              )}
            </div>
          ))}
          <div className="space-y-2">
            {images.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {images.map((image, imageIndex) => (
                  <span key={imageIndex} className="relative">
                    <img
                      src={image}
                      alt="attachment"
                      className="h-12 w-12 rounded object-cover border"
                    />
                    <button
                      aria-label={`Remove reference ${imageIndex + 1}`}
                      className="absolute -right-1.5 -top-1.5 text-muted-foreground hover:text-destructive"
                      onClick={() =>
                        setImages((prev) => prev.filter((_, i) => i !== imageIndex))
                      }
                    >
                      <IoCloseCircle className="h-4 w-4" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {activity.map((item) => (
              <ActivityItem key={item.id} item={item} />
            ))}
          </div>
          <RunHandoff />
          <QuestionCard send={send} />
        </div>
      </ScrollArea>

      <Separator />
      <div className="p-3">
        <div className="relative">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (files.length > 0) {
                event.preventDefault();
                attachFiles(files);
              }
            }}
            placeholder={
              transcript.length
                ? "Describe a change…"
                : "What do you want to create?"
            }
            className="min-h-[72px] resize-none pl-9 pr-10 text-sm"
            disabled={working || submitting}
          />
          <button
            className="absolute bottom-2.5 left-2.5 text-muted-foreground hover:text-foreground disabled:opacity-40"
            title="Attach reference images"
            onClick={() => fileInputRef.current?.click()}
            disabled={working || submitting}
          >
            <IoImageOutline className="h-4 w-4" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(event) => {
              if (event.target.files) attachFiles(Array.from(event.target.files));
              event.target.value = "";
            }}
          />
          <Button
            size="icon"
            className="absolute bottom-2 right-2 h-7 w-7"
            onClick={submit}
            disabled={working || submitting || (!draft.trim() && images.length === 0)}
            title="Send"
          >
            <IoArrowUp className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

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
