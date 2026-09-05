import type { StudioActivityItem } from "@/store/studio-store";
import type { StudioAgent, StudioRunStatus } from "@/types/studio";

/** Only pending tool calls describe current work; completed calls are history. */
export function runPresentation(status: StudioRunStatus | null, activity: StudioActivityItem[], team: Record<string, StudioAgent>) {
  if (status === "waiting_for_user") return { title: "Your input is needed", symbol: "?" };
  if (status === "completed") return { title: "Work saved", symbol: "✓" };
  if (status === "failed") return { title: "This run couldn’t finish", symbol: "!" };
  if (status === "cancelled") return { title: "Work stopped", symbol: "■" };
  if (status === "stuck") return { title: "A new direction is needed", symbol: "!" };
  if (status !== "running") return { title: "Ready when you are", symbol: "—" };
  const pending = activity.filter((item) => item.kind === "tool" && item.ok === undefined);
  if (pending.some((item) => item.toolName === "screenshot_preview")) return { title: "Reviewing the result", symbol: "↗" };
  const members = Object.values(team).filter((member) => member.parentAgentId !== null && ["working", "verifying"].includes(member.status));
  if (members.length > 1) return { title: `${members.length} specialists working together`, symbol: "↗" };
  if (pending.some((item) => ["spawn_agent", "spawn_agents"].includes(item.toolName ?? ""))) return { title: "Building your project", symbol: "↗" };
  if (pending.some((item) => item.toolName === "research")) return { title: "Checking references", symbol: "↗" };
  return { title: "Working on your brief", symbol: "↗" };
}
