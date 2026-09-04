import { create } from "zustand";
import type { Settings } from "@/types";
import type {
  StudioIteration,
  StudioProject,
  StudioQuestion,
  StudioRunEvent,
  StudioRunStatus,
  StudioTranscriptMessage,
} from "@/types/studio";

export interface RunOutcome {
  status: StudioRunStatus;
  iterationId: string | null;
  filesChanged: string[];
  config: {
    primary_model: string;
    subagent_model: string;
    execution_mode: string;
  } | null;
}

export interface StudioActivityItem {
  id: string;
  kind: "thinking" | "assistant" | "tool" | "status";
  text: string;
  toolName?: string;
  toolDetail?: string;
  ok?: boolean;
}

interface StudioState {
  projects: StudioProject[];
  activeProjectId: string | null;
  transcript: StudioTranscriptMessage[];
  /** Live activity for the current run (not yet in the transcript). */
  activity: StudioActivityItem[];
  previewContent: string | null;
  /** Bumped when the live workspace changed; the preview iframe reloads. */
  previewNonce: number;
  runStatus: StudioRunStatus | null;
  activeQuestion: StudioQuestion | null;
  error: string | null;
  iterations: StudioIteration[];
  lastOutcome: RunOutcome | null;
  currentRunConfig: RunOutcome["config"];
  settings: Settings | null;

  setProjects: (projects: StudioProject[]) => void;
  setSettings: (settings: Settings) => void;
  updateProject: (project: StudioProject) => void;
  setIterations: (iterations: StudioIteration[]) => void;
  setActiveProject: (projectId: string | null) => void;
  setTranscript: (messages: StudioTranscriptMessage[]) => void;
  setPreviewContent: (content: string | null) => void;
  bumpPreview: () => void;
  setError: (message: string | null) => void;
  clearActivity: () => void;
  handleEvent: (event: StudioRunEvent) => void;
}

let activityCounter = 0;
const nextActivityId = () => `evt-${activityCounter++}`;

