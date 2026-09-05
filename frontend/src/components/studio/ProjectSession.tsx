import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useProjectSocket } from "@/hooks/useProjectSocket";
import { useStudioStore } from "@/store/studio-store";
import { cancelRun, createProject, getTranscript, startRun, updateProject } from "@/lib/studioApi";
import { ProjectFiles, projectRequest } from "@/lib/projectApi";
import type { Settings } from "@/types";
import type { StudioProject } from "@/types/studio";
import ProjectTools from "./ProjectTools";
import RecoveryNotice from "./RecoveryNotice";
import BriefComposer from "./BriefComposer";
import StudioWorkbench from "./StudioWorkbench";
import ConfigBar from "./conversation/ConfigBar";
import QuestionCard from "./conversation/QuestionCard";
import RunJournal from "./conversation/RunJournal";
import { runPresentation } from "./runPresentation";

export default function ProjectSession({ project, settings, onSettings }: { project?: StudioProject; settings: Settings; onSettings: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const projectId = project?.id ?? null;
  const { transcript, activity, team, runStatus, activeQuestion, lastOutcome, error, previewNonce, handleEvent, setError } = useStudioStore();
  const { connected } = useProjectSocket(projectId, handleEvent);
  const storageKey = `conversation-draft:${projectId ?? "new"}`;
  const [draft, setDraft] = useState(() => sessionStorage.getItem(storageKey) ?? "");
  const [images, setImages] = useState<string[]>([]);
  const [initialModels, setInitialModels] = useState({ primaryModel: "", subagentModel: "" });
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const createdProject = useRef<StudioProject | undefined>(undefined);
  const [stopping, setStopping] = useState(false);
  const [journalOpen, setJournalOpen] = useState(false);
  const [transcriptError, setTranscriptError] = useState(false);
  const [loadingTranscript, setLoadingTranscript] = useState(!!projectId);
  const files = useQuery({ queryKey: ["files", projectId, previewNonce], enabled: !!projectId, placeholderData: keepPreviousData,
    queryFn: () => projectRequest<ProjectFiles>(projectId!, "files") });
  const hasResult = !!Object.keys(files.data?.files ?? {}).length;
  const working = runStatus === "running" || runStatus === "waiting_for_user";
  const presentation = runPresentation(runStatus, activity, team);
  const loadTranscript = () => {
    if (!projectId) return;
    setTranscriptError(false); setLoadingTranscript(true);
    getTranscript(projectId).then((messages) => {
      if (useStudioStore.getState().activeProjectId === projectId) useStudioStore.getState().setTranscript(messages);
    }).catch(() => setTranscriptError(true)).finally(() => setLoadingTranscript(false));
  };
  useEffect(loadTranscript, [projectId]);
  useEffect(() => { sessionStorage.setItem(storageKey, draft); }, [storageKey, draft]);
  useEffect(() => { if (!working) setStopping(false); }, [working]);
  useEffect(() => {
    const target = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId: string; selector: string; text: string }>).detail;
      if (detail.projectId !== projectId) return;
      setDraft((value) => `${value}${value ? "\n\n" : ""}Update element ${detail.selector} (${detail.text}): `);
      document.getElementById("project-brief")?.focus();
    };
    window.addEventListener("studio:target", target);
    return () => window.removeEventListener("studio:target", target);
  }, [projectId]);

  const submit = async () => {
    const text = draft.trim();
    if ((!text && !images.length) || working || submittingRef.current) return;
    submittingRef.current = true; setSubmitting(true); setError(null);
    let destination = project ?? createdProject.current;
    try {
      if (!destination) {
        destination = await createProject(text.slice(0, 64) || "New visual project", text);
        if (initialModels.primaryModel || initialModels.subagentModel) destination = await updateProject(destination.id, initialModels);
        createdProject.current = destination;
        useStudioStore.getState().setProjects([destination, ...useStudioStore.getState().projects]);
        // Keep the user's brief recoverable if starting the run fails.
        sessionStorage.setItem(`conversation-draft:${destination.id}`, text);
      }
      if (!project && (destination.primaryModel !== initialModels.primaryModel || destination.subagentModel !== initialModels.subagentModel)) {
        destination = await updateProject(destination.id, initialModels);
        createdProject.current = destination;
        useStudioStore.getState().updateProject(destination);
      }
      const runId = await startRun(destination.id, text, {
        ...settings, primaryModel: destination.primaryModel, subagentModel: destination.subagentModel,
      }, images);
      if (!project) {
        sessionStorage.removeItem(storageKey);
        sessionStorage.removeItem(`conversation-draft:${destination.id}`);
        navigate(`/projects/${destination.id}`);
      } else if (useStudioStore.getState().activeProjectId === project.id) {
        handleEvent({ type: "user_message", projectId: project.id, runId, text, images });
        setDraft(""); setImages([]);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      // Stay in this composer on a failed start so references remain intact.
      if (destination && !project) {
        useStudioStore.getState().setProjects(useStudioStore.getState().projects.filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index));
      }
    } finally { submittingRef.current = false; setSubmitting(false); }
  };
  const stop = async () => {
    if (!projectId || stopping) return;
    setStopping(true);
    try { await cancelRun(projectId); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); setStopping(false); }
  };
  const hasJournal = transcript.length > 0 || activity.length > 0 || !!lastOutcome;
  return <div className="project-session" data-result={hasResult} data-phase={activeQuestion ? "question" : working ? "working" : hasResult ? "refinement" : "brief"}>
    {hasResult && project && <div className="result-stage"><StudioWorkbench projectId={project.id} /></div>}
    <section className="creative-dock" aria-label={hasResult ? "Refine your project" : "Create your project"}>
      {!hasResult && <div className="creation-heading">
        <span className="creation-context">{working ? "Your idea is taking shape" : project ? project.name : "A workspace for web experiences"}</span>
        <h1>{activeQuestion ? "A decision for you." : working ? presentation.title : hasJournal ? "Keep shaping your idea." : "What will you create?"}</h1>
        {!working && !hasJournal && <p>Describe it. Bring references if you have them.<br />We’ll build, review, and refine it together.</p>}
      </div>}
      {(hasJournal || working || (projectId && !connected)) && <div className="work-status">
        <div role="status"><span className="status-symbol" aria-hidden="true">{presentation.symbol}</span><strong>{stopping ? "Stopping…" : presentation.title}</strong>
          {projectId && !connected && <span className="connection-note">Reconnecting · status may be out of date</span>}</div>
        <div className="status-actions">{hasResult && <button aria-expanded={journalOpen} aria-controls="run-journal" onClick={() => setJournalOpen(!journalOpen)}>{journalOpen ? "Close journal" : "Work journal"} {journalOpen ? "−" : "+"}</button>}
          {working && <button onClick={stop} disabled={stopping}>■ {stopping ? "Stopping" : "Stop"}</button>}</div>
      </div>}
      {projectId && (hasJournal || loadingTranscript || transcriptError) && (!hasResult || journalOpen) && <div id="run-journal" className="journal-region">
        {loadingTranscript && <p role="status">Loading the conversation…</p>}
        {transcriptError && <p role="alert">Could not load the conversation. <button onClick={loadTranscript}>Retry</button></p>}
        <RunJournal projectId={projectId} working={working} />
      </div>}
      {projectId && activeQuestion && <QuestionCard key={activeQuestion.questionId} projectId={projectId} />}
      {error && <RecoveryNotice error={error} onSettings={onSettings} onDismiss={() => setError(null)} />}
      {projectId && files.error && <p role="alert" className="inline-error">Could not load the saved result. <button onClick={() => files.refetch()}>Retry</button></p>}
      <BriefComposer draft={draft} onDraft={setDraft} images={images} onImages={setImages} submitting={submitting} working={working} hasResult={hasResult} onSubmit={submit}
        configuration={<ConfigBar project={project} initialModels={initialModels} onInitialModels={setInitialModels} />} />
      {!projectId && <button className="import-start" disabled={submitting} onClick={async () => {
        if (submittingRef.current) return;
        submittingRef.current = true; setSubmitting(true);
        try {
          const imported = await createProject("Imported project", "");
          useStudioStore.getState().setProjects([imported, ...useStudioStore.getState().projects]);
          navigate(`/projects/${imported.id}`, { state: { openImport: true } });
        } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
        finally { submittingRef.current = false; setSubmitting(false); }
      }}>Or bring an existing project →</button>}
      {projectId && !hasResult && !working && <details className="start-tools" open={location.state?.openImport || undefined}><summary>Or start from existing files</summary><ProjectTools projectId={projectId} /></details>}
      {lastOutcome && ["failed", "cancelled", "stuck"].includes(lastOutcome.status) && <button className="retry-instruction" onClick={() => {
        const previous = transcript.filter((item) => item.role === "user").slice(-1)[0];
        if (previous) { setDraft(previous.text); setImages(previous.images); document.getElementById("project-brief")?.focus(); }
      }}>Use the last instruction again</button>}
    </section>
  </div>;
}
