import { useStudioStore } from "@/store/studio-store";
const labels: Record<string, string> = { queued: "Queued", working: "Working", verifying: "Reviewing", completed: "Finished", failed: "Needs attention", cancelled: "Stopped" };
export default function TeamPanel({ working }: { working: boolean }) {
  const team = useStudioStore((state) => state.team);
  const members = Object.values(team).filter((member) => member.agentId !== "coordinator");
  if (!members.length) return null;
  return <section className="team-work" aria-label="Project work"><h3>{working ? "Work in progress" : "Work from this run"}</h3>
    {members.map((member) => <details key={member.agentId} className="team-work-item"><summary><span className="team-objective">{member.objective || member.role}</span><span>{labels[member.status] ?? member.status}</span></summary>
      <p>{member.name} · {member.role}</p>{member.summary && <p>{member.summary}</p>}{member.error && <p className="inline-error">{member.error}</p>}
      {!!member.files.length && <p>Files: {member.files.join(", ")}</p>}
      {member.currentAction && <p>Latest tool: {member.currentAction}</p>}
    </details>)}
  </section>;
}
