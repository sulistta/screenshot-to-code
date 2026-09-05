import { runPresentation } from "./runPresentation";
import type { StudioActivityItem } from "../../store/studio-store";
const review: StudioActivityItem = { id: "review", kind: "tool", text: "", toolName: "screenshot_preview" };
it("only presents a pending review as current work", () => {
  expect(runPresentation("running", [review], {}).title).toBe("Reviewing the result");
  expect(runPresentation("running", [{ ...review, ok: true }], {}).title).toBe("Working on your brief");
  expect(runPresentation("running", [{ ...review, ok: false }], {}).title).toBe("Working on your brief");
});
it("prioritizes user attention and terminal state over stale activity", () => {
  expect(runPresentation("waiting_for_user", [review], {}).title).toBe("Your input is needed");
  expect(runPresentation("failed", [review], {}).title).toBe("This run couldn’t finish");
  expect(runPresentation("cancelled", [review], {}).title).toBe("Work stopped");
});
