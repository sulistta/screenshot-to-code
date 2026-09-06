import { act, fireEvent, render, screen } from "@testing-library/react";
import ThinkingStream from "./ThinkingStream";
import { wrapThinking } from "./wrapThinking";
import { useStudioStore } from "@/store/studio-store";

beforeEach(() => {
  Element.prototype.scrollTo = jest.fn();
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  useStudioStore.setState({ activity: [], currentRunId: null, team: {} });
});
it("streams published thinking, pauses reading and catches up on resume", () => {
  render(<ThinkingStream />);
  expect(screen.queryByLabelText("Live thinking")).not.toBeInTheDocument();
  act(() => useStudioStore.getState().handleEvent({ type: "thinking_delta", text: "Inspecting the layout" }));
  expect(screen.getByText("Inspecting the layout")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  act(() => useStudioStore.getState().handleEvent({ type: "thinking_delta", text: " and files" }));
  expect(screen.queryByText(/and files/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Resume" }));
  expect(screen.getByText(/and files/)).toBeInTheDocument();
});

it("retains earlier thinking across event IDs, tools and agent switches", () => {
  render(<ThinkingStream />);
  const emit = useStudioStore.getState().handleEvent;
  act(() => emit({ type: "thinking_delta", eventId: "chunk-1", text: "First sentence. " }));
  const firstLine = screen.getByText("First sentence.");
  act(() => emit({ type: "thinking_delta", eventId: "chunk-2", text: "Second sentence." }));
  expect(screen.getByText("First sentence. Second sentence.")).toBe(firstLine);
  act(() => emit({ type: "tool_start", name: "read_file" }));
  act(() => emit({ type: "thinking_delta", eventId: "chunk-3", text: "After reading the file." }));
  act(() => emit({ type: "thinking_delta", agentId: "builder", text: "Building now." }));
  expect(screen.getByText(/First sentence.*After reading the file/)).toBe(firstLine);
  expect(screen.getByText("Building now.")).toBeInTheDocument();
});

it("fills the measured width and reflows without losing text", () => {
  const text = "Continuous thinking fills the available component width without isolated fragments.";
  const measure = (value: string) => value.length * 7;
  const narrow = wrapThinking(text, 140, measure);
  const wide = wrapThinking(text, 420, measure);
  expect(wide.length).toBeLessThan(narrow.length);
  expect(wide.join("")).toBe(text);
  expect(narrow.join("")).toBe(text);
  expect(wide.every((line) => measure(line.trimEnd()) <= 420)).toBe(true);
});

it("keeps the live DOM bounded for long reasoning", () => {
  useStudioStore.setState({ activity: [{ id: "long", kind: "thinking", text: "A readable line of reasoning.\n".repeat(5000) }] });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 700 });
  const { container } = render(<ThinkingStream />);
  expect(container.querySelectorAll(".thinking-line").length).toBeLessThanOrEqual(14);
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
});
it("never measures the entire reasoning history while finding a line", () => {
  let longest = 0;
  wrapThinking("word ".repeat(10000), 700, (text) => { longest = Math.max(longest, text.length); return text.length * 7; });
  expect(longest).toBeLessThanOrEqual(128);
});
