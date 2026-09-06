import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import StudioPage from "./StudioPage";
import { useStudioStore } from "@/store/studio-store";

const mockSubscribe = jest.fn();
const mockUnsubscribe = jest.fn();
jest.mock("@/hooks/useProjectEvents", () => ({ useProjectEvents: () => {
  const { useEffect } = jest.requireActual("react");
  useEffect(() => { mockSubscribe(); return mockUnsubscribe; }, []);
  return { connected: true, send: jest.fn() };
} }));
jest.mock("@/lib/studioApi", () => ({
  listProjects: jest.fn(async () => [{ id: "p", name: "Project", brief: "", primaryModel: "", subagentModel: "", updatedAt: "", createdAt: "" }]),
  getTranscript: jest.fn(async () => []),
}));
jest.mock("@/lib/projectApi", () => ({ getFiles: jest.fn(async () => ({ files: {}, revision: "1" })) }));
jest.mock("./ModelPicker", () => ({ __esModule: true, default: () => null }));
jest.mock("./StudioWorkbench", () => ({ __esModule: true, default: () => <div>Result pane</div> }));
jest.mock("./WindowTitlebar", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/settings/SettingsTab", () => ({ __esModule: true, default: () => <div>Preferences panel</div> }));

beforeEach(() => { sessionStorage.clear(); jest.clearAllMocks(); useStudioStore.getState().setActiveProject(null); useStudioStore.setState({ projects: [] }); });
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/projects/p"]}><Routes><Route path="/projects/:projectId" element={<StudioPage />} /></Routes></MemoryRouter></QueryClientProvider>);
  return { client, ...view };
}
it("preserves subscription and draft while Settings is open and receives events", async () => {
  setup();
  const input = await screen.findByRole("textbox", { name: "Message" });
  expect(document.querySelector(".conversation-message")).toBeNull();
  expect(screen.getByText("Your idea starts here")).toBeInTheDocument();
  fireEvent.change(input, { target: { value: "Next idea" } });
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(screen.getByText("Preferences panel")).toBeInTheDocument();
  act(() => useStudioStore.getState().handleEvent({ type: "run_status", projectId: "p", runId: "r", status: "completed", message: "Finished in background" }));
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.getByRole("textbox", { name: "Message" })).toBe(input);
  expect(input).toHaveValue("Next idea");
  fireEvent.click(screen.getByRole("button", { name: "History" }));
  expect(within(screen.getByRole("dialog")).getByText("Finished in background")).toBeInTheDocument();
  expect(mockSubscribe).toHaveBeenCalledTimes(1);
  expect(mockUnsubscribe).not.toHaveBeenCalled();
});
it("reveals saved results once and respects a manual collapse after later updates", async () => {
  const { client, container } = setup();
  await screen.findByRole("textbox", { name: "Message" });
  expect(container.querySelector(".layout-conversation")).toBeInTheDocument();
  await act(async () => { client.setQueryData(["files", "p"], { files: { "index.html": "First" }, revision: "2" }); });
  await waitFor(() => expect(container.querySelector(".layout-split")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "Overview" }));
  await act(async () => { client.setQueryData(["files", "p"], { files: { "index.html": "Updated" }, revision: "3" }); });
  expect(container.querySelector(".layout-conversation")).toBeInTheDocument();
  expect(sessionStorage.getItem("result-layout:p")).toBe("conversation");
});

it("opens agent activity inline and retains the result when switching panels", async () => {
  const { container } = setup();
  await screen.findByRole("textbox", { name: "Message" });
  const result = screen.getByText("Result pane");
  fireEvent.click(within(container.querySelector(".workspace-actions") as HTMLElement).getByRole("button", { name: "Agents" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Parallel agent activity" })).toBeVisible();
  expect(result).not.toBeVisible();
  fireEvent.click(within(container.querySelector(".workspace-panel-tabs") as HTMLElement).getByRole("button", { name: "Result" }));
  expect(screen.getByText("Result pane")).toBe(result);
  expect(result).toBeVisible();
});
