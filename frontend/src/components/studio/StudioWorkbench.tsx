import { FiArrowUpRight } from "react-icons/fi";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useStudioStore } from "@/store/studio-store";
import { getServicesStatus, openPreview, listIterations, startServices, stopServices, workspaceUrl } from "@/lib/studioApi";
import { FileDifference, getFiles, editFile, revisionDiff, restoreRevision, exportProject } from "@/lib/projectApi";
import { loadPreference, savePreference } from "@/lib/draftPreferences";
import ProjectTools from "./ProjectTools";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
const SourceEditor = lazy(() => import("./SourceEditor"));

type View = "preview" | "code" | "history" | "compare";

const draftSessionKey = (projectId: string, path: string) => `source-draft:${projectId}:${path}`;
const draftPreferenceKey = (projectId: string, path: string) => `draft:${projectId}:${path}`;

/**
 * Unsaved file edits survive an app restart through native persistence.
 * Session storage wins when both exist; native saves are debounced.
 */
function useFileDraft(projectId: string, path: string) {
  const [draft, setDraft] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(draftSessionKey(projectId, path));
    } catch {
      return null;
    }
  });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    let cancelled = false;
    let session: string | null = null;
    try {
      session = sessionStorage.getItem(draftSessionKey(projectId, path));
    } catch {
      session = null;
    }
    setDraft(session);
    if (session === null) {
      void loadPreference<string>(draftPreferenceKey(projectId, path)).then((saved) => {
        if (!cancelled && saved != null) setDraft(saved);
      });
    }
    return () => {
      cancelled = true;
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [projectId, path]);
  const updateDraft = (text: string) => {
    setDraft(text);
    try {
      sessionStorage.setItem(draftSessionKey(projectId, path), text);
    } catch { /* ignore */ }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void savePreference(draftPreferenceKey(projectId, path), text).catch(() => undefined);
    }, 800);
  };
  const discardDraft = () => {
    setDraft(null);
    try {
      sessionStorage.removeItem(draftSessionKey(projectId, path));
    } catch { /* ignore */ }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    void savePreference<string | null>(draftPreferenceKey(projectId, path), null).catch(() => undefined);
  };
  return { draft, updateDraft, discardDraft };
}

/**
 * Opens the project in the existing isolated Tauri preview window (no IPC,
 * filesystem, or credentials). Only rendered when the project actually has a
 * supported preview entry point.
 */
