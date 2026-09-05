import { useEffect, useMemo, useRef, useState } from "react";
import { useStudioStore } from "@/store/studio-store";
import type { StudioActivityItem } from "@/store/studio-store";
import { useProjectEvents } from "@/hooks/useProjectEvents";
import { cancelRun, startRun } from "@/lib/studioApi";
import type { Settings } from "@/types";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  IoArrowUp,
  IoStop,
  IoRefreshOutline,
  IoImageOutline,
  IoCloseCircle,
} from "react-icons/io5";
import ConfigBar from "./ConfigBar";
import ActivityItem from "./ActivityItem";
import RunHandoff from "./RunHandoff";
import TeamPanel from "./TeamPanel";
import QuestionCard from "./QuestionCard";

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

const RUN_STATUS_LABEL: Record<string, string> = {
  running: "Working",
  waiting_for_user: "Waiting for you",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
  stuck: "Stuck",
};

export function ConversationColumn({
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
  const { send, connected } = useProjectEvents(projectId, handleEvent);
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
          <RunHandoff projectId={projectId} />
          <TeamPanel working={working} />
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

export default ConversationColumn;
