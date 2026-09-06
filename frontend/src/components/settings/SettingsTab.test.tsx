import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import SettingsTab from "./SettingsTab";
import { AppTheme } from "@/types";
import { DEFAULT_SETTINGS } from "@/lib/defaultSettings";

jest.mock("@/lib/native", () => ({ native: jest.fn(async (command: string) => command === "list_models" ? [{ value: "test:model", group: "Test" }] : { screenshot_preview: true }) }));
jest.mock("@/components/studio/ModelPicker", () => ({ __esModule: true, default: ({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) => <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}><option value="">Automatic</option><option value="test:model">Test model</option></select> }));
const meta = { status: "saved" as const, error: null, retry: jest.fn() };
function Harness() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [theme, setTheme] = useState(AppTheme.LIGHT);
  return <><SettingsTab settings={settings} setSettings={setSettings} settingsMeta={meta} appTheme={theme} setAppTheme={setTheme} appThemeMeta={meta} /><output data-testid="default">{settings.defaultPrimaryModel}</output></>;
}
it("shows the reference sections together and keeps credentials behind a row action", async () => {
  render(<Harness />);
  expect(await screen.findByText("Test", { selector: "td" })).toBeInTheDocument();
  for (const name of ["Providers", "Models", "Execution Defaults", "General"]) expect(screen.getByRole("heading", { name })).toBeInTheDocument();
  expect(screen.queryByPlaceholderText("OpenAI API key")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Configure OpenAI" }));
  expect(screen.getByPlaceholderText("OpenAI API key")).toHaveAttribute("type", "password");
  fireEvent.change(screen.getByLabelText("Default primary"), { target: { value: "test:model" } });
  expect(screen.getByTestId("default")).toHaveTextContent("test:model");
});
