/** Studio (durable project) protocol types.
 *
 * The studio flow is a separate surface from the variant flow: one project
 * socket streams run events, and runs persist to the backend.
 */

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
  executionMode: "auto" | "single" | "swarm";
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
    execution_mode: string;
  };
  files_changed: string[];
  iteration_id: string | null;
  error: string | null;
}

export type ExecutionMode = "auto" | "single" | "swarm";

export interface StudioTranscriptMessage {
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  runId: string | null;
  images: string[];
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
    | "swarm_agent"
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
  iterationId?: string | null;
  filesChanged?: string[];
  config?: {
    primary_model: string;
    subagent_model: string;
    execution_mode: string;
  };
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
