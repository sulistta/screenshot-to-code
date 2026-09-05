/** Durable project types shared with Rust commands and IPC channels. */

export interface StudioProject {
  favorite?: boolean;
  archived?: boolean;
  trashed?: boolean;
  id: string;
  name: string;
  brief: string;
  createdAt: string;
  updatedAt: string;
  primaryModel: string;
  subagentModel: string;
}

export interface StudioIteration {
  id: string;
  run_id: string;
  label: string;
  summary: string;
  created_at: string;
}

export interface StudioRunRecord {
  run_id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  config: {
    primary_model: string;
    subagent_model: string;
  };
  files_changed: string[];
  iteration_id: string | null;
  error: string | null;
}

export interface StudioTranscriptMessage {
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  runId: string | null;
  images: string[];
}

export type StudioAgentStatus =
  | "queued"
  | "working"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";

/** One member of the run's team (coordinator or specialist). */
export interface StudioAgent {
  agentId: string;
  name: string;
  role: string;
  parentAgentId: string | null;
  status: StudioAgentStatus;
  objective: string;
  filePaths: string[];
  /** Files the agent actually produced or changed. */
  files: string[];
  currentAction?: string;
  summary?: string;
  error?: string | null;
}

export interface StudioRunEvent {
  type:
    | "user_message"
    | "assistant_delta"
    | "thinking_delta"
    | "tool_start"
    | "tool_result"
    | "set_code"
    | "question"
    | "status"
    | "agent_status"
    | "run_status";
  runId?: string;
  projectId?: string;
  streamId?: string;
  sequence?: number;
  eventId?: string;
  images?: string[];
  error?: string | null;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  ok?: boolean;
  content?: string;
  source?: string;
  question?: string;
  questionId?: string;
  options?: string[] | null;
  message?: string;
  status?: string;
  agent?: string;
  eventType?: string;
  /** Agent identity fields (specialist-attributed events). */
  agentId?: string;
  role?: string;
  objective?: string;
  filePaths?: string[];
  tool?: string;
  summary?: string;
  iterationId?: string | null;
  filesChanged?: string[];
  config?: {
    primary_model: string;
    subagent_model: string;
  };
  draftAvailable?: boolean;
}

export type StudioRunStatus =
  | "running"
  | "waiting_for_user"
  | "completed"
  | "failed"
  | "cancelled"
  | "stuck";

export interface StudioQuestion {
  questionId: string;
  question: string;
  options: string[] | null;
}
