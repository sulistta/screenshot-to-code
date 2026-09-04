import { useEffect, useMemo, useRef, useState } from "react";
import { useStudioStore } from "@/store/studio-store";
import { useProjectSocket } from "@/hooks/useProjectSocket";
import {
  cancelRun,
  createProject,
  deleteProject,
  getAvailableModels,
  getTranscript,
  iterationUrl,
  listIterations,
  listProjects,
  startRun,
  updateProject as updateProjectApi,
  workspaceUrl,
} from "@/lib/studioApi";
import type { StudioActivityItem } from "@/store/studio-store";
import type { ExecutionMode, StudioProject } from "@/types/studio";
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
  IoTrashOutline,
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

const MODE_LABEL: Record<ExecutionMode, string> = {
  auto: "Auto",
  single: "Single",
  swarm: "Swarm",
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

function shortModelName(value: string): string {
  if (!value) return "Best available";
  // Drop the effort suffix for compact display.
  return value.replace(/\s*\((no|low|medium|high|xhigh|max).*\)$/, "");
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
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span
          className={`inline-block h-1 w-1 rounded-full ${
            item.ok === false ? "bg-destructive" : "bg-emerald-600"
          }`}
        />
        <span className="font-mono">{item.toolName}</span>
      </div>
    );
  }
  return <div className="text-xs text-muted-foreground/70">{item.text}</div>;
}

