import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { importProject, gitCheckpoint } from "@/lib/projectApi";
import { useStudioStore } from "@/store/studio-store";

type ToolState = { kind: "idle" } | { kind: "saving" } | { kind: "saved"; message: string };

export default function ProjectTools({ projectId }: { projectId: string }) {
  const [state, setState] = useState<ToolState>({ kind: "idle" });
  const status = useStudioStore((state) => state.runStatus);
  const queryClient = useQueryClient();
  const locked = state.kind === "saving" || status === "running" || status === "waiting_for_user";
  const setError = useStudioStore((state) => state.setError);
  const bumpPreview = useStudioStore((state) => state.bumpPreview);

  const refreshFiles = async () => {
    await queryClient.invalidateQueries({ queryKey: ["files", projectId] });
    bumpPreview();
  };

  return <span className="inline-flex items-center gap-2 text-[12px] text-stone-500 dark:text-zinc-400">
    <button
      disabled={locked}
      className="hover:text-stone-900 dark:hover:text-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed"
      title="Replace the project files with a ZIP archive"
      onClick={() => {
        setState({ kind: "saving" });
        importProject(projectId).then(
          async (imported) => {
            // false means the native file dialog was cancelled: stay silent.
            if (imported) {
              await refreshFiles();
              setState({ kind: "saved", message: "Project imported" });
            } else {
              setState({ kind: "idle" });
            }
          },
          (error: unknown) => {
            setState({ kind: "idle" });
            setError(error instanceof Error ? error.message : String(error));
          },
        );
      }}
    >{state.kind === "saving" ? "Working…" : "Import ZIP"}</button>
    <button
      disabled={locked}
      className="hover:text-stone-900 dark:hover:text-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed"
      title="Record the current files as a local Git commit"
      onClick={() => {
        setState({ kind: "saving" });
        gitCheckpoint(projectId).then(
          (result) => setState({ kind: "saved", message: `Local commit ${result.commit.slice(0, 8)}` }),
          (error: unknown) => {
            setState({ kind: "idle" });
            setError(error instanceof Error ? error.message : String(error));
          },
        );
      }}
    >Save to Git</button>
    {state.kind === "saved" && <span role="status" className="text-stone-400">{state.message}</span>}
  </span>;
}
