import { useShallow } from "zustand/react/shallow";
import { useState } from "react";
import { FiArrowUpRight, FiCheck, FiImage, FiLayers } from "react-icons/fi";
import { useStudioStore } from "@/store/studio-store";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import ThinkingStream from "./ThinkingStream";
import QuestionCard from "./conversation/QuestionCard";
import RunHandoff from "./conversation/RunHandoff";
import { activityLabel } from "./conversation/activityLabel";

/** The project stage shows the current work; messages remain in the session history. */
export default function CreationStage({ projectId, connected, send, onDetails }: {
  projectId: string;
  connected: boolean;
  send: (payload: Record<string, unknown>) => Promise<void>;
  onDetails?: () => void;
}) {
  const { transcript, activity, runStatus, activeQuestion, team, projects } = useStudioStore(useShallow((s) => ({ transcript: s.transcript, activity: s.activity, runStatus: s.runStatus, activeQuestion: s.activeQuestion, team: s.team, projects: s.projects })));
  const [reference, setReference] = useState<string | null>(null);
  const request = [...transcript].reverse().find((message) => message.role === "user");
  const reply = [...transcript].reverse().find((message) => message.role === "assistant");
  const brief = request?.text || projects.find((project) => project.id === projectId)?.brief;
  const references = request?.images ?? [];
  const working = runStatus === "running";
  const members = Object.values(team).filter((agent) => agent.agentId !== "coordinator");
  const active = members.find((agent) => agent.status === "working" || agent.status === "verifying");
  const files = [...new Set(members.flatMap((agent) => agent.filePaths))];
  const title = !connected ? "Opening your workspace" : activeQuestion ? "A decision for you" : working ? "Building your project" :
    runStatus === "completed" ? "Ready for your review" : runStatus === "failed" ? "Let’s get this back on track" :
    runStatus === "cancelled" || runStatus === "stuck" ? "Your work is on pause" : "Your idea starts here";
  const phase = activityLabel(runStatus, activity, connected);
  return <div className="creation-stage" data-phase={activeQuestion ? "question" : runStatus ?? "ready"}>
    {brief && <details className="stage-brief"><summary><span>Your direction</span><p>{brief}</p></summary><div>{brief}</div></details>}
    {references.length > 0 && <div className="stage-references">{references.map((src, i) => <button key={i} aria-label={`View reference ${i + 1}`} onClick={() => setReference(src)}><img src={src} alt={`Reference ${i + 1}`} /></button>)}</div>}
    <div className="stage-focus">
      <div className={`stage-mark ${working ? "is-working" : ""}`} aria-hidden="true">
        {runStatus === "completed" ? <FiCheck /> : references.length ? <FiImage /> : <FiLayers />}
        {working && <span />}
      </div>
      <h2 key={title}>{title}</h2>
      {!activeQuestion && (working || !connected) && <p className="stage-caption" role="status" aria-live="polite">{phase}</p>}
      {activeQuestion ? <QuestionCard send={send} /> : working ? <div className="stage-work">
        <ThinkingStream />
        {active ? <button className="stage-current-task" onClick={onDetails}>
          <span className="run-dot working" aria-hidden="true" /><span><strong>{active.name}</strong><span>{active.currentAction || active.objective}</span></span><FiArrowUpRight aria-hidden="true" />
        </button> : <div className="stage-placeholder" aria-label="Preparing the next step"><span /><span /><span /></div>}
        {files.length > 0 && <button className="stage-files" onClick={onDetails} title="See assigned files and agent activity"><FiLayers aria-hidden="true" /><span>{files.slice(0, 2).join(" · ")}{files.length > 2 ? ` · +${files.length - 2}` : ""}</span><FiArrowUpRight aria-hidden="true" /></button>}
      </div> : <>
        {!runStatus && <p className="stage-guidance">Describe the outcome you want. References and details can come along the way.</p>}
        {runStatus === "completed" && reply?.text && <details className="stage-summary"><summary>What changed</summary><p>{reply.text}</p></details>}
        <RunHandoff projectId={projectId} />
      </>}
    </div>
    <Dialog open={reference !== null} onOpenChange={(open) => { if (!open) setReference(null); }}>
      <DialogContent className="forge-reference-dialog"><DialogTitle className="sr-only">Project reference</DialogTitle><DialogDescription className="sr-only">Original image attached to your request.</DialogDescription>{reference && <img src={reference} alt="Project reference" />}</DialogContent>
    </Dialog>
  </div>;
}
