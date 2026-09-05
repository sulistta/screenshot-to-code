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
    return (
      <div className="rounded-xl border border-emerald-200/70 bg-emerald-50/60 dark:border-emerald-900/40 dark:bg-emerald-950/20 px-3.5 py-3 text-xs space-y-1">
        <div className="font-medium text-stone-900 dark:text-zinc-100">
          ✓ {iteration?.label ?? "Completed"}
          {iteration ? (
            <span className="ml-2 font-normal text-stone-500">
              saved as {iteration.id}
            </span>
          ) : null}
        </div>
        {lastOutcome.filesChanged.length > 0 && (
          <div className="text-stone-500 dark:text-zinc-400">
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
        <div className="text-stone-400">
          Continue below — describe a change, give feedback, or inspect the
          preview.
        </div>
      </div>
    );
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
          See the error above for details about what failed.
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
