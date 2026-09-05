import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useStudioStore } from "@/store/studio-store";

export function QuestionCard({ send }: { send: (payload: Record<string, unknown>) => Promise<void> }) {
  const { activeQuestion, handleEvent, setError } = useStudioStore();
  const [answer, setAnswer] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  if (!activeQuestion) return null;

  const submit = async (value: string) => {
    if (!value.trim()) return;
    try {
      await send({
        type: "answer",
        answer: value,
        questionId: activeQuestion.questionId,
      });
      handleEvent({ type: "run_status", status: "running" });
      setAnswer("");
      setSelected(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const options = activeQuestion.options ?? [];
  const showCards = options.length > 0;

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
      {showCards && (
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2.5" role="radiogroup" aria-label="Choose a direction">
          {options.map((option) => {
            const active = selected === option;
            return (
              <button
                key={option}
                role="radio"
                aria-checked={active}
                onClick={() => { setSelected(option); void submit(option); }}
                className={`text-left rounded-xl border p-3.5 bg-white dark:bg-zinc-900 transition-colors ${active ? "border-stone-900 dark:border-white" : "border-stone-200 dark:border-zinc-700 hover:border-stone-400"}`}
              >
                <span className="flex items-center gap-2 text-[12.5px] font-medium">
                  <span className={`w-3.5 h-3.5 rounded-full border ${active ? "border-[5px] border-stone-900 dark:border-white" : "border-stone-300 dark:border-zinc-600"}`} />
                  <span className="break-words">{option}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
      <p className="mt-4 text-[12px] text-stone-500">Or share additional context (optional)</p>
      <div className="mt-2 flex gap-1.5">
        <Input
          value={answer}
          onChange={(event) => { setAnswer(event.target.value); setSelected(null); }}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit(answer);
          }}
          placeholder="Add your thoughts, references, or any other direction…"
          className="h-10 text-[13px] bg-white dark:bg-zinc-900 rounded-[10px]"
        />
        <Button size="sm" className="h-10 px-4 rounded-[10px] bg-stone-900 hover:bg-black dark:bg-white dark:text-black" onClick={() => submit(answer || selected || "")}>
          Reply
        </Button>
      </div>
      <p className="mt-2 text-[11px] text-stone-400">Choose one of the suggestions, or write your own answer.</p>
    </div>
  );
}

export default QuestionCard;
