import { render, screen, fireEvent, act } from "@testing-library/react";
import { RunHandoff } from "./RunHandoff";
import { useStudioStore } from "@/store/studio-store";

jest.mock("@/lib/projectApi", () => ({
  restoreDraft: jest.fn(async () => undefined),
}));

import { restoreDraft } from "@/lib/projectApi";

describe("RunHandoff", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useStudioStore.setState({ lastOutcome: null, iterations: [] });
  });

  it("resets the recovery result when a new run outcome arrives", async () => {
    useStudioStore.setState({
      lastOutcome: { runId: "r1", status: "cancelled", iterationId: null, filesChanged: [], draftAvailable: true },
    });
    const { rerender } = render(<RunHandoff projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: /restore partial work/i }));
    await act(async () => undefined);
    expect(restoreDraft).toHaveBeenCalledWith("p1", "r1");
    expect(screen.getByText(/partial work restored/i)).toBeInTheDocument();

    act(() => {
      useStudioStore.setState({
        lastOutcome: { runId: "r2", status: "cancelled", iterationId: null, filesChanged: [], draftAvailable: true },
      });
    });
    rerender(<RunHandoff projectId="p1" />);
    // Recovery belongs to r1: r2 offers a fresh restore action.
    expect(screen.queryByText(/partial work restored/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /restore partial work/i })).toBeInTheDocument();
  });
});
