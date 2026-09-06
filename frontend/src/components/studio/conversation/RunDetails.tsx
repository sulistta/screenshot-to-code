import { useShallow } from "zustand/react/shallow";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useStudioStore } from "@/store/studio-store";
import { getServicesStatus } from "@/lib/studioApi";
import ActivityItem from "./ActivityItem";

export default function RunDetails({ projectId, isApp, visible }: { projectId: string; isApp: boolean; visible: boolean }) {
  const { completedRuns, currentRunId, runStatus, activity, team } = useStudioStore(useShallow((s) => ({ completedRuns: s.completedRuns, currentRunId: s.currentRunId, runStatus: s.runStatus, activity: s.activity, team: s.team })));
  const [selected, setSelected] = useState("all");
  const [follow, setFollow] = useState(true);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => { if (visible && follow && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [activity, team, follow, visible]);
  const working = runStatus === "running" || runStatus === "waiting_for_user";
  const runs = [...completedRuns];
  if (currentRunId && working) runs.push({ runId: currentRunId, status: runStatus, activity, team, filesChanged: [] });
  const services = useQuery({ queryKey: ["services", projectId], queryFn: () => getServicesStatus(projectId), enabled: isApp && visible, refetchInterval: isApp && visible ? 1500 : false });
  const agents = Object.values(team);
  if (!visible) return null;
  return <section className="agent-workspace" aria-label="Parallel agent activity">
    <header className="agent-panel-heading"><h2>Team workspace</h2><p>Follow the work as it happens.</p></header>
    <div className="agent-filters" role="group" aria-label="Filter agents">
      <button aria-pressed={selected === "all"} onClick={() => setSelected("all")}>Everyone</button>
      <button aria-pressed={selected === "coordinator"} onClick={() => setSelected("coordinator")}>Coordinator</button>
      {agents.filter((agent) => agent.agentId !== "coordinator").map((agent) => <button key={agent.agentId} aria-pressed={selected === agent.agentId} onClick={() => setSelected(agent.agentId)}>{agent.name}</button>)}
    </div>
    <div className="run-details" ref={scroll} onScroll={() => { const node = scroll.current; if (node) setFollow(node.scrollHeight - node.scrollTop - node.clientHeight < 64); }}>

    {runs.length === 0 && <p className="text-sm text-stone-500">Your run details will appear here when work starts.</p>}
    {runs.map((run, index) => <details key={run.runId} open={index === runs.length - 1} className="run-detail">
      <summary><span>Run {index + 1}</span><span>{run.status.replace(/_/g, " ")}</span></summary>
      {Object.values(run.team).filter((agent) => selected === "all" || agent.agentId === selected).map((agent) => <div key={agent.agentId} className="agent-detail">
        <strong>{agent.name}</strong><span>{agent.status}</span>
        <p>{agent.summary || agent.currentAction || agent.objective}</p>
        {agent.files.length > 0 && <p className="text-xs">{agent.files.join(", ")}</p>}
        {agent.error && <p role="alert">{agent.error}</p>}
      </div>)}
      {run.filesChanged.length > 0 && <details><summary>Changed files · {run.filesChanged.length}</summary><ul>{run.filesChanged.map((file) => <li key={file}><code>{file}</code></li>)}</ul></details>}
      <div className="agent-chat">{run.activity.filter((item) => selected === "all" || (item.agentId || "coordinator") === selected).map((item) => <article className={`agent-chat-entry kind-${item.kind}`} key={item.id}><header>{item.agentName || "Coordinator"}<span>{item.kind === "thinking" ? "Thinking" : item.kind === "tool" ? "Action" : ""}</span></header><ActivityItem item={item} /></article>)}</div>
    </details>)}
    {isApp && <details className="run-detail"><summary>App logs</summary>
      {services.isLoading ? <p role="status">Loading logs…</p> : services.error ? <p role="alert">Could not load logs. <button onClick={() => services.refetch()}>Retry</button></p> : <>
        <p className="text-sm">{services.data?.state}</p>
        {services.data?.error && <p role="alert">{services.data.error}</p>}
        {services.data?.services.map((service) => <div key={service.name}><h3>{service.name}</h3><pre>{service.logs.join("\n") || "No logs yet."}</pre></div>)}
      </>}
    </details>}
  </div>
    {!follow && <button className="agent-follow" onClick={() => setFollow(true)}>Latest activity ↓</button>}
  </section>;
}
