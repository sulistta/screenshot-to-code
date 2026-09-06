import { streamBatch } from "./streamBatch";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
it("coalesces bursts without losing text and flushes before terminal events", () => {
  const deliver = jest.fn();
  const batch = streamBatch(deliver);
  for (let sequence = 1; sequence <= 1000; sequence++) batch.push({ type: "thinking_delta", text: "x", sequence, streamId: "p", runId: "r" });
  expect(deliver).not.toHaveBeenCalled();
  jest.advanceTimersByTime(50);
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(deliver.mock.calls[0][0]).toMatchObject({ text: "x".repeat(1000), sequence: 1000 });
  batch.push({ type: "assistant_delta", text: "Done" });
  batch.push({ type: "run_status", status: "completed" });
  expect(deliver.mock.calls.slice(1).map(([event]) => event.type)).toEqual(["assistant_delta", "run_status"]);
});
it("preserves agent boundaries and discards disposed subscription buffers", () => {
  const deliver = jest.fn();
  const batch = streamBatch(deliver);
  batch.push({ type: "thinking_delta", text: "Main" });
  batch.push({ type: "thinking_delta", text: "Agent", agentId: "a" });
  expect(deliver.mock.calls[0][0].text).toBe("Main");
  batch.dispose();
  jest.runAllTimers();
  expect(deliver).toHaveBeenCalledTimes(1);
});
