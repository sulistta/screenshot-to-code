import { useState } from "react";
import { useStudioStore } from "@/store/studio-store";
import { answerQuestion } from "@/lib/studioApi";

export default function QuestionCard({ projectId }: { projectId: string }) {
  const question = useStudioStore((state) => state.activeQuestion);
  const [answer, setAnswer] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  if (!question) return null;
  const submit = async (value: string) => {
    if (!value.trim() || sending) return;
    setSending(true); setError("");
    try {
      await answerQuestion(projectId, question.questionId, value.trim());
      // A successful response is an authoritative acknowledgement of delivery.
      const state = useStudioStore.getState();
      if (state.activeProjectId === projectId && state.activeQuestion?.questionId === question.questionId) {
        state.handleEvent({ type: "run_status", projectId, status: "running" });
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); setSending(false); }
  };
  return <section className="question-surface" aria-labelledby="question-title">
    <div className="question-label" role="status">Your input is needed</div>
    <h2 id="question-title">{question.question}</h2>
    <p>Choose a direction, or write your own answer to continue.</p>
    <div className="question-options">{question.options?.map((option, index) => <button key={option} disabled={sending} onClick={() => void submit(option)}><span aria-hidden="true">{index + 1}</span>{option}</button>)}</div>
    <form className="question-answer" onSubmit={(event) => { event.preventDefault(); void submit(answer); }}>
      <input aria-label="Your answer" value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="Your own direction…" disabled={sending} />
      <button className="primary-action" disabled={sending || !answer.trim()}>{sending ? "Sending…" : "Answer"}</button>
    </form>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}
