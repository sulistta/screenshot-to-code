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
      currentRunId: null,
      eventCursor: null,
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

  it("ignores a replayed stream and late events from another project", () => {
    const { handleEvent } = useStudioStore.getState();
    const delta = {
      type: "assistant_delta" as const, projectId: "p1", runId: "r1",
      streamId: "s1", sequence: 1, text: "Once",
    };
    handleEvent(delta);
    handleEvent(delta);
    handleEvent({ ...delta, projectId: "p2", sequence: 2, text: "Wrong" });
    expect(useStudioStore.getState().activity[0].text).toBe("Once");
    handleEvent({ ...delta, streamId: "s2", text: "Again" });
    expect(useStudioStore.getState().activity[0].text).toBe("OnceAgain");
  });

  it("matches out-of-order tool results by call ID", () => {
    const { handleEvent } = useStudioStore.getState();
    handleEvent({ type: "tool_start", eventId: "a", name: "read_file" });
    handleEvent({ type: "tool_start", eventId: "b", name: "create_file" });
    handleEvent({ type: "tool_result", eventId: "a", ok: false });
    handleEvent({ type: "tool_result", eventId: "b", ok: true });
    expect(useStudioStore.getState().activity.map((item) => item.ok)).toEqual([false, true]);
  });

  it("keeps live messages when an older transcript request finishes", () => {
    const { handleEvent, setTranscript } = useStudioStore.getState();
    handleEvent({ type: "user_message", runId: "r1", text: "Build", images: [] });
    handleEvent({ type: "user_message", runId: "r1", text: "Build", images: [] });
    handleEvent({ type: "run_status", runId: "r1", status: "failed",
      message: "Could not save", error: "Disk full" });
    setTranscript([]);
    expect(useStudioStore.getState().transcript.map((message) => message.text))
      .toEqual(["Build", "Could not save"]);
    expect(useStudioStore.getState().error).toBe("Disk full");
  });

  it("does not finalize a waiting run or clear its activity", () => {
    const { handleEvent } = useStudioStore.getState();
    handleEvent({ type: "assistant_delta", text: "Question" });
    handleEvent({ type: "run_status", status: "waiting_for_user" });
    expect(useStudioStore.getState().lastOutcome).toBeNull();
    expect(useStudioStore.getState().activity).toHaveLength(1);
  });

  it("tracks the team lifecycle with identity and states", () => {
    const { handleEvent } = useStudioStore.getState();
    handleEvent({ type: "agent_status", agentId: "coordinator", name: "Nora", role: "coordinator", status: "working", objective: "Build it" });
    handleEvent({ type: "agent_status", agentId: "agent-1", name: "Theo", role: "backend", status: "queued", objective: "Build API", filePaths: ["api.py"] });
    handleEvent({ type: "agent_status", agentId: "agent-1", name: "Theo", role: "backend", status: "working" });
    const { team } = useStudioStore.getState();
    expect(team["coordinator"]).toMatchObject({ name: "Nora", status: "working" });
    expect(team["agent-1"]).toMatchObject({ name: "Theo", status: "working", objective: "Build API" });
    handleEvent({ type: "agent_status", agentId: "agent-1", name: "Theo", role: "backend", status: "completed", summary: "API built" });
    expect(useStudioStore.getState().team["agent-1"]).toMatchObject({
      status: "completed", summary: "API built",
    });
  });

  it("attributes specialist tool events to the agent, not the coordinator", () => {
    const { handleEvent } = useStudioStore.getState();
    handleEvent({ type: "agent_status", agentId: "agent-1", name: "Theo", role: "backend", status: "working" });
    handleEvent({ type: "tool_start", agentId: "agent-1", tool: "create_file", input: { path: "api.py" } });
    handleEvent({ type: "tool_result", agentId: "agent-1", tool: "create_file", ok: true, input: { path: "api.py" } });
    const state = useStudioStore.getState();
    // Specialist actions never land in the coordinator's activity list.
    expect(state.activity).toHaveLength(0);
    expect(state.team["agent-1"].files).toEqual(["api.py"]);
    expect(state.team["agent-1"].currentAction).toBe("Created api.py");
  });

  it("resets the run views when a new coordinator starts", () => {
    const { handleEvent } = useStudioStore.getState();
    handleEvent({ type: "agent_status", agentId: "coordinator", name: "Nora", role: "coordinator", status: "working" });
    handleEvent({ type: "assistant_delta", text: "leftover" });
    handleEvent({ type: "agent_status", agentId: "coordinator", name: "Nora", role: "coordinator", status: "completed" });
    handleEvent({ type: "agent_status", agentId: "coordinator", name: "Nora", role: "coordinator", status: "working", objective: "next run" });
    const state = useStudioStore.getState();
    expect(state.activity).toHaveLength(0);
    expect(state.team["coordinator"].objective).toBe("next run");
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
