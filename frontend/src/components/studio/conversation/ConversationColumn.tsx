import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStudioStore } from "@/store/studio-store";
import { cancelRun, startRun, updateProject } from "@/lib/studioApi";
import type { Settings } from "@/types";
import Composer from "../Composer";
import RunHandoff from "./RunHandoff";
import QuestionCard from "./QuestionCard";
import { useImageAttachments } from "@/hooks/useImageAttachments";
import { clearPendingPrompt, loadPendingPrompt } from "@/lib/pendingPrompt";
import { runSettings } from "@/lib/runSettings";
import { activityLabel } from "./activityLabel";

export function ConversationColumn({ projectId, settings, send, connected }: {
  projectId: string; settings: Settings;
  send: (payload: Record<string, unknown>) => Promise<void>; connected: boolean;
}) {
  const { transcript, activity, runStatus, handleEvent, setError, activeQuestion } = useStudioStore();
  const project = useStudioStore((s) => s.projects.find((p) => p.id === projectId));
  const [pending] = useState(() => loadPendingPrompt(projectId));
  const [draft, setDraft] = useState(() => sessionStorage.getItem(`conversation-draft:${projectId}`) || pending?.text || "");
  const { images, attachError, addFiles, removeAt, clear } = useImageAttachments(`attachments:${projectId}`);
  const [submitting, setSubmitting] = useState(false);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [newMessages, setNewMessages] = useState(false);
  const submitInFlight = useRef(false);
  const modelInFlight = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const working = runStatus === "running" || runStatus === "waiting_for_user";
  const liveReply = activity.filter((item) => item.kind === "assistant" && !item.agentId).map((item) => item.text).join("");
  const phase = activityLabel(runStatus, activity, connected);
  useEffect(() => {
    sessionStorage.setItem(`conversation-draft:${projectId}`, draft);
  }, [projectId, draft]);
  useEffect(() => { if (pending?.error) setError(pending.error); clearPendingPrompt(projectId); }, [projectId, pending, setError]);
  useLayoutEffect(() => {
    const viewport = scroll.current;
    if (!viewport) return;
    const saved = sessionStorage.getItem(`conversation-scroll:${projectId}`);
    if (saved !== null) {
      viewport.scrollTop = Number(saved);
      follow.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 64;
    }
  }, [projectId]);
  useLayoutEffect(() => {
    const viewport = scroll.current;
    if (!viewport) return;
    if (follow.current) viewport.scrollTop = viewport.scrollHeight;
    else setNewMessages(true);
  }, [transcript, liveReply]);
  useEffect(() => {
    const target = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId: string; selector: string; text: string }>).detail;
      if (detail.projectId === projectId) setDraft((current) => `${current}${current ? "\n\n" : ""}Update element ${detail.selector} (${detail.text}): `);
    };
    window.addEventListener("studio:target", target);
    return () => window.removeEventListener("studio:target", target);
  }, [projectId]);
  const submit = async () => {
    const text = draft.trim();
    if ((!text && images.length === 0) || working || submitInFlight.current || modelInFlight.current) return;
    submitInFlight.current = true;
    setSubmitting(true);
    try {
      const runId = await startRun(projectId, text, runSettings(settings, project?.primaryModel, project?.subagentModel), images);
      if (useStudioStore.getState().activeProjectId !== projectId) return;
      handleEvent({ type: "user_message", projectId, runId, text, images });
      setDraft("");
      clear();
      follow.current = true;
    } catch (error) {
      if (useStudioStore.getState().activeProjectId === projectId) setError(error instanceof Error ? error.message : String(error));
    } finally { submitInFlight.current = false; setSubmitting(false); }
  };
  const saveModels = async (patch: { primaryModel?: string; subagentModel?: string }) => {
    if (working || modelInFlight.current) return;
    modelInFlight.current = true;
    setModelsBusy(true);
    try { useStudioStore.getState().updateProject(await updateProject(projectId, patch)); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { modelInFlight.current = false; setModelsBusy(false); }
  };
  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    try { await cancelRun(projectId); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setStopping(false); }
  };
  return <div className="conversation-column">
    <div className="conversation-scroll" ref={scroll} onScroll={() => {
      const viewport = scroll.current!;
      follow.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 64;
      if (follow.current) setNewMessages(false);
      sessionStorage.setItem(`conversation-scroll:${projectId}`, String(viewport.scrollTop));
    }}>
      {!transcript.length && !liveReply && <div className="conversation-empty"><h2>Let’s make it yours.</h2><p>Share an idea or a reference. Forge will ask when it needs your direction.</p></div>}
      {transcript.map((message, index) => <article key={`${message.runId ?? index}:${message.role}`} className={`conversation-message message-${message.role}`}>
        {message.images.length > 0 && <div className="message-images">{message.images.map((image, i) => <img src={image} key={i} alt={`Reference ${i + 1}`} />)}</div>}
        {message.text && <div>{message.text}</div>}
      </article>)}
      {liveReply && <article className="conversation-message message-assistant">{liveReply}</article>}
      <RunHandoff projectId={projectId} />
    </div>
    {newMessages && <button className="new-messages" onClick={() => { follow.current = true; scroll.current?.scrollTo({ top: scroll.current.scrollHeight }); setNewMessages(false); }}>New messages ↓</button>}
    <div className="conversation-bottom">
      <div className="run-indicator" role="status" aria-live="polite"><span className={working ? "run-dot working" : "run-dot"} aria-hidden="true" /><span key={phase}>{phase}</span></div>
      {activeQuestion && <QuestionCard send={send} />}
      <Composer value={draft} onChange={setDraft} onSubmit={() => void submit()} settings={settings}
        primary={project?.primaryModel ?? ""} subagent={project?.subagentModel ?? ""} onModelsChange={(patch) => void saveModels(patch)}
        images={images} onFiles={addFiles} onRemove={removeAt} error={attachError} busy={submitting} working={working}
        modelsBusy={modelsBusy} onStop={() => void stop()} stopping={stopping} />
    </div>
  </div>;
}
export default ConversationColumn;
