import { useRef, useState } from "react";
import { projectRequest } from "@/lib/projectApi";
import { useStudioStore } from "@/store/studio-store";

export default function ProjectTools({ projectId }: { projectId: string }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const importInput = useRef<HTMLInputElement>(null);
  const status = useStudioStore((state) => state.runStatus);
  const setError = useStudioStore((state) => state.setError);
  const locked = busy || status === "running" || status === "waiting_for_user";
  const perform = async (action: () => Promise<void>) => {
    setBusy(true); setNotice("");
    try { await action(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <div className="workbench-controls">
    <button disabled={locked} onClick={() => importInput.current?.click()}>Import ZIP</button>
    <input ref={importInput} className="hidden" aria-label="Import project archive" type="file" accept=".zip,application/zip" disabled={locked}
      onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (!file) return;
        void perform(async () => {
          const body = new FormData(); body.append("file", file);
          const base = import.meta.env.VITE_HTTP_BACKEND_URL || "";
          const response = await fetch(`${base}/api/v1/projects/${projectId}/import`, { method: "POST", body });
          if (!response.ok) {
            const error = await response.json(); throw new Error(error.detail || "Import failed");
          }
          useStudioStore.getState().bumpPreview(); setNotice("Project imported");
        });
      }} />
    <button disabled={locked} onClick={() => perform(async () => {
      const result = await projectRequest<{ commit: string }>(projectId, "git", { message: "Studio checkpoint" });
      setNotice(`Local commit ${result.commit.slice(0, 8)}`);
    })}>Save to Git</button>
    {notice && <span role="status">{notice}</span>}
    {busy && <span role="status">Saving…</span>}
  </div>;
}
