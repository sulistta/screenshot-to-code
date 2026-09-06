import { render, screen, fireEvent, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ProjectLibrary from "./ProjectLibrary";
import { useStudioStore } from "@/store/studio-store";
import type { StudioProject } from "@/types/studio";

jest.mock("@/lib/studioApi", () => ({
  listProjects: jest.fn(async () => []),
  updateProject: jest.fn(async (_id: string, patch: unknown) => ({ id: _id, ...(patch as object) })),
}));

jest.mock("@/lib/projectApi", () => ({
  setProjectOptions: jest.fn(async () => undefined),
  duplicateProject: jest.fn(async () => { throw new Error("unreachable"); }),
}));

// Radix portals are slow to transpile and their dismiss behavior belongs
// upstream; stub the shell and keep the menu logic under test.
jest.mock("@/components/ui/popover", () => {
  const ReactMock = jest.requireActual("react") as typeof import("react");
  type CtxValue = { open: boolean; setOpen: (open: boolean) => void };
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const Ctx = ReactMock.createContext<CtxValue>({ open: false, setOpen: (_open: boolean) => undefined });
  const Popover = ({ open, onOpenChange, children }: { open: boolean; onOpenChange: (o: boolean) => void; children: import("react").ReactNode }) =>
    ReactMock.createElement(Ctx.Provider, { value: { open, setOpen: onOpenChange } }, children);
  const PopoverTrigger = ({ children }: { children: import("react").ReactElement }) => {
    const { setOpen } = ReactMock.useContext(Ctx);
    return ReactMock.cloneElement(children, { onClick: () => setOpen(true) });
  };
  const PopoverContent = ({ children }: { children: import("react").ReactNode }) => {
    const { open, setOpen } = ReactMock.useContext(Ctx);
    if (!open) return null;
    return ReactMock.createElement("div", {
      role: "dialog",
      onKeyDown: (e: import("react").KeyboardEvent) => { if (e.key === "Escape") setOpen(false); },
    }, children);
  };
  return { Popover, PopoverTrigger, PopoverContent };
});

import { listProjects } from "@/lib/studioApi";
import { setProjectOptions } from "@/lib/projectApi";

const project = (overrides: Partial<StudioProject> = {}): StudioProject => ({
  id: "p1",
  name: "Orion",
  brief: "",
  createdAt: "2026-01-01",
  updatedAt: "2026-02-01",
  primaryModel: "",
  subagentModel: "",
  primaryEffort: "",
  subagentEffort: "",
  ...overrides,
});

function setup(collection: "active" | "favorites" | "archived" | "trash" = "active", search = "") {
  return render(
    <MemoryRouter>
      <ProjectLibrary search={search} onSelect={() => undefined} collection={collection} onCollectionChange={() => undefined} />
    </MemoryRouter>,
  );
}

describe("ProjectLibrary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useStudioStore.setState({
      projects: [project(), project({ id: "p2", name: "Lens", favorite: true }), project({ id: "p3", name: "Old", archived: true })],
      activeProjectId: "p1",
      error: null,
    });
  });

  it("reflects favorite/archive/trash results in the list immediately", async () => {
    (listProjects as jest.Mock).mockResolvedValue([project({ favorite: true })]);
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Actions for Orion" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Favorite" }));
    await act(async () => undefined);
    expect(setProjectOptions).toHaveBeenCalledWith("p1", { favorite: true, archived: false, trashed: false });
    expect(listProjects).toHaveBeenCalled();
    expect(useStudioStore.getState().projects[0]).toMatchObject({ favorite: true });
  });

  it("renames with empty names blocked and errors surfaced", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Actions for Orion" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Project name" });
    fireEvent.change(input, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "Orion v2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => undefined);
    expect(listProjects).toHaveBeenCalled();
  });

  it("hides trashed projects from the active collection", () => {
    setup("active");
    expect(screen.queryByTitle("Old")).not.toBeInTheDocument();
    expect(screen.getByTitle("Orion")).toBeInTheDocument();
  });
});
