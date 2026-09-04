import { useEffect, useMemo, useRef, useState } from "react";
import { useStudioStore } from "@/store/studio-store";
import { useProjectSocket } from "@/hooks/useProjectSocket";
import {
  cancelRun,
  createProject,
  deleteProject,
  getTranscript,
  listProjects,
  startRun,
  workspaceUrl,
} from "@/lib/studioApi";
import type { StudioActivityItem } from "@/store/studio-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { IoArrowUp, IoAdd, IoStop, IoTrashOutline, IoRefreshOutline } from "react-icons/io5";

const RUN_STATUS_LABEL: Record<string, string> = {
  running: "Working…",
  waiting_for_user: "Waiting for your answer",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  stuck: "Stuck",
};

function ActivityItem({ item }: { item: StudioActivityItem }) {
  if (item.kind === "thinking") {
    return (
      <div className="text-xs italic text-muted-foreground whitespace-pre-wrap">
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
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            item.ok === false ? "bg-destructive" : "bg-emerald-500"
          }`}
        />
        <span className="font-mono">{item.toolName}</span>
      </div>
    );
  }
  return (
    <div className="text-xs text-muted-foreground/70">{item.text}</div>
  );
}

function QuestionCard({ send }: { send: (payload: Record<string, unknown>) => void }) {
  const { activeQuestion, handleEvent } = useStudioStore();
  const [answer, setAnswer] = useState("");
  if (!activeQuestion) return null;

  const submit = (value: string) => {
    if (!value.trim()) return;
    // Answer through the socket; the manager resolves the parked run.
    send({
      type: "answer",
      answer: value,
      questionId: activeQuestion.questionId,
    });
    handleEvent({
      type: "run_status",
      status: "running",
    });
    setAnswer("");
  };

  return (
    <div className="rounded-lg border border-highlight/60 bg-highlight/10 p-3 space-y-2">
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

function ConversationColumn({ projectId }: { projectId: string }) {
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const settings = useMemo(
    () => ({
      generatedCodeConfig: "html_tailwind",
    }),
    [],
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [transcript.length, activity.length, runStatus]);

  const submit = async () => {
    const text = draft.trim();
    if (!text) return;
    try {
      await startRun(projectId, text, settings);
      handleEvent({
        type: "run_status",
        runId: "pending",
        status: "running",
      });
      setDraft("");
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const working = runStatus === "running" || runStatus === "waiting_for_user";

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <div className="text-xs text-muted-foreground">
          {connected ? "connected" : "connecting…"}
          {runStatus ? ` · ${RUN_STATUS_LABEL[runStatus] ?? runStatus}` : ""}
        </div>
        <div className="flex items-center gap-1">
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
              title="Cancel run"
              onClick={() => cancelRun(projectId).catch(() => undefined)}
            >
              <IoStop className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>

      <ScrollArea className="flex-1 px-4">
        <div className="space-y-4 pb-4" ref={scrollRef}>
          {transcript.map((message, index) => (
            <div key={index}>
              {message.role === "user" ? (
                <div className="rounded-lg bg-secondary px-3 py-2 text-sm">
                  {message.text}
                </div>
              ) : (
                <div className="text-sm whitespace-pre-wrap leading-relaxed">
                  {message.text}
                </div>
              )}
            </div>
          ))}
          <div className="space-y-2">
            {activity.map((item) => (
              <ActivityItem key={item.id} item={item} />
            ))}
          </div>
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
            placeholder={
              transcript.length
                ? "Describe a change…"
                : "Describe what you want to build…"
            }
            className="min-h-[72px] resize-none pr-10 text-sm"
            disabled={working}
          />
          <Button
            size="icon"
            className="absolute bottom-2 right-2 h-7 w-7"
            onClick={submit}
            disabled={working || !draft.trim()}
          >
            {runStatus === "running" ? (
              <IoArrowUp className="h-3.5 w-3.5 animate-pulse" />
            ) : (
              <IoArrowUp className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>

      {/* Keep the preview dependency so the panel refreshes on set_code. */}
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
  } = useStudioStore();
  const [newProjectName, setNewProjectName] = useState("");
  const [creating, setCreating] = useState(false);
  const [workspaceState, setWorkspaceState] = useState<
    "empty" | "ready" | "error"
  >("empty");

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

  return (
    <div className="flex h-screen w-screen bg-background text-foreground">
      {/* Projects rail */}
      <aside className="flex w-60 flex-col border-r">
        <div className="flex items-center gap-2 px-4 pt-4 pb-2">
          <span className="text-sm font-semibold">Studio</span>
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
              <div className="px-2 py-6 text-xs text-muted-foreground">
                Create a project to start.
              </div>
            )}
          </div>
        </ScrollArea>
        <Separator />
        <div className="px-4 py-3">
          <a
            href="/"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            ← Variant flow
          </a>
        </div>
      </aside>

      {/* Conversation */}
      <section className="flex w-[420px] shrink-0 flex-col border-r">
        {activeProjectId ? (
          <ConversationColumn projectId={activeProjectId} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Select or create a project.
          </div>
        )}
      </section>

      {/* Preview */}
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
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Open in new tab ↗
              </a>
            </div>
            <div className="relative flex-1 bg-secondary/40">
              {workspaceState === "ready" ? (
                <iframe
                  id="studio-preview"
                  title="Project preview"
                  className="h-full w-full bg-white"
                  src={`${workspaceUrl(activeProject.id)}?t=${previewNonce}`}
                />
              ) : (
                <div className="flex h-full items-center justify-center px-8 text-center text-sm text-muted-foreground">
                  {workspaceState === "empty"
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
