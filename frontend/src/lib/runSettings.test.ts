import { runSettings } from "./runSettings";
import { DEFAULT_SETTINGS } from "./defaultSettings";

it("ignores persisted legacy technology preferences and retains provider settings", () => {
  const settings = { ...DEFAULT_SETTINGS, generatedCodeConfig: "react_tailwind" };
  const payload = runSettings(settings, { primaryModel: "chosen", subagentModel: "specialist", primaryEffort: "high", subagentEffort: "low" });
  expect(payload).not.toHaveProperty("generatedCodeConfig");
  expect(payload.primaryModel).toBe("chosen");
  expect(payload.subagentModel).toBe("specialist");
  expect(payload.primaryEffort).toBe("high");
  expect(payload.subagentEffort).toBe("low");
  expect(payload.isImageGenerationEnabled).toBe(true);
});

it("defaults missing roles to the provider default effort", () => {
  const payload = runSettings(DEFAULT_SETTINGS);
  expect(payload).toMatchObject({ primaryModel: "", subagentModel: "", primaryEffort: "", subagentEffort: "" });
});
