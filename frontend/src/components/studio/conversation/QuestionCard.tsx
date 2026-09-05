import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useStudioStore } from "@/store/studio-store";

export function QuestionCard({ send }: { send: (payload: Record<string, unknown>) => void }) {
  const { activeQuestion, handleEvent, setError } = useStudioStore();
  const [answer, setAnswer] = useState("");
  if (!activeQuestion) return null;

  const submit = (value: string) => {
    if (!value.trim()) return;
    try {
      send({
        type: "answer",
        answer: value,
        questionId: activeQuestion.questionId,
      });
      handleEvent({ type: "run_status", status: "running" });
      setAnswer("");
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/[0.06] p-3 space-y-2.5">
      <div className="text-sm font-medium">{activeQuestion.question}</div>
      <p className="text-xs text-muted-foreground">Choose one of the four suggestions, or write your own answer.</p>
      {activeQuestion.options && activeQuestion.options.length > 0 && (
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {activeQuestion.options.map((option) => (
            <Button
              key={option}
              size="sm"
              variant="outline"
              className="h-auto min-h-9 justify-start whitespace-normal text-left text-xs"
              onClick={() => submit(option)}
            >
              {option}
            </Button>
          ))}
        </div>
      )}
      <div className="flex gap-1.5">
        <Input
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit(answer);
          }}
          placeholder="Other answer (optional)"
          className="h-8 text-sm"
        />
        <Button size="sm" className="h-8" onClick={() => submit(answer)}>
          Reply
        </Button>
      </div>
    </div>
  );
}

export default QuestionCard;
