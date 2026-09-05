import { useStudioStore } from "@/store/studio-store";
import RunHandoff from "./RunHandoff";
import TeamPanel from "./TeamPanel";

export default function RunJournal({ projectId, working }: { projectId: string; working: boolean }) {
  const transcript = useStudioStore((state) => state.transcript);
  const activity = useStudioStore((state) => state.activity);
  const config = useStudioStore((state) => state.currentRunConfig);
  const messages = activity.filter((item) => item.kind === "assistant" && !item.agentId);
  const tools = activity.filter((item) => item.kind === "tool");
  return <div className="run-journal">
    {transcript.length > 2 && <details className="earlier-conversation"><summary>Earlier conversation · {transcript.length - 2} messages</summary>{transcript.slice(0, -2).map((message, index) => <article className="journal-message" key={index}><h3>{message.role === "user" ? "Your instruction" : "Response"}</h3><p>{message.text}</p>{message.images.map((image, i) => <img className="journal-reference" key={i} src={image} alt={`Reference ${i + 1}`} />)}</article>)}</details>}
    {transcript.slice(-2).map((message, index) => <article className={`journal-message ${message.role}`} key={`${message.runId}:${index}`}><h3>{message.role === "user" ? "Your instruction" : "What changed"}</h3><p>{message.text}</p>{message.images.map((image, i) => <img className="journal-reference" key={i} src={image} alt={`Reference ${i + 1}`} />)}</article>)}
    {messages.map((item) => <article className="journal-message assistant" key={item.id}><p>{item.text}</p></article>)}
    <TeamPanel working={working} />
    <RunHandoff key={useStudioStore((state) => state.lastOutcome?.runId) ?? "pending"} projectId={projectId} />
    {(tools.length > 0 || config) && <details className="technical-details"><summary>Execution details{tools.length ? ` · ${tools.length} tool calls` : ""}</summary>
      {config && <p>Primary: {config.primary_model} · Specialists: {config.subagent_model || config.primary_model}</p>}
      {tools.slice(-100).map((item) => <details key={item.id}><summary><span>{item.ok === false ? "Failed" : item.ok === true ? "Finished" : "Running"}</span> · {item.toolName}</summary><p>{item.toolDetail}</p><pre>{item.text || "Awaiting tool result."}</pre></details>)}
      {tools.length > 100 && <p>Showing the most recent 100 calls. Full run records are available in Advanced evaluations.</p>}
    </details>}
  </div>;
}
