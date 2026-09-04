import { useStudioStore } from "./studio-store";

describe("studio store event handling", () => {
  beforeEach(() => {
    useStudioStore.setState({
      projects: [],
      activeProjectId: "p1",
      transcript: [],
      activity: [],
      previewContent: null,
      previewNonce: 0,
      runStatus: null,
      activeQuestion: null,
      error: null,
      iterations: [],
      lastOutcome: null,
      currentRunConfig: null,
      settings: null,
    });
  });

  it("accumulates assistant deltas into one activity item", () => {
    const { handleEvent } = useStudioStore.getState();
    handleEvent({ type: "assistant_delta", text: "Hello " });
    handleEvent({ type: "assistant_delta", text: "world." });
    const { activity } = useStudioStore.getState();
    expect(activity).toHaveLength(1);
    expect(activity[0].text).toBe("Hello world.");
  });

  it("records the completed outcome with iteration and files", () => {
    const { handleEvent } = useStudioStore.getState();
    handleEvent({
      type: "run_status",
      status: "running",
      config: {
        primary_model: "gpt-5.5 (no thinking)",
        subagent_model: "",
        execution_mode: "single",
      },
    });
    handleEvent({ type: "assistant_delta", text: "Built it." });
    handleEvent({
      type: "run_status",
      status: "completed",
      iterationId: "i001",
      filesChanged: ["index.html"],
    });
    const state = useStudioStore.getState();
    expect(state.runStatus).toBe("completed");
    expect(state.lastOutcome).toMatchObject({
      status: "completed",
      iterationId: "i001",
      filesChanged: ["index.html"],
    });
    // The live activity becomes the transcript's assistant reply.
    expect(state.transcript).toHaveLength(1);
    expect(state.transcript[0]).toMatchObject({
      role: "assistant",
      text: "Built it.",
    });
    expect(state.activity).toHaveLength(0);
    // The preview refreshes on completion.
    expect(state.previewNonce).toBe(1);
  });

  it("shows the question and clears it when answering", () => {
    const { handleEvent } = useStudioStore.getState();
    handleEvent({
      type: "question",
      questionId: "q1",
      question: "Calm or bold?",
      options: ["Calm", "Bold"],
    });
    expect(useStudioStore.getState().activeQuestion).toMatchObject({
      questionId: "q1",
      question: "Calm or bold?",
    });
    expect(useStudioStore.getState().runStatus).toBe("waiting_for_user");

    // Answering via the transport path clears the card optimistically.
    handleEvent({ type: "run_status", status: "running" });
    expect(useStudioStore.getState().activeQuestion).toBeNull();
    expect(useStudioStore.getState().runStatus).toBe("running");
  });

  it("tracks set_code previews", () => {
    const { handleEvent } = useStudioStore.getState();
    handleEvent({ type: "set_code", content: "<html>x</html>", source: "tool_result" });
    expect(useStudioStore.getState().previewContent).toBe("<html>x</html>");
  });
});

it("does not duplicate the reply when the terminal event replays", () => {
  const { handleEvent } = useStudioStore.getState();
  handleEvent({ type: "assistant_delta", text: "Built it." });
  const completed = {
    type: "run_status" as const,
    status: "completed" as const,
    runId: "r1",
    iterationId: "i001",
    filesChanged: ["index.html"],
  };
  handleEvent(completed);
  handleEvent(completed); // replay (socket reconnect)
  handleEvent(completed);
  const { transcript } = useStudioStore.getState();
  expect(transcript.filter((m) => m.role === "assistant")).toHaveLength(1);
});
