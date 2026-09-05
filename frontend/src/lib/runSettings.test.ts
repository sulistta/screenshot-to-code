import { runSettings } from "./runSettings";
import { DEFAULT_SETTINGS } from "./defaultSettings";

it("ignores persisted legacy technology preferences and retains provider settings", () => {
  const settings = { ...DEFAULT_SETTINGS, generatedCodeConfig: "react_tailwind" };
  const payload = runSettings(settings, "chosen", "specialist");
  expect(payload).not.toHaveProperty("generatedCodeConfig");
  expect(payload.primaryModel).toBe("chosen");
  expect(payload.subagentModel).toBe("specialist");
  expect(payload.isImageGenerationEnabled).toBe(true);
});
