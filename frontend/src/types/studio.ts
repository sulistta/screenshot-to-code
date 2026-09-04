/** Studio (durable project) protocol types.
 *
 * The studio flow is a separate surface from the variant flow: one project
 * socket streams run events, and runs persist to the backend.
 */

export interface StudioProject {
  id: string;
  name: string;
  brief: string;
  createdAt: string;
  updatedAt: string;
}

export interface StudioTranscriptMessage {
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  runId: string | null;
  images: string[];
}

export interface StudioRunEvent {
  type:
    | "assistant_delta"
    | "thinking_delta"
    | "tool_start"
    | "tool_result"
    | "set_code"
    | "question"
    | "status"
    | "run_status";
  runId?: string;
  eventId?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  ok?: boolean;
  content?: string;
  question?: string;
  questionId?: string;
  options?: string[] | null;
  message?: string;
  status?: string;
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
