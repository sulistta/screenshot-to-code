import { useEffect, useMemo, useRef, useState } from "react";
import { useStudioStore } from "@/store/studio-store";
import type { StudioActivityItem } from "@/store/studio-store";
import { useProjectEvents } from "@/hooks/useProjectEvents";
import { cancelRun, startRun } from "@/lib/studioApi";
import type { Settings } from "@/types";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
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
import { modelDisplayName } from "@/components/studio/modelOptions";

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
  const primaryLabel = project?.primaryModel ? modelDisplayName(project.primaryModel) : "Best available";

  return (
    <div className="flex h-full flex-col min-h-0">
      <div className="flex items-center justify-between gap-2 pb-2">
        {project ? (
          <ConfigBar project={project} compact />
        ) : (
          <span className="text-[11px] text-stone-400">…</span>
        )}
        <div className="flex items-center gap-1 shrink-0">
          <span className="text-[11px] text-stone-400 mr-1">
            {connected ? "" : "connecting…"}
            {working ? (
              <span className="inline-flex items-center gap-1.5 text-stone-500">
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-600" />
                {runStatus === "waiting_for_user"
                  ? RUN_STATUS_LABEL.waiting_for_user
                  : phase ?? RUN_STATUS_LABEL.running}
              </span>
            ) : runStatus ? RUN_STATUS_LABEL[runStatus] ?? "" : ""}
          </span>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 rounded-lg"
            title="Reload preview"
            onClick={() => bumpPreview()}
          >
            <IoRefreshOutline className="h-3.5 w-3.5" />
          </Button>
          {working && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 rounded-lg"
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

      <ScrollArea className="flex-1 min-h-0">
        <div className="space-y-3 pb-3 pr-1" ref={scrollRef}>
          {project?.brief && (
            <div className="rounded-xl bg-stone-100/80 dark:bg-zinc-800/50 px-3.5 py-3 text-[12.5px] leading-relaxed text-stone-600 dark:text-zinc-300">
              {project.brief}
            </div>
          )}
          {transcript.length === 0 && activity.length === 0 && (
            <div className="pt-4 text-[13px] text-stone-400 leading-relaxed">
              Describe what you want to build or attach a reference image. The
              agent will inspect the project and ask only material questions.
            </div>
          )}
          {transcript.map((message, index) => (
            <div key={index}>
              {message.role === "user" ? (
                <div className="flex flex-col items-end gap-1.5">
                  {message.images.length > 0 && (
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {message.images.map((image, imageIndex) => (
                        <img
                          key={imageIndex}
                          src={image}
                          alt="reference"
                          className="h-12 w-12 rounded-lg object-cover border border-stone-200 dark:border-zinc-700"
                        />
                      ))}
                    </div>
                  )}
                  <div className="rounded-xl bg-stone-100 dark:bg-zinc-800 px-3 py-2 text-[13px] max-w-[92%] text-stone-800 dark:text-zinc-100">
                    {message.text}
                  </div>
                </div>
              ) : (
                <div
                  className={`text-[13px] whitespace-pre-wrap leading-relaxed text-stone-700 dark:text-zinc-200 ${
                    message.text.startsWith("Run failed")
                      ? "text-red-600"
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
                      className="h-12 w-12 rounded-lg object-cover border border-stone-200 dark:border-zinc-700"
                    />
                    <button
                      aria-label={`Remove reference ${imageIndex + 1}`}
                      className="absolute -right-1.5 -top-1.5 text-stone-400 hover:text-red-600"
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

      <div className="pt-2.5">
        <div className="forge-prompt">
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
                ? "Add a follow-up, clarify something, or make a change…"
                : "What do you want to create?"
            }
            className="min-h-[52px] resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 px-3.5 pt-3 pb-1 text-[13px]"
            disabled={working || submitting}
          />
          <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
            <div className="flex items-center gap-1">
              <button
                className="w-7 h-7 grid place-items-center rounded-lg bg-stone-100 dark:bg-zinc-800 text-stone-600 dark:text-zinc-300 text-[15px]"
                title="Attach reference images"
                onClick={() => fileInputRef.current?.click()}
                disabled={working || submitting}
              >
                +
              </button>
              <button
                className="forge-tool"
                title="Attach reference images"
                onClick={() => fileInputRef.current?.click()}
                disabled={working || submitting}
              >
                <IoImageOutline className="h-3.5 w-3.5" /> Attach
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
            </div>
            <div className="flex items-center gap-1.5">
              <span className="hidden sm:inline-flex forge-select !py-[7px] max-w-[160px] truncate" title={primaryLabel}>
                <span className="truncate text-[12px]">{primaryLabel}</span>
              </span>
              <Button
                size="icon"
                className="h-8 w-8 rounded-[9px] bg-stone-200 hover:bg-stone-900 hover:text-white dark:bg-zinc-700 text-stone-600 dark:text-zinc-200"
                onClick={submit}
                disabled={working || submitting || (!draft.trim() && images.length === 0)}
                title="Send"
              >
                <IoArrowUp className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ConversationColumn;
