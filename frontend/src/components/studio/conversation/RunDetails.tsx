import { useQuery } from "@tanstack/react-query";
import { useStudioStore } from "@/store/studio-store";
import { getServicesStatus } from "@/lib/studioApi";
import ActivityItem from "./ActivityItem";

export default function RunDetails({ projectId, isApp }: { projectId: string; isApp: boolean }) {
  const { completedRuns, currentRunId, runStatus, activity, team } = useStudioStore();
  const working = runStatus === "running" || runStatus === "waiting_for_user";
  const runs = [...completedRuns];
  if (currentRunId && working) runs.push({ runId: currentRunId, status: runStatus, activity, team, filesChanged: [] });
  const services = useQuery({ queryKey: ["services", projectId], queryFn: () => getServicesStatus(projectId), enabled: isApp, refetchInterval: isApp ? 1500 : false });
  return <div className="run-details">
    {runs.length === 0 && <p className="text-sm text-stone-500">Your run details will appear here when work starts.</p>}
    {runs.slice().reverse().map((run, index) => <details key={run.runId} open={index === 0} className="run-detail">
      <summary><span>Run {runs.length - index}</span><span>{run.status.replace(/_/g, " ")}</span></summary>
      {Object.values(run.team).map((agent) => <div key={agent.agentId} className="agent-detail">
        <strong>{agent.name}</strong><span>{agent.status}</span>
        <p>{agent.summary || agent.currentAction || agent.objective}</p>
        {agent.files.length > 0 && <p className="text-xs">{agent.files.join(", ")}</p>}
        {agent.error && <p role="alert">{agent.error}</p>}
      </div>)}
      {run.filesChanged.length > 0 && <details><summary>Changed files · {run.filesChanged.length}</summary><ul>{run.filesChanged.map((file) => <li key={file}><code>{file}</code></li>)}</ul></details>}
      {run.activity.length > 0 && <details><summary>Activity · {run.activity.length}</summary><div className="space-y-2 py-3">{run.activity.map((item) => <ActivityItem key={item.id} item={item} />)}</div></details>}
    </details>)}
    {isApp && <details className="run-detail"><summary>App logs</summary>
      {services.isLoading ? <p role="status">Loading logs…</p> : services.error ? <p role="alert">Could not load logs. <button onClick={() => services.refetch()}>Retry</button></p> : <>
        <p className="text-sm">{services.data?.state}</p>
        {services.data?.error && <p role="alert">{services.data.error}</p>}
        {services.data?.services.map((service) => <div key={service.name}><h3>{service.name}</h3><pre>{service.logs.join("\n") || "No logs yet."}</pre></div>)}
      </>}
    </details>}
  </div>;
}
