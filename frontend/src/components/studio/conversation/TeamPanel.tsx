import { useStudioStore } from "@/store/studio-store";

const AGENT_STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  working: "Working",
  verifying: "Verifying",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

const AGENT_STATUS_CLASS: Record<string, string> = {
  queued: "bg-secondary text-secondary-foreground",
  working: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  verifying: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  completed: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  failed: "bg-destructive/15 text-destructive",
  cancelled: "bg-secondary text-muted-foreground",
};

export function TeamPanel({ working }: { working: boolean }) {
  const team = useStudioStore((state) => state.team);
  const members = Object.values(team);
  if (members.length === 0) return null;
  return (
    <section aria-label="Team" className="space-y-1.5">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
        Team
      </div>
      {members.map((member) => (
        <article key={member.agentId} className="rounded-md border px-2.5 py-2 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium truncate">
              {member.name} <span className="font-normal text-muted-foreground">· {member.role}</span>
            </span>
            <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] ${AGENT_STATUS_CLASS[member.status] ?? ""}`}>
              {member.status === "working" && working && (
                <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-current" />
              )}
              {AGENT_STATUS_LABEL[member.status] ?? member.status}
            </span>
          </div>
          {member.objective && (
            <p className="text-[11px] text-muted-foreground/80 line-clamp-2" title={member.objective}>
              {member.objective}
            </p>
          )}
          {member.currentAction && member.status !== "completed" && (
            <p className="text-[11px] text-muted-foreground">{member.currentAction}</p>
          )}
          {member.files.length > 0 && (
            <p className="truncate text-[10px] text-muted-foreground/70" title={member.files.join(", ")}>
              {member.files.slice(0, 3).map((file) => file.split("/").pop()).join(", ")}
              {member.files.length > 3 ? ` +${member.files.length - 3}` : ""}
            </p>
          )}
          {member.error && <p className="text-[11px] text-destructive">{member.error}</p>}
          {member.summary && member.status === "completed" && (
            <p className="text-[11px] text-muted-foreground/80 line-clamp-2">{member.summary}</p>
          )}
        </article>
      ))}
    </section>
  );
}

export default TeamPanel;
