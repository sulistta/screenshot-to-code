import { fireEvent, render, screen } from "@testing-library/react";
import EffortPicker from "./EffortPicker";

const props = (overrides: Partial<React.ComponentProps<typeof EffortPicker>> = {}) => ({
  label: "Effort",
  value: "",
  efforts: ["none", "low", "medium", "high"],
  onChange: jest.fn(),
  ...overrides,
});

it("offers Default plus the supported levels and reports the choice", () => {
  const input = props();
  render(<EffortPicker {...input} />);
  expect(screen.getByRole("button", { name: "Effort: Default" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Effort: Default" }));
  fireEvent.click(screen.getByRole("button", { name: "High" }));
  expect(input.onChange).toHaveBeenCalledWith("high");
});

it("labels the canonical levels and marks the active one", () => {
  const input = props({ value: "xhigh", efforts: ["low", "medium", "high", "xhigh"] });
  render(<EffortPicker {...input} />);
  expect(screen.getByRole("button", { name: "Effort: Extra high" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Effort: Extra high" }));
  fireEvent.click(screen.getByRole("button", { name: "Low" }));
  expect(input.onChange).toHaveBeenCalledWith("low");
});

it("still offers the provider default when the model has no effort levels", () => {
  const input = props({ efforts: [] });
  render(<EffortPicker {...input} />);
  fireEvent.click(screen.getByRole("button", { name: "Effort: Default" }));
  expect(screen.getByRole("button", { name: "Default" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Default" }));
  expect(input.onChange).toHaveBeenCalledWith("");
});
