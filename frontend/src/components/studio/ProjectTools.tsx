import { useState } from "react";
import { importProject, gitCheckpoint } from "@/lib/projectApi";
import { useStudioStore } from "@/store/studio-store";
export default function ProjectTools({ projectId }: { projectId: string }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const status = useStudioStore((state) => state.runStatus);
  const locked = busy || status === "running" || status === "waiting_for_user";
  const perform = async (action: () => Promise<void>) => {
    setBusy(true); setNotice("");
    try { await action(); }
    catch (error) { useStudioStore.getState().setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <span className="inline-flex items-center gap-2 text-[12px] text-stone-500 dark:text-zinc-400">
    <button disabled={locked} className="hover:text-stone-900 dark:hover:text-zinc-100 disabled:opacity-40" onClick={() => perform(async () => {
      if (await importProject(projectId)) { useStudioStore.getState().bumpPreview(); setNotice("Project imported"); }
    })}>Import ZIP</button>
    <button disabled={locked} className="hover:text-stone-900 dark:hover:text-zinc-100 disabled:opacity-40" onClick={() => perform(async () => {
      const result = await gitCheckpoint(projectId); setNotice(`Local commit ${result.commit.slice(0, 8)}`);
    })}>Save to Git</button>
    {notice && <span role="status" className="text-stone-400">{notice}</span>}{busy && <span role="status">Saving…</span>}
  </span>;
}
