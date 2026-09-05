import { useStudioStore } from "@/store/studio-store";

const AGENT_STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  working: "Working",
  verifying: "Verifying",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function TeamPanel({ working }: { working: boolean }) {
  const team = useStudioStore((state) => state.team);
  const members = Object.values(team);
  if (members.length === 0) return null;
  return (
    <section aria-label="Team" className="space-y-2">
      {members.map((member) => {
        const done = member.status === "completed";
        const active = member.status === "working" || member.status === "verifying";
        const failed = member.status === "failed";
        return (
          <article key={member.agentId} className="forge-card px-3.5 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2.5 min-w-0">
                <span className={`grid place-items-center w-7 h-7 rounded-full shrink-0 ${done ? "bg-emerald-500 text-white" : active ? "bg-blue-500 text-white" : failed ? "bg-red-100 text-red-600" : "bg-stone-100 dark:bg-zinc-800 text-stone-500"}`}>
                  {done ? (
                    <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M2.5 7.5 5.5 10.5 11.5 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  ) : active ? (
                    <span className={`inline-block h-3.5 w-3.5 rounded-full border-2 border-white/60 border-t-white ${working ? "animate-spin" : ""}`} />
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.2" stroke="currentColor" strokeWidth="1.4" /><path d="M7 4.5V7l1.6 1.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium truncate text-stone-900 dark:text-zinc-100">{member.name}</span>
                  <span className="block text-[11.5px] text-stone-500 dark:text-zinc-400 truncate">{member.role}{member.objective ? ` · ${member.objective}` : ""}</span>
                </span>
              </span>
              <span className="flex items-center gap-2 shrink-0">
                <span className={`text-[12px] font-medium ${done ? "text-emerald-600" : active ? "text-blue-600" : "text-stone-400"}`}>
                  {AGENT_STATUS_LABEL[member.status] ?? member.status}
                </span>
                <svg width="14" height="14" viewBox="0 0 14 14" className="text-stone-300"><path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" /></svg>
              </span>
            </div>
            {member.currentAction && member.status !== "completed" && (
              <p className="mt-1.5 pl-9 text-[11.5px] text-stone-500 dark:text-zinc-400">{member.currentAction}</p>
            )}
            {member.files.length > 0 && (
              <p className="mt-0.5 pl-9 truncate text-[11px] text-stone-400" title={member.files.join(", ")}>
                {member.files.slice(0, 3).map((file) => file.split("/").pop()).join(", ")}
                {member.files.length > 3 ? ` +${member.files.length - 3}` : ""}
              </p>
            )}
            {member.error && <p className="mt-1 pl-9 text-[11.5px] text-red-600">{member.error}</p>}
            {member.summary && member.status === "completed" && (
              <p className="mt-1 pl-9 text-[11.5px] text-stone-500 dark:text-zinc-400 line-clamp-2">{member.summary}</p>
            )}
          </article>
        );
      })}
    </section>
  );
}

export default TeamPanel;
