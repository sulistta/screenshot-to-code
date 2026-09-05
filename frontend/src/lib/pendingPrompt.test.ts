import { clearPendingPrompt, loadPendingPrompt, savePendingPrompt } from "./pendingPrompt";

describe("pendingPrompt handoff", () => {
  beforeEach(() => sessionStorage.clear());

  it("round-trips a recoverable creation request", () => {
    savePendingPrompt("p1", { text: "Build it", images: ["data:image/png;base64,x"], savedAt: 1 });
    expect(loadPendingPrompt("p1")).toEqual({ text: "Build it", images: ["data:image/png;base64,x"], savedAt: 1 });
  });

  it("is isolated per project and cleared on consume", () => {
    savePendingPrompt("p1", { text: "A", images: [], savedAt: 0 });
    expect(loadPendingPrompt("p2")).toBeNull();
    clearPendingPrompt("p1");
    expect(loadPendingPrompt("p1")).toBeNull();
  });

  it("rejects malformed payloads", () => {
    sessionStorage.setItem("pending-prompt:p1", "not-json{");
    expect(loadPendingPrompt("p1")).toBeNull();
    sessionStorage.setItem("pending-prompt:p1", JSON.stringify({ text: 42, images: "x" }));
    expect(loadPendingPrompt("p1")).toBeNull();
  });
});
