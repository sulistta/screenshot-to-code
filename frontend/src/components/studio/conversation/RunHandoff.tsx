import { useState } from "react";
import { projectRequest } from "@/lib/projectApi";
import { useStudioStore } from "@/store/studio-store";
export default function RunHandoff({ projectId }: { projectId: string }) {
  const { lastOutcome, iterations, bumpPreview, runStatus } = useStudioStore();
  const [recovering, setRecovering] = useState(false);
  const [recovered, setRecovered] = useState(false);
  if (!lastOutcome) return null;
  const iteration = iterations.find((item) => item.id === lastOutcome.iterationId);
  const recover = async () => {
    if (!lastOutcome.runId || recovering) return;
    setRecovering(true);
    try {
      await projectRequest(projectId, `drafts/${lastOutcome.runId}/restore`, {});
      setRecovered(true); bumpPreview();
    } catch (error) { useStudioStore.getState().setError(error instanceof Error ? error.message : String(error)); }
    finally { setRecovering(false); }
  };
  return <section className="run-handoff" aria-label="Run outcome">
    <strong>{lastOutcome.status === "completed" ? `✓ ${iteration?.label ?? "Work saved"}` : lastOutcome.status === "cancelled" ? "Stopped at your request" : "The run ended before completion"}</strong>
    <p>{lastOutcome.status === "completed" ? "Inspect the result, then describe what you’d like to refine." : "Your saved version is unchanged. You can revise the instruction and try again."}</p>
    {lastOutcome.status === "completed" && !!lastOutcome.filesChanged.length && <details><summary>{lastOutcome.filesChanged.length} files changed</summary><p>{lastOutcome.filesChanged.join(", ")}</p></details>}
    {recovered ? <p role="status">Partial work restored as a new saved version. Review it before continuing.</p> : lastOutcome.draftAvailable && <button className="secondary-action" disabled={recovering || runStatus === "running" || runStatus === "waiting_for_user"} onClick={() => void recover()}>{recovering ? "Restoring…" : "Recover partial work"}</button>}
  </section>;
}
