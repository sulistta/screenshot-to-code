import { act, fireEvent, render, screen } from "@testing-library/react";
import Composer from "./Composer";
import { DEFAULT_SETTINGS } from "@/lib/defaultSettings";

jest.mock("./ModelPicker", () => ({ __esModule: true, default: () => null }));
const props = () => ({ value: "An idea", onChange: jest.fn(), onSubmit: jest.fn(), settings: DEFAULT_SETTINGS,
  primary: "", subagent: "", onModelsChange: jest.fn(), images: [], onFiles: jest.fn(), onRemove: jest.fn() });

it("sends on Enter, but not Shift+Enter or IME composition", () => {
  const input = props(); render(<Composer {...input} />);
  const text = screen.getByRole("textbox");
  fireEvent.keyDown(text, { key: "Enter", shiftKey: true });
  fireEvent.keyDown(text, { key: "Enter", isComposing: true });
  expect(input.onSubmit).not.toHaveBeenCalled();
  fireEvent.keyDown(text, { key: "Enter" });
  expect(input.onSubmit).toHaveBeenCalledTimes(1);
});
it("allows preparing a draft during a run without submitting it", () => {
  const input = props(); const stop = jest.fn();
  render(<Composer {...input} working onStop={stop} />);
  expect(screen.getByRole("textbox")).toBeEnabled();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Next" } });
  expect(input.onChange).toHaveBeenCalledWith("Next");
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect(input.onSubmit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText("Stop generation")); expect(stop).toHaveBeenCalledTimes(1);
});
it("accepts references through paste and drop with a single attachment control", () => {
  const input = props(); const { container } = render(<Composer {...input} />);
  const file = new File(["image"], "ref.png", { type: "image/png" });
  fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { files: [file] } });
  fireEvent.drop(container.firstChild!, { dataTransfer: { files: [file] } });
  expect(input.onFiles).toHaveBeenCalledTimes(2);
  expect(screen.getAllByRole("button", { name: "Attach reference images" })).toHaveLength(1);
});
it("rotates examples only while empty and unfocused", () => {
  jest.useFakeTimers();
  render(<Composer {...props()} value="" isNew />);
  expect(screen.getByText(/Try: A SaaS/)).toBeInTheDocument();
  act(() => jest.advanceTimersByTime(6000));
  expect(screen.getByText(/Try: An interactive/)).toBeInTheDocument();
  fireEvent.focus(screen.getByRole("textbox"));
  act(() => jest.advanceTimersByTime(12000));
  fireEvent.blur(screen.getByRole("textbox"));
  expect(screen.getByText(/Try: An interactive/)).toBeInTheDocument();
  jest.useRealTimers();
});
