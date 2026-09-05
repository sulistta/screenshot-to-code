import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useStudioStore } from "@/store/studio-store";

export function QuestionCard({ send }: { send: (payload: Record<string, unknown>) => Promise<void> }) {
  const { activeQuestion, handleEvent, setError } = useStudioStore();
  const [answer, setAnswer] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const questionId = activeQuestion?.questionId ?? null;
  useEffect(() => {
    setAnswer("");
    inFlight.current = false;
    setSubmitting(false);
  }, [questionId]);
  if (!activeQuestion) return null;

  const submit = async (value: string) => {
    if (!value.trim() || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    try {
      await send({
        type: "answer",
        answer: value,
        questionId: activeQuestion.questionId,
      });
      handleEvent({ type: "run_status", status: "running" });
      setAnswer("");
    } catch (error) {
      // Keep the typed answer so a failed send can be retried without retyping.
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  const options = activeQuestion.options ?? [];

  return (
    <div className="forge-card p-5 sm:p-6 bg-orange-50/50 dark:bg-orange-950/20">
      <div className="flex items-start justify-between gap-3">
        <span className="grid place-items-center w-9 h-9 rounded-full bg-orange-100 text-orange-600 shrink-0">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.4" /><path d="M8 7.2v3M8 5.2v.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </span>
        <span className="forge-status amber">CLARIFICATION REQUIRED</span>
      </div>
      <h2 className="mt-4 text-[22px] sm:text-[26px] font-bold tracking-tight text-stone-900 dark:text-zinc-50">We need your input to continue</h2>
      <p className="mt-1.5 text-[13.5px] text-stone-500 dark:text-zinc-400 leading-relaxed">{activeQuestion.question}</p>
      {options.length > 0 && (
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2.5" role="group" aria-label="Suggested answers">
          {options.map((option) => (
            <button
              key={option}
              disabled={submitting}
              onClick={() => void submit(option)}
              className="text-left rounded-xl border p-3.5 bg-white dark:bg-zinc-900 transition-colors border-stone-200 dark:border-zinc-700 hover:border-stone-400 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span className="text-[12.5px] font-medium break-words">{option}</span>
            </button>
          ))}
        </div>
      )}
      <p className="mt-4 text-[12px] text-stone-500">Or share additional context (optional)</p>
      <div className="mt-2 flex gap-1.5">
        <Input
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit(answer);
          }}
          placeholder="Add your thoughts, references, or any other direction…"
          disabled={submitting}
          className="h-10 text-[13px] bg-white dark:bg-zinc-900 rounded-[10px]"
        />
        <Button size="sm" className="h-10 px-4 rounded-[10px] bg-stone-900 hover:bg-black dark:bg-white dark:text-black" disabled={submitting || !answer.trim()} onClick={() => void submit(answer)}>
          {submitting ? "Sending…" : "Reply"}
        </Button>
      </div>
      <p className="mt-2 text-[11px] text-stone-400">Choose one of the suggestions, or write your own answer. Each answer is sent once.</p>
    </div>
  );
}

export default QuestionCard;
