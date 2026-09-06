import { useShallow } from "zustand/react/shallow";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useStudioStore } from "@/store/studio-store";

export function QuestionCard({ send }: { send: (payload: Record<string, unknown>) => Promise<void> }) {
  const { activeQuestion, handleEvent, setError } = useStudioStore(useShallow((s) => ({ activeQuestion: s.activeQuestion, handleEvent: s.handleEvent, setError: s.setError })));
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
    <div className="question-card">
      <p className="mt-1.5 text-[13.5px] text-stone-500 dark:text-zinc-400 leading-relaxed">{activeQuestion.question}</p>
      {options.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Suggested answers">
          {options.map((option) => (
            <button
              key={option}
              disabled={submitting}
              onClick={() => void submit(option)}
              className="text-left rounded-xl border px-3 py-2 bg-white dark:bg-zinc-900 transition-colors border-stone-200 dark:border-zinc-700 hover:border-stone-400 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span className="text-[12.5px] font-medium break-words">{option}</span>
            </button>
          ))}
        </div>
      )}
      <p className="mt-4 text-[12px] text-stone-500">Or write your own answer</p>
      <div className="mt-2 flex gap-1.5">
        <Input
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) void submit(answer);
          }}
          placeholder="Add your thoughts, references, or any other direction…"
          disabled={submitting}
          className="h-10 text-[13px] bg-white dark:bg-zinc-900 rounded-[10px]"
        />
        <Button size="sm" className="h-10 px-4 rounded-[10px] bg-stone-900 hover:bg-black dark:bg-white dark:text-black" disabled={submitting || !answer.trim()} onClick={() => void submit(answer)}>
          {submitting ? "Sending…" : "Reply"}
        </Button>
      </div>
    </div>
  );
}

export default QuestionCard;
