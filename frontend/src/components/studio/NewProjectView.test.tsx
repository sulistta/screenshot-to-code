import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import StudioPage from "./StudioPage";
import { useStudioStore } from "@/store/studio-store";
import { DEFAULT_SETTINGS } from "@/lib/defaultSettings";

jest.mock("@/lib/studioApi", () => ({
  listProjects: jest.fn(async () => []),
  createProject: jest.fn(async (name: string, brief: string) => ({
    id: "new-1", name, brief, createdAt: "", updatedAt: "",
    primaryModel: "", subagentModel: "",
  })),
  getTranscript: jest.fn(async () => []),
  startRun: jest.fn(async () => "run-1"),
  updateProject: jest.fn(async (_id: string, patch: unknown) => ({ id: _id, name: "Configured project", brief: "", primaryModel: "", subagentModel: "", updatedAt: "", createdAt: "", ...(patch as object) })),
}));

jest.mock("./ModelPicker", () => ({
  __esModule: true,
  default: ({ label, onChange, value }: { label: string; onChange: (value: string) => void; value: string }) => <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}><option value="">Automatic</option><option value="test:model">Test</option></select>,
}));

jest.mock("@/lib/projectApi", () => ({ getFiles: jest.fn(async () => ({ files: {}, revision: "v1" })) }));
jest.mock("./ProjectTools", () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock("./StudioWorkbench", () => ({
  __esModule: true,
  default: () => null,
  PreviewWindowButton: () => null,
}));

jest.mock("./WindowTitlebar", () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock("@/components/settings/SettingsTab", () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock("@/hooks/useProjectEvents", () => ({
  useProjectEvents: () => ({ send: jest.fn(async () => undefined), connected: true }),
}));

import { createProject, startRun, updateProject } from "@/lib/studioApi";

function renderHome() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<StudioPage />} />
        <Route path="/projects/:projectId" element={<StudioPage />} />
      </Routes>
    </MemoryRouter></QueryClientProvider>,
  );
}

describe("NewProjectView", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sessionStorage.clear();
    window.location.hash = "#/";
    useStudioStore.setState({
      projects: [], activeProjectId: null, transcript: [], activity: [],
      team: {}, runStatus: null, activeQuestion: null, error: null,
      iterations: [], lastOutcome: null, settings: { ...DEFAULT_SETTINGS },
    });
  });

  it("fills the brief from a suggestion without creating anything", async () => {
    renderHome();
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Ideas" }));
    fireEvent.click(screen.getByRole("button", { name: "A SaaS landing page for a productivity tool" }));
    expect(screen.getByRole("textbox", { name: "Project brief" })).toHaveValue(
      "A SaaS landing page for a productivity tool",
    );
    expect(createProject).not.toHaveBeenCalled();
    expect(startRun).not.toHaveBeenCalled();
  });

  it("creates once on double submit and starts generation explicitly", async () => {
    renderHome();
    await act(async () => undefined);
    fireEvent.change(screen.getByRole("textbox", { name: "Project brief" }), {
      target: { value: "My idea" },
    });
    const create = screen.getByRole("button", { name: /create project/i });
    await act(async () => {
      fireEvent.click(create);
      fireEvent.click(create);
    });
    expect(createProject).toHaveBeenCalledTimes(1);
    expect(startRun).toHaveBeenCalledTimes(1);
  });

  it("keeps the brief recoverable when generation cannot start", async () => {
    (startRun as jest.Mock).mockRejectedValueOnce(new Error("no provider"));
    renderHome();
    await act(async () => undefined);
    fireEvent.change(screen.getByRole("textbox", { name: "Project brief" }), {
      target: { value: "My idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create project/i }));
    expect(createProject).toHaveBeenCalledTimes(1);
    // The failure is surfaced globally, the project is kept, and the brief
    // is restored in its conversation for a retry (no duplicate project).
    expect(await screen.findByRole("alert")).toHaveTextContent(/brief was kept/i);
    expect(await screen.findByRole("textbox", { name: "Message" })).toHaveValue("My idea");
  });
  it("saves both models before starting and updates the project in the store", async () => {
    renderHome();
    await act(async () => undefined);
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "test:model" } });
    fireEvent.change(screen.getByLabelText("Subagents"), { target: { value: "test:model" } });
    fireEvent.change(screen.getByLabelText("Project brief"), { target: { value: "Configured project" } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(startRun).toHaveBeenCalledTimes(1));
    expect(updateProject).toHaveBeenCalledWith("new-1", { primaryModel: "test:model", subagentModel: "test:model" });
    expect(useStudioStore.getState().projects[0].primaryModel).toBe("test:model");
    expect((startRun as jest.Mock).mock.calls[0][2]).not.toHaveProperty("generatedCodeConfig");
  });

  it("keeps a created project and draft when model persistence fails without starting", async () => {
    (updateProject as jest.Mock).mockRejectedValueOnce(new Error("save failed"));
    renderHome();
    await act(async () => undefined);
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "test:model" } });
    fireEvent.change(screen.getByLabelText("Project brief"), { target: { value: "Keep this" } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(await screen.findByRole("textbox", { name: "Message" })).toHaveValue("Keep this");
    expect(startRun).not.toHaveBeenCalled();
    expect(createProject).toHaveBeenCalledTimes(1);
  });

});