export const useStudioStore = create<StudioState>((set) => ({
  projects: [],
  activeProjectId: null,
  transcript: [],
  activity: [],
  previewContent: null,
  previewNonce: 0,
  runStatus: null,
  activeQuestion: null,
  error: null,
  iterations: [],
  lastOutcome: null,
  currentRunConfig: null,
  settings: null,

  setProjects: (projects) => set({ projects }),
  setSettings: (settings) => set({ settings }),
  updateProject: (project) =>
    set((state) => ({
      projects: state.projects.map((p) => (p.id === project.id ? project : p)),
    })),
  setIterations: (iterations) => set({ iterations }),
  bumpPreview: () => set((state) => ({ previewNonce: state.previewNonce + 1 })),
  setActiveProject: (projectId) =>
    set({
      activeProjectId: projectId,
      transcript: [],
      activity: [],
      previewContent: null,
      runStatus: null,
      activeQuestion: null,
      error: null,
      iterations: [],
      lastOutcome: null,
      currentRunConfig: null,
    }),
  setTranscript: (transcript) => set({ transcript }),
  setPreviewContent: (content) => set({ previewContent: content }),
  setError: (error) => set({ error }),
  clearActivity: () => set({ activity: [] }),

  handleEvent: (event) => {
    if (event.type === "run_status") {
      const status = event.status as StudioRunStatus | undefined;
      if (status === "running") {
        set({
          currentRunConfig: event.config ?? null,
          lastOutcome: null,
        });
      }
      set((state) => {
        if (status && status !== "running") {
          // Move the live activity into the transcript as the run's reply.
          const replyText = state.activity
            .filter((item) => item.kind === "assistant")
            .map((item) => item.text)
            .join("")
            .trim();
          // Event replays (socket reconnect) re-deliver the terminal status;
          // only append the reply when it is not already the last message.
          const last = state.transcript[state.transcript.length - 1];
          const alreadyAppended =
            !!last &&
            last.role === "assistant" &&
            last.text === replyText &&
            last.runId === (event.runId ?? null);
          return {
            runStatus: status,
            activeQuestion: null,
            lastOutcome: {
              status,
              iterationId: event.iterationId ?? null,
              filesChanged: event.filesChanged ?? [],
              config: state.currentRunConfig,
            },
            transcript:
              replyText && state.activeProjectId && !alreadyAppended
                ? [
                    ...state.transcript,
                    {
                      role: "assistant" as const,
                      text: replyText,
                      createdAt: new Date().toISOString(),
                      runId: event.runId ?? null,
                      images: [],
                    },
                  ]
                : state.transcript,
            activity: [],
            previewNonce: state.previewNonce + 1,
          };
        }
        return { runStatus: status ?? "running", activeQuestion: null };
      });
      return;
    }

    if (event.type === "question") {
      set({
        activeQuestion: {
          questionId: event.questionId ?? "",
          question: event.question ?? "",
          options: event.options ?? null,
        },
        runStatus: "waiting_for_user",
      });
      return;
    }

    if (event.type === "set_code") {
      if (event.content) {
        set({ previewContent: event.content });
      }
      return;
    }

    set((state) => {
      const activity = [...state.activity];
      const last = activity[activity.length - 1];

      if (event.type === "thinking_delta" || event.type === "assistant_delta") {
        const kind = event.type === "thinking_delta" ? "thinking" : "assistant";
        if (last && last.kind === kind && last.id === activity[activity.length - 1].id) {
          // Streaming deltas accumulate on the last item of the same kind,
          // unless a tool item came between (then a new one starts).
          const updated = { ...last, text: last.text + (event.text ?? "") };
          activity[activity.length - 1] = updated;
        } else {
          activity.push({
            id: nextActivityId(),
            kind,
            text: event.text ?? "",
          });
        }
        return { activity };
      }

      if (event.type === "tool_start") {
        activity.push({
          id: nextActivityId(),
          kind: "tool",
          text: "",
          toolName: event.name ?? "tool",
          toolDetail: summarizeToolInput(event.name, event.input),
        });
        return { activity };
      }

      if (event.type === "tool_result") {
        // Attach the result to the last tool item with no outcome yet.
        for (let i = activity.length - 1; i >= 0; i -= 1) {
          const item = activity[i];
          if (item.kind === "tool" && item.ok === undefined) {
            activity[i] = {
              ...item,
              ok: event.ok ?? true,
              text:
                typeof event.output === "object" && event.output !== null
                  ? JSON.stringify(event.output).slice(0, 200)
                  : "",
            };
            break;
          }
        }
        return { activity };
      }

      if (event.type === "status") {
        activity.push({
          id: nextActivityId(),
          kind: "status",
          text: event.message ?? "",
        });
        return { activity };
      }

      return {};
    });
  },
}));


/** Human summary of a tool invocation for the activity list. */
function summarizeToolInput(
  name: string | undefined,
  input: Record<string, unknown> | undefined,
): string {
  if (!input) return "";
  const path = typeof input.path === "string" ? input.path : null;
  switch (name) {
    case "create_file":
      return path ? `Created ${path}` : "Created a file";
    case "edit_file":
      return path ? `Edited ${path}` : "Edited the file";
    case "read_file":
      return path ? `Read ${path}` : "Read a file";
    case "list_files":
      return "Listed project files";
    case "screenshot_preview":
      return "Reviewed the result visually";
    case "spawn_agent": {
      const role = typeof input.role === "string" ? input.role : "specialist";
      return `Delegated to ${role}`;
    }
    case "ask_user":
      return typeof input.question === "string" ? input.question : "Asked a question";
    case "research":
      return typeof input.url === "string" ? `Checked ${input.url}` : "Checked a reference";
    case "generate_images":
      return "Generated visual assets";
    case "edit_images":
      return "Edited images";
    case "remove_backgrounds":
      return "Removed image backgrounds";
    case "extract_assets":
      return "Extracted assets from references";
    case "save_assets":
      return "Saved uploaded assets";
    case "retrieve_option":
      return "Retrieved a previous option";
    default:
      return "";
  }
}