function ConfigBar({ project }: { project: StudioProject }) {
  const updateProject = useStudioStore((state) => state.updateProject);
  const setError = useStudioStore((state) => state.setError);
  const [models, setModels] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    getAvailableModels().then(setModels).catch(() => undefined);
  }, []);

  const save = async (patch: Partial<StudioProject>) => {
    try {
      const updated = await updateProjectApi(project.id, patch);
      updateProject(updated);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const selectClass =
    "h-7 rounded-md border border-transparent hover:border-input bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring cursor-pointer";

  if (!editing) {
    return (
      <button
        className="group flex items-center gap-1.5 text-left text-[11px] text-muted-foreground/80 hover:text-muted-foreground"
        onClick={() => setEditing(true)}
        title="Configure models and execution mode"
      >
        <span>
          {shortModelName(project.primaryModel)}
          {project.subagentModel
            ? ` · sub: ${shortModelName(project.subagentModel)}`
            : ""}
          {" · "}
          {MODE_LABEL[project.executionMode]}
        </span>
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-1">
      <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        Primary
        <select
          className={selectClass}
          value={project.primaryModel}
          onChange={(e) => {
            save({ primaryModel: e.target.value });
            if (!e.target.value) setEditing(false);
          }}
        >
          <option value="">Best available</option>
          {models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        Subagents
        <select
          className={selectClass}
          value={project.subagentModel}
          onChange={(e) => {
            save({ subagentModel: e.target.value });
          }}
        >
          <option value="">Same as primary</option>
          {models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        Mode
        <select
          className={selectClass}
          value={project.executionMode}
          onChange={(e) => {
            save({ executionMode: e.target.value as ExecutionMode });
            setEditing(false);
          }}
        >
          <option value="auto">Auto</option>
          <option value="single">Single</option>
          <option value="swarm">Swarm</option>
        </select>
      </label>
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
        See the message above; configuration or provider issues are fixed in
        Settings.
      </span>
    </div>
  );
}

function QuestionCard({ send }: { send: (payload: Record<string, unknown>) => void }) {
  const { activeQuestion, handleEvent } = useStudioStore();
  const [answer, setAnswer] = useState("");
  if (!activeQuestion) return null;

  const submit = (value: string) => {
    if (!value.trim()) return;
    send({
      type: "answer",
      answer: value,
      questionId: activeQuestion.questionId,
    });
    handleEvent({ type: "run_status", status: "running" });
    setAnswer("");
  };

  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/[0.06] p-3 space-y-2.5">
      <div className="text-sm font-medium">{activeQuestion.question}</div>
      {activeQuestion.options && activeQuestion.options.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {activeQuestion.options.map((option) => (
            <Button
              key={option}
              size="sm"
              variant="outline"
              className="h-7 text-xs"
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
          placeholder="Type your answer…"
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
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<string[]>([]);
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
    if (!text || working) return;
    try {
      await startRun(projectId, text, runSettings, images);
      handleEvent({ type: "run_status", runId: "pending", status: "running" });
      setDraft("");
      setImages([]);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
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
              onClick={() => cancelRun(projectId).catch(() => undefined)}
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
              Describe what you want to build. You can attach reference images
              with the paperclip — the agent treats them as direction, not
              pixels to copy.
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
              if (event.key === "Enter" && !event.shiftKey) {
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
            disabled={working}
          />
          <button
            className="absolute bottom-2.5 left-2.5 text-muted-foreground hover:text-foreground disabled:opacity-40"
            title="Attach reference images"
            onClick={() => fileInputRef.current?.click()}
            disabled={working}
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
            disabled={working || !draft.trim()}
            title="Send"
          >
            <IoArrowUp className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function IterationBar({
  projectId,
  refreshKey,
}: {
  projectId: string;
  refreshKey: unknown;
}) {
  const iterations = useStudioStore((state) => state.iterations);
  const setIterations = useStudioStore((state) => state.setIterations);

  useEffect(() => {
    let cancelled = false;
    listIterations(projectId)
      .then((list) => {
        if (!cancelled) setIterations(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshKey, setIterations]);

  if (iterations.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      <span className="text-muted-foreground">History</span>
      {iterations.map((iteration) => (
        <a
          key={iteration.id}
          href={`${iterationUrl(projectId, iteration.id)}?t=${iteration.created_at}`}
          target="_blank"
          rel="noreferrer"
          title={iteration.summary.slice(0, 160)}
          className="rounded px-1.5 py-0.5 font-mono text-muted-foreground hover:text-foreground hover:bg-secondary"
        >
          {iteration.id}
        </a>
      ))}
      <span className="text-muted-foreground/60">
        {iterations[iterations.length - 1]?.label}
      </span>
    </div>
  );
}

export default function StudioPage() {
  const {
    projects,
    activeProjectId,
    setProjects,
    setActiveProject,
    setTranscript,
    error,
    setError,
    previewNonce,
    runStatus,
  } = useStudioStore();
  const [newProjectName, setNewProjectName] = useState("");
  const [creating, setCreating] = useState(false);
  const [workspaceState, setWorkspaceState] = useState<
    "empty" | "ready" | "error"
  >("empty");
  const [settings, setSettings] = usePersistedState<Settings>(
    DEFAULT_SETTINGS,
    "setting"
  );
  const [appTheme, setAppTheme] = usePersistedState<AppTheme>(
    AppTheme.SYSTEM,
    "app-theme"
  );
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const activeProject = projects.find((p) => p.id === activeProjectId);

  useEffect(() => {
    listProjects()
      .then(setProjects)
      .catch(() => setError("Could not load projects"));
  }, [setProjects, setError]);

  useEffect(() => {
    if (!activeProjectId) return;
    getTranscript(activeProjectId)
      .then(setTranscript)
      .catch(() => undefined);
  }, [activeProjectId, setTranscript]);

  useEffect(() => {
    if (!activeProjectId) return;
    let cancelled = false;
    // Re-probe when a run finishes: the workspace appears/updates then.
    probeWorkspace(activeProjectId).then((state) => {
      if (!cancelled) setWorkspaceState(state);
    });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, previewNonce]);

  const onCreate = async () => {
    setCreating(true);
    try {
      const project = await createProject(
        newProjectName || "Untitled project",
        newProjectName,
      );
      setProjects([project, ...projects]);
      setActiveProject(project.id);
      setNewProjectName("");
    } catch {
      setError("Could not create project");
    } finally {
      setCreating(false);
    }
  };

  const onDelete = async (projectId: string) => {
    try {
      await deleteProject(projectId);
      setProjects(projects.filter((p) => p.id !== projectId));
      if (activeProjectId === projectId) setActiveProject(null);
    } catch {
      setError("Could not delete project");
    }
  };

  const previewRebuilding = runStatus === "running";

  return (
    <div className="flex h-screen w-screen bg-background text-foreground">
      <aside className="flex w-56 flex-col border-r">
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
        <ScrollArea className="flex-1 px-2">
          <div className="space-y-0.5 pb-4">
            {projects.map((project) => (
              <div
                key={project.id}
                className={`group flex items-center justify-between rounded-md px-2 py-1.5 text-sm cursor-pointer hover:bg-secondary ${
                  project.id === activeProjectId ? "bg-secondary" : ""
                }`}
                onClick={() => setActiveProject(project.id)}
              >
                <span className="truncate">{project.name}</span>
                <button
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                  title="Delete project"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete(project.id);
                  }}
                >
                  <IoTrashOutline className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            {projects.length === 0 && (
              <div className="px-2 py-6 text-xs leading-relaxed text-muted-foreground">
                Name a project above and press Enter. One project holds the
                whole conversation, its versions, and its preview.
              </div>
            )}
          </div>
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

      <section className="flex w-[400px] shrink-0 flex-col border-r">
        {activeProjectId ? (
          <ConversationColumn
            projectId={activeProjectId}
            settings={settings}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center px-8 text-center text-sm text-muted-foreground">
            Select or create a project to start.
          </div>
        )}
      </section>

      <main className="flex flex-1 flex-col">
        {activeProject ? (
          <>
            <div className="flex items-center justify-between px-4 py-2 border-b">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  {activeProject.name}
                </div>
                {activeProject.brief && (
                  <div className="truncate text-xs text-muted-foreground">
                    {activeProject.brief}
                  </div>
                )}
              </div>
              <a
                href={workspaceUrl(activeProject.id)}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-muted-foreground hover:text-foreground shrink-0"
              >
                Open in new tab ↗
              </a>
            </div>
            <div className="px-4 py-1.5 border-b">
              <IterationBar
                projectId={activeProject.id}
                refreshKey={previewNonce}
              />
            </div>
            <div className="relative flex-1 bg-secondary/40">
              {workspaceState === "ready" ? (
                <>
                  <iframe
                    id="studio-preview"
                    title="Project preview"
                    className="h-full w-full bg-white"
                    src={`${workspaceUrl(activeProject.id)}?t=${previewNonce}`}
                  />
                  {previewRebuilding && (
                    <div className="absolute right-3 top-3 rounded-full bg-background/90 px-2.5 py-1 text-[11px] text-muted-foreground shadow-sm border">
                      Rebuilding — showing the last saved version
                    </div>
                  )}
                </>
              ) : (
                <div className="flex h-full items-center justify-center px-8 text-center text-sm text-muted-foreground">
                  {previewRebuilding
                    ? "The first version appears here as soon as the agent saves one."
                    : workspaceState === "empty"
                      ? "Nothing built yet. Describe what you want and the agent starts here."
                      : "The workspace could not be loaded. It appears after the first successful build."}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            The live preview appears here once you pick a project.
          </div>
        )}
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
          className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-md bg-destructive px-4 py-2 text-sm text-destructive-foreground cursor-pointer"
          onClick={() => setError(null)}
        >
          {error}
        </div>
      )}
    </div>
  );
}

async function probeWorkspace(
  projectId: string,
): Promise<"empty" | "ready" | "error"> {
  try {
    const response = await fetch(`${workspaceUrl(projectId)}`, {
      method: "HEAD",
    });
    if (response.ok) return "ready";
    if (response.status === 404) return "empty";
    return "error";
  } catch {
    return "error";
  }
}
