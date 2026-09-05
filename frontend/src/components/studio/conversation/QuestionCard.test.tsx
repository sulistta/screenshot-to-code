import { render, screen, fireEvent, act } from "@testing-library/react";
import { QuestionCard } from "./QuestionCard";
import { useStudioStore } from "@/store/studio-store";

const QUESTION = {
  questionId: "q1",
  question: "Which direction?",
  options: ["Calm", "Bold", "Playful"],
};

function setup(send: (payload: Record<string, unknown>) => Promise<void> = async () => undefined) {
  useStudioStore.setState({
    activeQuestion: { ...QUESTION },
    runStatus: "waiting_for_user",
  } as Partial<ReturnType<typeof useStudioStore.getState>>);
  return render(<QuestionCard send={send} />);
}

describe("QuestionCard", () => {
  beforeEach(() => {
    useStudioStore.setState({ activeQuestion: null, runStatus: null, error: null });
  });

  it("renders every option, not a subset", () => {
    setup();
    for (const option of QUESTION.options) {
      expect(screen.getByRole("button", { name: option })).toBeInTheDocument();
    }
  });

  it("sends an option exactly once even on double click", async () => {
    const send = jest.fn(async () => undefined);
    setup(send);
    const calm = screen.getByRole("button", { name: "Calm" });
    await act(async () => {
      fireEvent.click(calm);
      fireEvent.click(calm);
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: "answer", answer: "Calm", questionId: "q1" });
  });

  it("blocks the form while submitting and keeps the typed answer on failure", async () => {
    let reject!: (error: Error) => void;
    const send = jest.fn(() => new Promise<void>((_, rej) => { reject = rej; }));
    setup(send);
    const input = screen.getByPlaceholderText(/references/i);
    fireEvent.change(input, { target: { value: "My take" } });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    expect(screen.getByRole("button", { name: /sending/i })).toBeDisabled();
    await act(async () => {
      reject(new Error("offline"));
    });
    // The answer is preserved for a retry.
    expect(screen.getByPlaceholderText(/references/i)).toHaveValue("My take");
    expect(screen.getByRole("button", { name: "Reply" })).not.toBeDisabled();
    expect(useStudioStore.getState().error).toBe("offline");
  });
});
