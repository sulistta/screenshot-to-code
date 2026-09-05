import type { StudioActivityItem } from "@/store/studio-store";
import type { StudioRunStatus } from "@/types/studio";

export function activityLabel(status: StudioRunStatus | null, activity: StudioActivityItem[], connected = true): string {
  if (!connected) return "Connecting to your project…";
  if (status === "waiting_for_user") return "Your answer is needed to continue";
  if (status === "completed") return "Saved · ready for your next idea";
  if (status === "failed") return "Run failed · review the details";
  if (status === "cancelled") return "Stopped · continue whenever you’re ready";
  if (status === "stuck") return "Stopped without progress · try a different direction";
  if (!status) return "Ready when you are";
  const tool = [...activity].reverse().find((item) => item.kind === "tool" && item.ok === undefined);
  switch (tool?.toolName) {
    case "ask_user": return "Preparing a question…";
    case "spawn_agent": return "A specialist is working on your project…";
    case "research": return "Checking references…";
    case "create_file": case "edit_file": return "Writing project files…";
    case "read_file": case "list_files": return "Inspecting your project…";
    case "screenshot_preview": return "Reviewing the result visually…";
    case "generate_images": return "Creating visual assets…";
    default: return "Working on your request…";
  }
}
