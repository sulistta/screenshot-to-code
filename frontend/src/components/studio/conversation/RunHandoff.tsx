import { useState } from "react";
import { Button } from "@/components/ui/button";
import { projectRequest } from "@/lib/projectApi";
import { useStudioStore } from "@/store/studio-store";

export function RunHandoff({ projectId }: { projectId: string }) {
  const { lastOutcome, iterations, bumpPreview } = useStudioStore();
  const [recovering, setRecovering] = useState(false);
  const [recovered, setRecovered] = useState(false);
  if (!lastOutcome) return null;

  const recoverDraft = async () => {
    if (!lastOutcome.runId || recovering) return;
    setRecovering(true);
    try {
      await projectRequest(projectId, `drafts/${lastOutcome.runId}/restore`, {});
      useStudioStore.getState().setError(null);
      setRecovered(true);
      bumpPreview();
    } catch (error) {
      useStudioStore.getState().setError(error instanceof Error ? error.message : String(error));
    } finally {
      setRecovering(false);
    }
  };

  if (lastOutcome.status === "completed") {
    const iteration =
      iterations.find((it) => it.id === lastOutcome.iterationId) ?? null;
    return (
      <div className="rounded-md bg-emerald-500/[0.07] px-3 py-2.5 text-xs space-y-1.5">
        <div className="font-medium text-foreground">
          ✓ {iteration?.label ?? "Completed"}
          {iteration ? (
            <span className="ml-2 font-normal text-muted-foreground">
              saved as {iteration.id}
            </span>
          ) : null}
        </div>
        {lastOutcome.filesChanged.length > 0 && (
          <div className="text-muted-foreground">
            Changed{" "}
            {lastOutcome.filesChanged
              .slice(0, 4)
              .map((f) => f.split("/").pop())
              .join(", ")}
            {lastOutcome.filesChanged.length > 4
              ? ` +${lastOutcome.filesChanged.length - 4} more`
              : ""}
          </div>
        )}
        <div className="text-muted-foreground/80">
          Continue below — describe a change, give feedback, or inspect the
          preview.
        </div>
      </div>
    );
  }

  if (lastOutcome.status === "cancelled" || lastOutcome.status === "stuck") {
    return (
      <div className="rounded-md bg-secondary px-3 py-2.5 text-xs text-muted-foreground space-y-2">
        {lastOutcome.status === "cancelled"
          ? "Stopped. The work written so far is kept — continue whenever you're ready."
          : "The agent repeated itself without progress and was stopped. Try rephrasing the request."}
        {recovered ? (
          <div className="text-emerald-700 dark:text-emerald-400">
            Partial work restored to the preview.
          </div>
        ) : lastOutcome.draftAvailable && lastOutcome.runId ? (
          <div>
            <Button size="sm" variant="outline" className="h-7 text-xs"
              disabled={recovering}
              onClick={() => { void recoverDraft(); }}>
              {recovering ? "Restoring…" : "Restore partial work to the preview"}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="rounded-md bg-destructive/[0.07] px-3 py-2.5 text-xs space-y-2">
      <div>
        <span className="font-medium text-destructive">Failed.</span>{" "}
        <span className="text-muted-foreground">
          See the error above for details about what failed.
        </span>
      </div>
      {recovered ? (
        <div className="text-emerald-700 dark:text-emerald-400">
          Partial work restored to the preview.
        </div>
      ) : lastOutcome.draftAvailable && lastOutcome.runId ? (
        <div>
          <Button size="sm" variant="outline" className="h-7 text-xs"
            disabled={recovering}
            onClick={() => { void recoverDraft(); }}>
            {recovering ? "Restoring…" : "Restore partial work to the preview"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export default RunHandoff;
