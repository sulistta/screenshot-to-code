import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { restoreDraft } from "@/lib/projectApi";
import { useStudioStore } from "@/store/studio-store";

export function RunHandoff({ projectId }: { projectId: string }) {
  const { lastOutcome, iterations, bumpPreview } = useStudioStore();
  const [recovering, setRecovering] = useState(false);
  const [recovered, setRecovered] = useState(false);
  const runId = lastOutcome?.runId ?? null;
  // Recovery results belong to a single run: a new outcome resets the flag.
  useEffect(() => {
    setRecovered(false);
    setRecovering(false);
  }, [runId]);
  if (!lastOutcome) return null;

  const recoverDraft = async () => {
    if (!lastOutcome.runId || recovering) return;
    setRecovering(true);
    try {
      await restoreDraft(projectId, lastOutcome.runId);
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
    return <p className="run-completion" role="status">✓ Saved{iteration ? " as a new version" : ""}
      {lastOutcome.filesChanged.length > 0 ? ` · ${lastOutcome.filesChanged.length} files changed` : ""}
    </p>;
  }

  if (lastOutcome.status === "cancelled" || lastOutcome.status === "stuck") {
    return (
      <div className="rounded-xl bg-stone-100 dark:bg-zinc-800/60 px-3.5 py-3 text-xs text-stone-500 dark:text-zinc-400 space-y-2">
        {lastOutcome.status === "cancelled"
          ? "Stopped. The work written so far is kept — continue whenever you're ready."
          : "The agent repeated itself without progress and was stopped. Try rephrasing the request."}
        {recovered ? (
          <div className="text-emerald-700 dark:text-emerald-400">
            Partial work restored to the preview.
          </div>
        ) : lastOutcome.draftAvailable && lastOutcome.runId ? (
          <div>
            <Button size="sm" variant="outline" className="h-7 text-xs rounded-lg"
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
    <div className="rounded-xl bg-red-50 dark:bg-red-950/20 border border-red-100 dark:border-red-900/30 px-3.5 py-3 text-xs space-y-2">
      <div>
        <span className="font-medium text-red-600">Failed.</span>{" "}
        <span className="text-stone-500 dark:text-zinc-400">
          Review the error details and try again. Your request is still in the conversation.
        </span>
      </div>
      {recovered ? (
        <div className="text-emerald-700 dark:text-emerald-400">
          Partial work restored to the preview.
        </div>
      ) : lastOutcome.draftAvailable && lastOutcome.runId ? (
        <div>
          <Button size="sm" variant="outline" className="h-7 text-xs rounded-lg"
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