export function PreviewWindowButton({ projectId, compact }: { projectId: string; compact?: boolean }) {
  const setError = useStudioStore((state) => state.setError);
  const files = useQuery({
    queryKey: ["files", projectId],
    queryFn: () => getFiles(projectId),
  });
  const hasEntry = Boolean(files.data?.files["index.html"]);
  const [busy, setBusy] = useState(false);
  if (!hasEntry) return null;
  return (
    <button
      className={compact
        ? "text-[11.5px] text-stone-500 hover:text-stone-900 disabled:opacity-40"
        : "forge-btn-secondary disabled:opacity-40"}
      disabled={busy || files.isLoading}
      title="Opens an isolated preview window without app access"
      onClick={() => {
        setBusy(true);
        openPreview(projectId)
          .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
          .finally(() => setBusy(false));
      }}
    >
      {busy ? "Opening…" : "Open preview window"} {!compact && <FiArrowUpRight aria-hidden className="inline-block" />}
    </button>
  );
}
export default function StudioWorkbench({ projectId, view, onViewChange }: { projectId: string; view?: View; onViewChange?: (v: View) => void }) {
  const [internalView, setInternalView] = useState<View>(() => {
    const saved = sessionStorage.getItem(`workbench-view:${projectId}`);
    return saved === "code" || saved === "history" || saved === "compare" ? saved : "preview";
  });
  const [toolsOpen, setToolsOpen] = useState(false);
  const [codeVisited, setCodeVisited] = useState(internalView === "code");
  const currentView = view ?? internalView;
  const setView = (next: View) => {
    (onViewChange ?? setInternalView)(next);
    if (next === "code") setCodeVisited(true);
    sessionStorage.setItem(`workbench-view:${projectId}`, next);
    setToolsOpen(false);
  };
  const [width, setWidth] = useState("fluid");
  const [path, updatePath] = useState(() => sessionStorage.getItem(`workbench-path:${projectId}`) ?? "index.html");
  const setPath = (next: string) => { updatePath(next); sessionStorage.setItem(`workbench-path:${projectId}`, next); };
  const { draft, updateDraft, discardDraft } = useFileDraft(projectId, path);
  const [busy, setBusy] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const [selection, setSelection] = useState<{ selector: string; text: string } | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [difference, setDifference] = useState<FileDifference[]>([]);
  const [reference, setReference] = useState("");
  const [opacity, setOpacity] = useState(50);
  const [comparison, setComparison] = useState<"side" | "overlay">("side");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [toolNotice, setToolNotice] = useState("");
  const nonce = useStudioStore((state) => state.previewNonce);
  const runStatus = useStudioStore((state) => state.runStatus);
  const transcript = useStudioStore((state) => state.transcript);
  const setError = useStudioStore((state) => state.setError);
  const bumpPreview = useStudioStore((state) => state.bumpPreview);
  const queryClient = useQueryClient();
  const files = useQuery({ queryKey: ["files", projectId],
    queryFn: () => getFiles(projectId) });
  const versions = useQuery({ queryKey: ["versions", projectId],
    queryFn: () => listIterations(projectId) });
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ["files", projectId] });
    void queryClient.invalidateQueries({ queryKey: ["versions", projectId] });
  }, [nonce, projectId, queryClient]);
  const isAppProject = Boolean(files.data?.files["package.json"]);
  const services = useQuery({
    queryKey: ["services", projectId],
    queryFn: () => getServicesStatus(projectId),
    enabled: isAppProject,
    refetchInterval: (query) =>
      ["installing", "running"].includes(query.state.data?.state ?? "") ? 1500 : false,
  });
  const appRunning = services.data?.state === "running";
  useEffect(() => {
    if (versions.data) useStudioStore.getState().setIterations(versions.data);
  }, [versions.data]);
  const [previewNonce, setPreviewNonce] = useState(nonce);
  useEffect(() => {
    if (autoRefresh) setPreviewNonce(nonce);
  }, [autoRefresh, nonce]);
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
  const locked = busy || services.data?.state === "installing" || runStatus === "running" || runStatus === "waiting_for_user";
  const content = draft ?? files.data?.files[path] ?? "";
  const execute = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: ["files", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["services", projectId] });
      bumpPreview();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const hasWebPreview = Boolean(files.data?.files["index.html"]);
  const previewUrl = appRunning && services.data?.url ? `${services.data.url}?v=${previewNonce}` : `${workspaceUrl(projectId)}?v=${previewNonce}&inspect=${inspecting}`;
  const staticPreview = <iframe ref={frame} title="Project preview" key={`${previewNonce}:${inspecting}:${previewUrl}`}
    sandbox="allow-scripts allow-forms allow-downloads"
    src={previewUrl} className="forge-preview-frame" />;
  const fileCount = Object.keys(files.data?.files ?? {}).length;

  return <div className="workbench min-h-0">
    <div className="result-heading">
      <div className="result-views" role="group" aria-label="Workspace view">
        <button aria-pressed={currentView === "preview" || currentView === "compare"} onClick={() => setView("preview")}>Preview</button>
        <button aria-pressed={currentView === "code"} onClick={() => setView("code")}>Code</button>
        {currentView === "history" && <span className="text-xs text-stone-500">History</span>}
      </div>
      <Popover open={toolsOpen} onOpenChange={setToolsOpen}>
        <PopoverTrigger asChild><button aria-label="Result options" className="result-options">···</button></PopoverTrigger>
        <PopoverContent align="end" className="result-menu">
          <button onClick={() => setView("history")}>Version history</button>
          <button onClick={() => setView("compare")}>Compare reference</button>
          <PreviewWindowButton projectId={projectId} compact />
          <button disabled={busy} onClick={() => execute(async () => { const saved = await exportProject(projectId); setToolNotice(saved ? "Archive exported" : ""); })}>Export ZIP</button>
            <label className="flex items-center gap-1.5 text-[11.5px] text-stone-500 dark:text-zinc-400">
              Auto-refresh
              <button role="switch" aria-label="Auto-refresh preview" aria-checked={autoRefresh} onClick={() => setAutoRefresh(!autoRefresh)} className={`w-8 h-[18px] rounded-full p-[2px] transition-colors ${autoRefresh ? "bg-stone-900 dark:bg-white" : "bg-stone-200 dark:bg-zinc-700"}`}>
                <span className={`block w-[14px] h-[14px] rounded-full bg-white dark:bg-black transition-transform ${autoRefresh ? "translate-x-[14px]" : ""}`} style={autoRefresh ? undefined : { background: "#fff" }} />
              </button>
            </label>
          <ProjectTools projectId={projectId} />
        </PopoverContent>
      </Popover>
      {toolNotice && <span role="status" className="text-xs">{toolNotice}</span>}
    </div>

    <div className="result-preview" hidden={currentView !== "preview" && currentView !== "compare"}>
        <div className="forge-preview-tools flex items-center justify-between gap-2 px-4 py-2.5 border-b border-stone-200/70 dark:border-zinc-800">

          <span className="flex items-center gap-3">
            <label className="hidden sm:flex items-center gap-1 text-[11.5px] text-stone-500">
              <span className="sr-only">Viewport</span>
              <select value={width} onChange={(event) => setWidth(event.target.value)} className="forge-select !py-1 !px-2 !text-[11.5px]">
                <option value="fluid">Fit</option>{[320, 375, 768, 1440].map((size) =>
                  <option key={size} value={size}>{size} px</option>)}
              </select>
            </label>
            <button onClick={() => { bumpPreview(); setPreviewNonce(useStudioStore.getState().previewNonce); }} className="text-[11.5px] text-stone-500 hover:text-stone-900">Refresh</button>
            {isAppProject && services.data?.state === "crashed" ? (
              <span className="inline-flex items-center gap-2">
                <Button size="sm" className="h-7 text-[11.5px] rounded-lg" disabled={busy} onClick={() => execute(() => startServices(projectId))}>
                  Restart app
                </Button>
              </span>
            ) : isAppProject && (["running", "installing"].includes(services.data?.state ?? "") ?
              <button onClick={() => execute(() => stopServices(projectId))} className="text-[11.5px]">Stop app</button> :
              <Button size="sm" className="h-7 text-[11.5px] rounded-lg" disabled={services.data?.state === "installing"} onClick={() => execute(() => startServices(projectId))}>
                {services.data?.state === "installing" ? "Starting…" : "Start app"}
              </Button>)}
            {hasWebPreview && !appRunning && (
              <button
                aria-pressed={inspecting}
                title="Select an element in the static preview to reference it in the conversation"
                onClick={() => { setInspecting(!inspecting); setSelection(null); }}
                className={`text-[11.5px] px-2 py-1 rounded-md ${inspecting ? "bg-blue-50 text-blue-700" : "text-stone-500 hover:text-stone-900"}`}
              >{inspecting ? "Exit selection" : "Select element"}</button>
            )}
          </span>
        </div>

        <div className="result-canvas">
          {files.isLoading ? <p role="status" className="py-16 text-center text-[13px] text-stone-400">Loading project…</p> : files.error && !files.data ?
            <div role="alert" className="py-16 text-center text-[13px]">Could not load files. <button className="underline" onClick={() => files.refetch()}>Retry</button></div> :
            !fileCount ? <div className="bg-white dark:bg-zinc-900 rounded-xl py-16 px-6 text-center">
              <div className="text-[26px] font-bold tracking-tight">Preview</div>
              <p className="mt-2 text-[12.5px] text-stone-400">Your result will appear here when it is saved.</p>
            </div> : appRunning || hasWebPreview ? <div className={`mx-auto bg-white rounded-xl overflow-hidden border border-stone-200/60 ${currentView === "compare" && comparison === "side" && reference ? "relative" : "relative"}`}
              style={{ width: width === "fluid" ? "100%" : `min(100%, ${width}px)` }}>
              <div className={`relative ${currentView === "compare" && comparison === "side" && reference ? "grid grid-cols-2" : ""}`} style={{ minHeight: 380 }}>
                {staticPreview}
                {currentView === "compare" && reference && (
                  <img src={reference} alt="Design reference" className={comparison === "overlay" ? "absolute inset-0 pointer-events-none" : "border-t border-stone-100"}
                    style={comparison === "overlay" ? { opacity: opacity / 100, objectFit: "contain" } : undefined} />
                )}

              </div>
            </div> : !isAppProject ? <div className="p-8 text-center text-sm text-stone-500">
              <p>These files do not have a web preview yet.</p>
              <button className="forge-btn-secondary mt-3" onClick={() => setView("code")}>View code</button>
            </div> : <div className="bg-white dark:bg-zinc-900 rounded-xl py-14 px-6 text-center">
              <p className="text-[15px] font-medium">This project runs as an app.</p>
              <p className="mt-1 text-[12.5px] text-stone-500">Start it to install dependencies and launch its services.</p>
              <Button className="mt-4 rounded-[10px]" onClick={() => execute(() => startServices(projectId))} disabled={busy || services.data?.state === "installing"}>
                {services.data?.state === "installing" ? "Starting…" : services.data?.state === "crashed" ? "Try again" : "Start app"}
              </Button>
              {services.data?.error && <p role="alert" className="mt-2 text-[12px] text-red-600">{services.data.error}</p>}
            </div>}
        </div>

        {selection ? <div className="flex items-center gap-2 px-4 py-2.5 border-t border-blue-100 bg-blue-50/60 text-[12px]">
          <code className="truncate flex-1">{selection.selector}</code>
          <button className="forge-btn-secondary !py-1.5" onClick={() => {
            window.dispatchEvent(new CustomEvent("studio:target", { detail: { projectId, ...selection } }));
            setInspecting(false); setSelection(null);
          }}>Use in prompt</button>
          <button onClick={() => setSelection(null)} className="text-stone-500">Dismiss</button>
        </div> : null}
        {currentView === "compare" && <div className="flex items-center gap-2 flex-wrap px-4 py-2.5 border-t border-stone-200/70 dark:border-zinc-800 text-[12px]">
          <label className="flex items-center gap-1.5">Reference <select value={reference} onChange={(event) => setReference(event.target.value)} className="forge-select !py-1">
            <option value="">Choose an image</option>{images.map((image, index) =>
              <option key={index} value={image}>Reference {index + 1}</option>)}
          </select></label>
          {images.length === 0 && <span className="text-[11.5px] text-stone-400">Attach a reference image in the conversation to compare.</span>}
          <select aria-label="Comparison mode" value={comparison} disabled={!reference} onChange={(event) => setComparison(event.target.value as "side" | "overlay")} className="forge-select !py-1 disabled:opacity-40">
            <option value="side">Side by side</option><option value="overlay">Overlay</option>
          </select>
          {comparison === "overlay" && <input aria-label="Reference opacity" type="range" min="0" max="100" disabled={!reference}
            value={opacity} onChange={(event) => setOpacity(Number(event.target.value))} />}
        </div>}
        <div className="flex items-center gap-2 px-4 py-2 border-t border-stone-200/70 dark:border-zinc-800 text-[11.5px] text-stone-500">
          <span className="truncate">⌁ {services.data?.url ?? (hasWebPreview ? `local preview · ${fileCount} files` : "no preview yet")}</span>
          {runStatus === "running" && <span role="status" className="ml-auto shrink-0">Working · showing saved files</span>}
        </div>
      </div>

    {codeVisited && <div hidden={currentView !== "code"} className="result-code">
      <div className="code-workspace min-h-0">
        <div className="file-list !border-r-stone-200/70" aria-label="Project files">
          <form onSubmit={(event) => {
            event.preventDefault();
            const value = newPath.trim();
            if (!value || value.startsWith("/") || value.split(/[\\/]/).includes("..")) {
              setError("Use a relative file path, for example src/app.js"); return;
            }
            setPath(value); setNewPath("");
          }}>
            <input aria-label="New file path" placeholder="New file…" value={newPath}
              className="w-full bg-transparent p-2 text-xs border-b border-stone-200 dark:border-zinc-800 outline-none" onChange={(event) => setNewPath(event.target.value)} />
          </form>
          {Object.keys(files.data?.files ?? {}).sort().map((file) => <button key={file}
            aria-current={file === path ? "true" : undefined} onClick={() => setPath(file)}>{file}</button>)}
        </div>
        <div className="code-document">
          <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-stone-200/70 dark:border-zinc-800 text-[12px]"><span className="truncate">{path}{draft !== null ? " · draft" : ""}</span>
            <Button size="sm" className="h-7 rounded-lg" disabled={locked || draft === null || !files.data} onClick={() => execute(async () => {
              try {
                await editFile(projectId, path, content, files.data!.revision);
              } catch (error) {
                // A revision conflict means someone else saved first: reload
                // so the user can merge instead of overwriting blindly.
                await queryClient.invalidateQueries({ queryKey: ["files", projectId] });
                throw error;
              }
              discardDraft();
            })}>{busy ? "Saving…" : "Save version"}</Button>
          </div>
          <Suspense fallback={<p className="p-4 text-[12px]">Loading editor…</p>}>
            {files.isLoading ? <p className="p-4 text-[12px]">Loading source…</p> : <SourceEditor key={`${projectId}:${path}:${files.data?.revision}`} path={path} value={content} onChange={updateDraft} />}
          </Suspense>
        </div>
      </div>
    </div>}
    {currentView === "history" && <div className="history-workspace p-4 overflow-auto">
      <h2 className="text-[16px] font-semibold">Version history</h2><p className="text-[12.5px] text-stone-500">Restore creates a new version. Earlier versions stay available.</p>
      {versions.isLoading && <p className="mt-3 text-[12.5px]">Loading versions…</p>}
      {versions.data?.length === 0 && <p className="mt-3 text-[12.5px]">Your first saved version will appear here.</p>}
      <div className="mt-3 space-y-2.5">
        {versions.data?.slice().reverse().map((version) => <article key={version.id} className="rounded-xl border border-stone-200 dark:border-zinc-800 p-3.5">
          <div><strong className="text-[13px]">{version.label}</strong><time className="block mt-0.5 text-[11.5px] text-stone-400">{new Date(version.created_at).toLocaleString()}</time>
            <p className="mt-1.5 text-[12.5px] text-stone-600 dark:text-zinc-300">{version.summary}</p></div>
          <div className="mt-2.5 flex gap-2 items-center flex-wrap text-[12px]">
            <button className="forge-btn-secondary !py-1.5 disabled:opacity-40" disabled={busy} title="Opens this version in the isolated preview window" onClick={() => execute(() => openPreview(projectId, version.id))}>Open preview window</button>
            <button className="forge-btn-secondary !py-1.5" onClick={() => execute(async () => {
              const result = await revisionDiff(projectId, version.id);
              setDifference(result.changes);
            })}>Compare code</button>
            <Button size="sm" variant="outline" className="h-7 rounded-lg" disabled={locked || !files.data} onClick={() => execute(() =>
              restoreRevision(projectId, version.id, files.data!.revision))}>Restore</Button>
          </div>
        </article>)}
      </div>
      {difference.map((file) => <details key={file.path} open className="mt-2.5 rounded-xl border border-stone-200 dark:border-zinc-800"><summary className="px-3.5 py-2.5 text-[12px] cursor-pointer">{file.kind} · {file.path}</summary><pre className="border-t border-stone-100 dark:border-zinc-800 p-3.5 text-[11.5px] overflow-auto">{file.diff}</pre></details>)}
    </div>}
  </div>;
}
