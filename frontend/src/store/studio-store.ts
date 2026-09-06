import { create } from "zustand";
import type { Settings } from "@/types";
import type {
  StudioAgent,
  StudioAgentStatus,
  StudioIteration,
  StudioProject,
  StudioQuestion,
  StudioRunEvent,
  StudioRunStatus,
  StudioTranscriptMessage,
} from "@/types/studio";

export interface RunOutcome {
  runId: string | null;
  status: StudioRunStatus;
  iterationId: string | null;
  filesChanged: string[];
  /** A recoverable draft was saved for this run's partial work. */
  draftAvailable: boolean;
}

export interface StudioActivityItem {
  id: string;
  kind: "thinking" | "assistant" | "tool" | "status";
  text: string;
  toolName?: string;
  eventId?: string;
  toolDetail?: string;
  ok?: boolean;
  /** Set when the item belongs to a specialist, not the coordinator. */
  agentId?: string;
  agentName?: string;
}

export interface RunDetail {
  runId: string;
  status: StudioRunStatus;
  activity: StudioActivityItem[];
  team: Record<string, StudioAgent>;
  filesChanged: string[];
}

interface StudioState {
  completedRuns: RunDetail[];
  projects: StudioProject[];
  activeProjectId: string | null;
  transcript: StudioTranscriptMessage[];
  /** Live activity for the current run (not yet in the transcript). */
  activity: StudioActivityItem[];
  /** The run's team: coordinator + specialists, by agent id. */
  team: Record<string, StudioAgent>;
  previewContent: string | null;
  /** Bumped when the live workspace changed; the preview iframe reloads. */
  previewNonce: number;
  runStatus: StudioRunStatus | null;
  activeQuestion: StudioQuestion | null;
  error: string | null;
  iterations: StudioIteration[];
  lastOutcome: RunOutcome | null;
  settings: Settings | null;
  currentRunId: string | null;
  eventCursor: { streamId: string; sequence: number } | null;

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

function mergeMessages(
  existing: StudioTranscriptMessage[],
  incoming: StudioTranscriptMessage[],
): StudioTranscriptMessage[] {
  const result = [...existing];
  for (const message of incoming) {
    const index = result.findIndex((item) =>
      message.runId
        ? item.runId === message.runId && item.role === message.role
        : item.role === message.role && item.text === message.text &&
          item.createdAt === message.createdAt,
    );
    if (index < 0) result.push(message);
    else result[index] = message;
  }
  return result;
}

/** Lifecycle wire status -> agent state, tolerating unknown values. */
function asAgentStatus(value: unknown): StudioAgentStatus {
  const known: StudioAgentStatus[] = [
    "queued", "working", "verifying", "completed", "failed", "cancelled",
  ];
  return known.includes(value as StudioAgentStatus)
    ? (value as StudioAgentStatus)
    : "working";
}

export const useStudioStore = create<StudioState>((set, get) => ({
  completedRuns: [],
  projects: [],
  activeProjectId: null,
  transcript: [],
  activity: [],
  team: {},
  previewContent: null,
  previewNonce: 0,
  runStatus: null,
  activeQuestion: null,
  error: null,
  iterations: [],
  lastOutcome: null,
  settings: null,
  currentRunId: null,
  eventCursor: null,

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
      completedRuns: [],
      transcript: [],
      activity: [],
      team: {},
      previewContent: null,
      runStatus: null,
      activeQuestion: null,
      error: null,
      iterations: [],
      lastOutcome: null,
      currentRunId: null,
      eventCursor: null,
    }),
  setTranscript: (messages) => set((state) => ({
    // A fetch started before the run completed must not erase its live reply.
    transcript: mergeMessages(messages, state.transcript.filter((message) =>
      message.runId && !messages.some((item) =>
        item.runId === message.runId && item.role === message.role,
      ),
    )),
  })),
  setPreviewContent: (content) => set({ previewContent: content }),
  setError: (error) => set({ error }),
  clearActivity: () => set({ activity: [] }),

  handleEvent: (event) => {
    const state = get();
    if (event.projectId && event.projectId !== state.activeProjectId) return;
    if (event.streamId && typeof event.sequence === "number") {
      if (state.eventCursor?.streamId === event.streamId &&
          event.sequence <= state.eventCursor.sequence) return;
      set({ eventCursor: { streamId: event.streamId, sequence: event.sequence } });
    }
    if (event.type === "user_message") {
      set((current) => ({ transcript: mergeMessages(current.transcript, [{
        role: "user", text: event.text ?? "", images: event.images ?? [],
        runId: event.runId ?? null, createdAt: new Date().toISOString(),
      }]) }));
      return;
    }
    if (event.type === "agent_status") {
      // Team lifecycle: upsert the agent; a fresh coordinator marks a new run.
      const agentId = event.agentId ?? "";
      if (!agentId) return;
      set((current) => {
        const previous = current.team[agentId];
        const coordinatorNewRun =
          agentId === "coordinator" &&
          (!previous || previous.status === "completed" || previous.status === "failed" ||
           previous.status === "cancelled");
        const team = { ...current.team };
        team[agentId] = {
          agentId,
          name: event.name ?? previous?.name ?? "Agent",
          role: event.role ?? previous?.role ?? "specialist",
          parentAgentId: event.agentId === "coordinator"
            ? null
            : previous?.parentAgentId ?? null,
          status: asAgentStatus(event.status),
          objective: event.objective ?? previous?.objective ?? "",
          filePaths: event.filePaths ?? previous?.filePaths ?? [],
          files: previous?.files ?? [],
          currentAction:
            asAgentStatus(event.status) === "working"
              ? previous?.currentAction
              : undefined,
          summary: event.summary || previous?.summary || undefined,
          error: event.error ?? previous?.error ?? null,
        };
        return {
          team,
          // A brand-new coordinator resets per-run views.
          ...(coordinatorNewRun && event.status === "working"
            ? { activity: [], error: null }
            : {}),
        };
      });
      return;
    }
    if (event.type === "run_status") {
      const status = event.status as StudioRunStatus | undefined;
      if (status === "running") {
        const newRun = !!event.runId && event.runId !== state.currentRunId;
        set({
          currentRunId: event.runId ?? state.currentRunId,
          lastOutcome: null,
          ...(newRun ? { activity: [], team: {}, error: null } : {}),
        });
      }
      set((state) => {
        if (status && ["completed", "failed", "cancelled", "stuck"].includes(status)) {
          if (event.runId && state.lastOutcome?.runId === event.runId &&
              state.lastOutcome.status === status) return state;
          // Move the live activity into the transcript as the run's reply.
          const replyText = event.message ?? state.activity
            .filter((item) => item.kind === "assistant" && !item.agentId)
            .map((item) => item.text)
            .join("")
            .trim();
          // Event replays (channel resubscription) re-deliver the terminal status;
          // only append the reply when it is not already the last message.
          const alreadyAppended =
            state.transcript.some((message) =>
              message.role === "assistant" && message.text === replyText &&
              message.runId === (event.runId ?? null),
            );
          return {
            runStatus: status,
            completedRuns: event.runId ? [
              ...state.completedRuns.filter((run) => run.runId !== event.runId),
              { runId: event.runId, status, activity: state.activity, team: state.team, filesChanged: event.filesChanged ?? [] },
            ] : state.completedRuns,
            activeQuestion: null,
            lastOutcome: {
              runId: event.runId ?? null,
              status,
              iterationId: event.iterationId ?? null,
              filesChanged: event.filesChanged ?? [],
              draftAvailable: event.draftAvailable ?? false,
            },
            transcript:
              replyText && state.activeProjectId && !alreadyAppended
                ? mergeMessages(state.transcript, [
                    {
                      role: "assistant" as const,
                      text: replyText,
                      createdAt: new Date().toISOString(),
                      runId: event.runId ?? null,
                      images: [],
                    },
                  ])
                : state.transcript,
            activity: [],
            previewNonce: state.previewNonce + 1,
            error: event.error ?? state.error,
          };
        }
        return {
          runStatus: status ?? "running",
          activeQuestion: status === "waiting_for_user" ? state.activeQuestion : null,
        };
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

    // Specialist-attributed tool/status events feed that agent's panel and
    // its readable current action; they are not coordinator activity.
    if (event.agentId && (event.type === "tool_start" || event.type === "tool_result")) {
      const agentId = event.agentId;
      const detail = summarizeToolInput(event.tool ?? event.name, event.input);
      set((current) => {
        const agent = current.team[agentId];
        if (!agent) return {};
        const files = new Set(agent.files);
        const path = typeof event.input?.path === "string" ? event.input.path : null;
        if (event.type === "tool_result" && event.ok !== false && path) files.add(path);
        return {
          team: {
            ...current.team,
            [agentId]: {
              ...agent,
              currentAction: detail || agent.currentAction,
              files: [...files],
            },
          },
        };
      });
    }

    set((state) => {
      const activity = [...state.activity];
      const last = activity[activity.length - 1];

      if (event.type === "thinking_delta" || event.type === "assistant_delta") {
        const kind = event.type === "thinking_delta" ? "thinking" : "assistant";
        if (last && last.kind === kind && last.agentId === event.agentId) {
          // Streaming deltas accumulate on the last item of the same kind,
          // unless a tool item came between (then a new one starts).
          const updated = { ...last, text: last.text + (event.text ?? "") };
          activity[activity.length - 1] = updated;
        } else {
          activity.push({
            id: nextActivityId(),
            kind,
            eventId: event.eventId,
            agentId: event.agentId,
            agentName: event.agentId ? state.team[event.agentId]?.name : undefined,
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
          agentId: event.agentId,
          agentName: event.agentId ? state.team[event.agentId]?.name : undefined,
          toolName: event.name ?? "tool",
          eventId: event.eventId,
          toolDetail: summarizeToolInput(event.name, event.input),
        });
        return { activity };
      }

      if (event.type === "tool_result") {
        // Tools may finish out of order. Provider call IDs are authoritative.
        for (let i = activity.length - 1; i >= 0; i -= 1) {
          const item = activity[i];
          if (item.kind === "tool" && item.ok === undefined && item.agentId === event.agentId &&
              (!event.eventId || item.eventId === event.eventId)) {
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
          agentId: event.agentId,
          agentName: event.agentId ? state.team[event.agentId]?.name : undefined,
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
    case "spawn_agents":
      return "Dispatched a parallel swarm";
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
