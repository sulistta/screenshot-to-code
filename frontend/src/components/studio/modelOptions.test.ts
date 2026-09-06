import { buildModelOptions, effortsForModel, modelDisplayName } from "./modelOptions";
import { DEFAULT_SETTINGS } from "@/lib/defaultSettings";
import type { Settings } from "@/types";

const catalog = [
  { model: "gpt-5.5", group: "OpenAI", efforts: ["none", "low", "medium", "high", "xhigh"] },
  { model: "gpt-5.4-mini", group: "OpenAI", efforts: ["low"] },
  { model: "claude-sonnet-4-6", group: "Anthropic", efforts: [] },
  { model: "gemini-3.1-pro-preview", group: "Gemini", efforts: ["low", "medium", "high"] },
];

it("keeps custom provider ids readable", () => {
  expect(modelDisplayName("")).toBe("");
  expect(modelDisplayName("gpt-5.5")).toBe("gpt-5.5");
  expect(modelDisplayName("custom:llama3")).toBe("llama3");
});

it("maps each role's effort options to the selected model", () => {
  // Without a model, every level in the catalogue is offered.
  expect(effortsForModel("", catalog)).toEqual(["none", "low", "medium", "high", "xhigh"]);
  // A model offers exactly what it supports, even when empty.
  expect(effortsForModel("gpt-5.5", catalog)).toEqual(["none", "low", "medium", "high", "xhigh"]);
  expect(effortsForModel("gpt-5.4-mini", catalog)).toEqual(["low"]);
  expect(effortsForModel("claude-sonnet-4-6", catalog)).toEqual([]);
  expect(effortsForModel("unknown-model", catalog)).toEqual([]);
  // Custom provider models never receive an effort parameter.
  expect(effortsForModel("custom:llama3", catalog)).toEqual([]);
});

it("groups catalogue models and appends the active custom provider", () => {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    customProviders: [{
      id: "local", name: "Local", enabled: true, baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: null, protocol: "chat_completions", headers: {},
      models: [{ id: "qwen", name: "Qwen" }],
    }],
    activeCustomProviderId: "local",
  };
  const options = buildModelOptions(catalog, settings);
  expect(options.map((option) => option.value)).toEqual([
    "gpt-5.5", "gpt-5.4-mini", "claude-sonnet-4-6", "gemini-3.1-pro-preview", "custom:qwen",
  ]);
  expect(options[4]).toMatchObject({ group: "Local", efforts: [] });
});
