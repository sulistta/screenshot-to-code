import { render, screen, fireEvent, act } from "@testing-library/react";
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
  updateProject: jest.fn(async (_id: string, patch: unknown) => ({ id: _id, ...(patch as object) })),
}));

jest.mock("./ModelPicker", () => ({
  __esModule: true,
  default: () => null,
}));

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

import { createProject, startRun } from "@/lib/studioApi";

function renderHome() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<StudioPage />} />
        <Route path="/projects/:projectId" element={<StudioPage />} />
      </Routes>
    </MemoryRouter>,
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
    expect(await screen.findByPlaceholderText("What do you want to create?")).toHaveValue("My idea");
  });
});
