import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useStudioStore } from "@/store/studio-store";
import { iterationUrl, listIterations, workspaceUrl } from "@/lib/studioApi";
import { FileDifference, ProjectFiles, projectExportUrl, projectRequest } from "@/lib/projectApi";
import ProjectTools from "./ProjectTools";
const SourceEditor = lazy(() => import("./SourceEditor"));

type View = "preview" | "code" | "history" | "compare";
export default function StudioWorkbench({ projectId }: { projectId: string }) {
  const [view, setView] = useState<View>("preview");
  const [width, setWidth] = useState("fluid");
  const [path, setPath] = useState("index.html");
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const [selection, setSelection] = useState<{ selector: string; text: string } | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [difference, setDifference] = useState<FileDifference[]>([]);
  const [reference, setReference] = useState("");
  const [opacity, setOpacity] = useState(50);
  const [comparison, setComparison] = useState<"side" | "overlay">("side");
  const nonce = useStudioStore((state) => state.previewNonce);
  const runStatus = useStudioStore((state) => state.runStatus);
  const transcript = useStudioStore((state) => state.transcript);
  const setError = useStudioStore((state) => state.setError);
  const bumpPreview = useStudioStore((state) => state.bumpPreview);
  const queryClient = useQueryClient();
  const files = useQuery({ queryKey: ["files", projectId, nonce],
    queryFn: () => projectRequest<ProjectFiles>(projectId, "files") });
  const versions = useQuery({ queryKey: ["versions", projectId, nonce],
    queryFn: () => listIterations(projectId) });
  useEffect(() => {
    if (versions.data) useStudioStore.getState().setIterations(versions.data);
  }, [versions.data]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (!inspecting || event.source !== frame.current?.contentWindow || event.data?.type !== "studio:element") return;
      if (typeof event.data.selector !== "string" || typeof event.data.text !== "string") return;
      setSelection({ selector: event.data.selector.slice(0, 500), text: event.data.text.slice(0, 500) });
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [inspecting]);
  const images = transcript.flatMap((message) => message.images);
  const locked = busy || runStatus === "running" || runStatus === "waiting_for_user";
  const content = draft ?? files.data?.files[path] ?? "";
  useEffect(() => {
    const saved = sessionStorage.getItem(`source-draft:${projectId}:${path}`);
    setDraft(saved);
  }, [projectId, path]);
  const updateDraft = (text: string) => {
    setDraft(text);
    sessionStorage.setItem(`source-draft:${projectId}:${path}`, text);
  };
  const execute = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: ["files", projectId] });
      bumpPreview();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const hasWebPreview = Boolean(files.data?.files["index.html"]);
  const preview = <iframe ref={frame} title="Project preview" key={`${nonce}:${inspecting}`}
    sandbox="allow-scripts allow-forms allow-downloads"
    src={`${workspaceUrl(projectId)}?v=${nonce}&inspect=${inspecting}`} className="workbench-frame" />;
  return <div className="workbench">
    <ProjectTools projectId={projectId} />
    <div className="workbench-toolbar">
      <div role="tablist" aria-label="Workspace view" className="workbench-tabs">
        {(["preview", "compare", "code", "history"] as View[]).map((item) =>
          <button key={item} role="tab" aria-selected={view === item} onClick={() => setView(item)}>
            {item[0].toUpperCase() + item.slice(1)}</button>)}
      </div>
      <a className="workbench-export" href={projectExportUrl(projectId)}>Export ZIP</a>
    </div>
    {(view === "preview" || view === "compare") && <div className="workbench-controls">
      <label>Viewport <select value={width} onChange={(event) => setWidth(event.target.value)}>
        <option value="fluid">Fit</option>{[320, 375, 768, 1440].map((size) =>
          <option key={size} value={size}>{size} px</option>)}
      </select></label>
      <button onClick={bumpPreview}>Refresh</button>
      {hasWebPreview && <button aria-pressed={inspecting} onClick={() => { setInspecting(!inspecting); setSelection(null); }}>{inspecting ? "Exit selection" : "Select element"}</button>}
      {hasWebPreview && <a href={workspaceUrl(projectId)} target="_blank" rel="noreferrer">Open preview ↗</a>}
      {runStatus === "running" && <span role="status">Working · showing saved files</span>}
    </div>}
    {selection && <div className="workbench-controls"><code>{selection.selector}</code>
      <button onClick={() => {
        window.dispatchEvent(new CustomEvent("studio:target", { detail: { projectId, ...selection } }));
        setInspecting(false); setSelection(null);
      }}>Use in prompt</button>
      <button onClick={() => setSelection(null)}>Dismiss</button>
    </div>}
    {view === "compare" && <div className="workbench-controls">
      <label>Reference <select value={reference} onChange={(event) => setReference(event.target.value)}>
        <option value="">Choose an image</option>{images.map((image, index) =>
          <option key={index} value={image}>Reference {index + 1}</option>)}
      </select></label>
      <select aria-label="Comparison mode" value={comparison} onChange={(event) => setComparison(event.target.value as "side" | "overlay")}>
        <option value="side">Side by side</option><option value="overlay">Overlay</option>
      </select>
      {comparison === "overlay" && <input aria-label="Reference opacity" type="range" min="0" max="100"
        value={opacity} onChange={(event) => setOpacity(Number(event.target.value))} />}
    </div>}
    {(view === "preview" || view === "compare") && <div className="preview-canvas">
      {files.isLoading ? <p role="status">Loading project…</p> : files.error ?
        <div role="alert">Could not load files. <button onClick={() => files.refetch()}>Retry</button></div> :
        !Object.keys(files.data?.files ?? {}).length ? <div className="workbench-empty">
          <span className="studio-eyebrow">YOUR NEXT IDEA</span><h2>Start with a reference.<br />Make it your own.</h2>
          <p>Attach an image or describe what you want to build in the conversation.</p>
        </div> : !hasWebPreview ? <div className="workbench-empty"><span className="studio-eyebrow">PROJECT WORKSPACE</span><h2>There is no browser entry point.</h2><p>Use Code to work with this project’s files, or export the project. The agents will detect its language and tooling from the workspace.</p><button onClick={() => setView("code")}>Open code</button></div> : <div className={`preview-comparison ${view === "compare" ? comparison : "single"}`}
          style={{ width: width === "fluid" ? "100%" : `${width}px` }}>
          {preview}
          {view === "compare" && reference && <img src={reference} alt="Design reference"
            style={comparison === "overlay" ? { opacity: opacity / 100 } : undefined} />}
        </div>}
    </div>}
    {view === "code" && <div className="code-workspace">
      <div className="file-list" aria-label="Project files">
        <form onSubmit={(event) => {
          event.preventDefault();
          const value = newPath.trim();
          if (!value || value.startsWith("/") || value.split(/[\\/]/).includes("..")) {
            setError("Use a relative file path, for example src/app.js"); return;
          }
          setPath(value); setNewPath("");
        }}>
          <input aria-label="New file path" placeholder="New file…" value={newPath}
            className="w-full bg-transparent p-2 text-xs border-b" onChange={(event) => setNewPath(event.target.value)} />
        </form>
        {Object.keys(files.data?.files ?? {}).sort().map((file) => <button key={file}
          aria-current={file === path ? "true" : undefined} onClick={() => setPath(file)}>{file}</button>)}
      </div>
      <div className="code-document">
        <div className="workbench-controls"><span>{path}{draft !== null ? " · draft" : ""}</span>
          <Button size="sm" disabled={locked || draft === null || !files.data} onClick={() => execute(async () => {
            await projectRequest(projectId, "files", { path, content, revision: files.data?.revision }, "PUT");
            sessionStorage.removeItem(`source-draft:${projectId}:${path}`); setDraft(null);
          })}>{busy ? "Saving…" : "Save version"}</Button>
        </div>
        <Suspense fallback={<p>Loading editor…</p>}>
          {files.isLoading ? <p>Loading source…</p> : <SourceEditor key={`${projectId}:${path}:${files.data?.revision}`} path={path} value={content} onChange={updateDraft} />}
        </Suspense>
      </div>
    </div>}
    {view === "history" && <div className="history-workspace">
      <h2>Version history</h2><p>Restore creates a new version. Earlier versions stay available.</p>
      {versions.isLoading && <p>Loading versions…</p>}
      {versions.data?.length === 0 && <p>Your first saved version will appear here.</p>}
      {versions.data?.slice().reverse().map((version) => <article key={version.id}>
        <div><strong>{version.label}</strong><time>{new Date(version.created_at).toLocaleString()}</time>
          <p>{version.summary}</p></div>
        <div className="version-actions">
          <a href={iterationUrl(projectId, version.id)} target="_blank" rel="noreferrer">Preview ↗</a>
          <button onClick={() => execute(async () => {
            const result = await projectRequest<{ changes: FileDifference[] }>(projectId, `revisions/${version.id}/diff`);
            setDifference(result.changes);
          })}>Compare code</button>
          <Button size="sm" variant="outline" disabled={locked || !files.data} onClick={() => execute(() =>
            projectRequest(projectId, `revisions/${version.id}/restore`, { revision: files.data?.revision }))}>Restore</Button>
        </div>
      </article>)}
      {difference.map((file) => <details key={file.path} open><summary>{file.kind} · {file.path}</summary><pre>{file.diff}</pre></details>)}
    </div>}
  </div>;
}
