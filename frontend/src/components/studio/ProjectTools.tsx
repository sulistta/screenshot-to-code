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
  return <div className="workbench-controls">
    <button disabled={locked} onClick={() => perform(async () => {
      if (await importProject(projectId)) { useStudioStore.getState().bumpPreview(); setNotice("Project imported"); }
    })}>Import ZIP</button>
    <button disabled={locked} onClick={() => perform(async () => {
      const result = await gitCheckpoint(projectId); setNotice(`Local commit ${result.commit.slice(0, 8)}`);
    })}>Save to Git</button>
    {notice && <span role="status">{notice}</span>}{busy && <span role="status">Saving…</span>}
  </div>;
}
