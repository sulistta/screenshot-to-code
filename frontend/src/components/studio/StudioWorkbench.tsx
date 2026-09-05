import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useStudioStore } from "@/store/studio-store";
import { appUrl, getServicesStatus, iterationUrl, listIterations, startServices, stopServices, workspaceUrl } from "@/lib/studioApi";
import { FileDifference, ProjectFiles, projectExportUrl, projectRequest } from "@/lib/projectApi";
import ProjectTools from "./ProjectTools";
const SourceEditor = lazy(() => import("./SourceEditor"));

type View = "preview" | "code" | "history" | "compare";
export default function StudioWorkbench({ projectId }: { projectId: string }) {
  const [focused, setFocused] = useState(false);
  const [frameLoading, setFrameLoading] = useState(true);
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
  const files = useQuery({ queryKey: ["files", projectId, nonce], placeholderData: keepPreviousData,
    queryFn: () => projectRequest<ProjectFiles>(projectId, "files") });
  const versions = useQuery({ queryKey: ["versions", projectId, nonce],
    queryFn: () => listIterations(projectId) });
  // Full-stack projects run through the supervisor and are previewed via
  // the project gateway instead of the static workspace.
  const isAppProject = Boolean(files.data?.files["package.json"]);
  const services = useQuery({
    queryKey: ["services", projectId],
    queryFn: () => getServicesStatus(projectId),
    enabled: isAppProject,
    refetchInterval: (query) =>
      query.state.data?.state === "installing" ? 1500 : query.state.data?.state === "running" ? 5000 : false,
  });
  const appRunning = services.data?.state === "running";
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
  useEffect(() => { setFrameLoading(true); }, [nonce, inspecting, appRunning]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setFocused(false); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);
  const hasWebPreview = Boolean(files.data?.files["index.html"]);
  const staticPreview = <iframe ref={frame} title="Project preview" key={`${nonce}:${inspecting}`}
    sandbox="allow-scripts allow-forms allow-downloads"
    src={`${workspaceUrl(projectId)}?v=${nonce}&inspect=${inspecting}`} className="workbench-frame" onLoad={() => setFrameLoading(false)} />;
  const appPreview = <iframe ref={frame} title="App preview" key={`app:${nonce}`}
    sandbox="allow-scripts allow-forms allow-downloads allow-same-origin"
    src={`${appUrl(projectId)}?v=${nonce}`} className="workbench-frame" onLoad={() => setFrameLoading(false)} />;
  const previewFrame = appRunning ? appPreview : staticPreview;
  return <div className="workbench" data-focus={focused}>
    <div className="workbench-toolbar">
      <div role="tablist" aria-label="Workspace view" className="workbench-tabs">
        {(["preview", "compare", "code", "history"] as View[]).map((item) =>
          <button key={item} role="tab" aria-selected={view === item} onClick={() => setView(item)}>
            {{ preview: "Result", compare: "Review", code: "Source", history: "Versions" }[item]}</button>)}
      </div>
      <div className="workbench-actions"><details className="project-tools-menu"><summary>Project tools</summary><ProjectTools projectId={projectId} /></details><a className="workbench-export" href={projectExportUrl(projectId)}>Export ZIP</a><button aria-pressed={focused} onClick={() => setFocused(!focused)}>{focused ? "Exit focus" : "Focus"}</button></div>
    </div>
    {(view === "preview" || view === "compare") && <div className="workbench-controls">
      <label>Viewport <select value={width} onChange={(event) => setWidth(event.target.value)}>
        <option value="fluid">Fit to workspace</option><option value="1440">Desktop · 1440</option><option value="768">Tablet · 768</option><option value="375">Mobile · 375</option><option value="320">Small mobile · 320</option>
      </select></label>
      <button onClick={bumpPreview}>Refresh</button>
      {isAppProject && (services.data?.state === "running" ?
        <button onClick={() => execute(() => stopServices(projectId))}>Stop app</button> :
        <Button size="sm" disabled={services.data?.state === "installing"} onClick={() => execute(() => startServices(projectId))}>
          {services.data?.state === "installing" ? "Starting…" : "Start app"}
        </Button>)}
      {hasWebPreview && <button aria-pressed={inspecting} onClick={() => { setInspecting(!inspecting); setSelection(null); }}>{inspecting ? "Exit selection" : "Select element"}</button>}
      {appRunning && <a href={appUrl(projectId)} target="_blank" rel="noreferrer">Open app ↗</a>}
      {hasWebPreview && !appRunning && <a href={workspaceUrl(projectId)} target="_blank" rel="noreferrer">Open preview ↗</a>}
      {<span className="preview-state" role="status">{runStatus === "running" || runStatus === "waiting_for_user" ? "Updating · showing saved version" : runStatus === "failed" || runStatus === "cancelled" || runStatus === "stuck" ? "Previous saved version" : frameLoading && (hasWebPreview || appRunning) ? "Loading preview…" : versions.data?.slice(-1)[0]?.label ?? "Saved version"}</span>}
    </div>}
    {isAppProject && services.error && <p role="alert" className="inline-error">App status could not be loaded. <button onClick={() => services.refetch()}>Retry</button></p>}
    {isAppProject && services.data?.state === "crashed" && <div role="alert" className="inline-error"><strong>The app stopped unexpectedly.</strong><p>{services.data.error || "Try starting it again."}</p><details><summary>Service logs</summary>{services.data.services.map((service) => <pre key={service.name}>{service.name}{"\n"}{service.logs.slice(-30).join("\n")}</pre>)}</details></div>}
    {selection && <div className="workbench-controls"><code>{selection.selector}</code>
      <button onClick={() => {
        window.dispatchEvent(new CustomEvent("studio:target", { detail: { projectId, ...selection } }));
        setFocused(false); setInspecting(false); setSelection(null);
      }}>Use in prompt</button>
      <button onClick={() => setSelection(null)}>Dismiss</button>
    </div>}
    {view === "compare" && images.length === 0 && <p className="review-empty">Add image references to a brief to compare them with your result.</p>}
    {view === "compare" && images.length > 0 && <div className="workbench-controls">
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
          <h2>Bring an existing project.</h2><p>Import a ZIP from Project tools, or write a brief to build from scratch.</p>
        </div> : appRunning ? <div className={`preview-comparison ${view === "compare" ? comparison : "single"}`}
          style={{ width: width === "fluid" ? "100%" : `${width}px` }}>
          {previewFrame}
          {view === "compare" && reference && <img src={reference} alt="Design reference"
            style={comparison === "overlay" ? { opacity: opacity / 100 } : undefined} />}
        </div> : isAppProject && !hasWebPreview ? <div className="workbench-empty">
          <h2>This project runs as an app.</h2>
          <p>Start it to install dependencies and launch its services; the app opens here and on its own origin.</p>
          <Button onClick={() => execute(() => startServices(projectId))} disabled={busy || services.data?.state === "installing"}>
            {services.data?.state === "installing" ? "Starting…" : services.data?.state === "crashed" ? "Try again" : "Start app"}
          </Button>
          {services.data?.error && <p role="alert" className="text-sm text-destructive">{services.data.error}</p>}
        </div> : !hasWebPreview ? <div className="workbench-empty"><h2>There is no browser entry point.</h2><p>Use Source to work with this project’s files, or export the project. The agents will detect its language and tooling from the workspace.</p><button onClick={() => setView("code")}>Open source</button></div> : <div className={`preview-comparison ${view === "compare" ? comparison : "single"}`}
          style={{ width: width === "fluid" ? "100%" : `${width}px` }}>
          {previewFrame}
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
      <h2>Your iterations</h2><p>Restore creates a new version. Earlier versions stay available.</p>
      {versions.isLoading && <p role="status">Loading versions…</p>}{versions.error && <p role="alert">Versions could not be loaded. <button onClick={() => versions.refetch()}>Retry</button></p>}
      {versions.data?.length === 0 && <p>Your first saved version will appear here.</p>}
      {versions.data?.slice().reverse().map((version) => <article key={version.id}>
        <div><strong>{version.label}</strong><time>{new Date(version.created_at).toLocaleString()}</time>
          <p>{version.summary}</p></div>
        <div className="version-actions">
          <a href={iterationUrl(projectId, version.id)} target="_blank" rel="noreferrer">View saved version ↗</a>
          <button onClick={() => execute(async () => {
            const result = await projectRequest<{ changes: FileDifference[] }>(projectId, `revisions/${version.id}/diff`);
            setDifference(result.changes);
          })}>Inspect file changes</button>
          <Button size="sm" variant="outline" disabled={locked || !files.data} onClick={() => execute(() =>
            projectRequest(projectId, `revisions/${version.id}/restore`, { revision: files.data?.revision }))}>Restore as new version</Button>
        </div>
      </article>)}
      {difference.map((file) => <details key={file.path} open><summary>{file.kind} · {file.path}</summary><pre>{file.diff}</pre></details>)}
    </div>}
  </div>;
}
