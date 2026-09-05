import { renderHook, act } from "@testing-library/react";
import { usePersistedState } from "./usePersistedState";

jest.mock("@/lib/preferences", () => {
  const values = new Map<string, unknown>([["k", "initial"]]);
  let failNext = false;
  return {
    readPreference: jest.fn((key: string, fallback: unknown) => {
      const value = values.get(key);
      return value === undefined ? fallback : value;
    }),
    writePreference: jest.fn((key: string, value: unknown) => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error("keychain locked"));
      }
      values.set(key, value);
      return Promise.resolve();
    }),
    __failNextWrite: () => { failNext = true; },
    __values: values,
  };
});

import { readPreference } from "@/lib/preferences";
import { useStudioStore } from "@/store/studio-store";

const prefs = jest.requireMock("@/lib/preferences") as { __failNextWrite: () => void };

describe("usePersistedState", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (readPreference as jest.Mock).mockImplementation((_key: string, fallback: unknown) => fallback);
    useStudioStore.setState({ error: null });
  });

  it("keeps the edit, reports the failure, and retries without losing it", async () => {
    const { result } = renderHook(() => usePersistedState("v0", "k"));
    prefs.__failNextWrite();
    act(() => {
      result.current[1]("v1");
    });
    expect(result.current[0]).toBe("v1");
    expect(result.current[2].status).toBe("saving");
    await act(async () => undefined);
    expect(result.current[2].status).toBe("error");
    expect(result.current[2].error).toBe("keychain locked");
    // The edit is preserved and the global error is set.
    expect(result.current[0]).toBe("v1");
    expect(useStudioStore.getState().error).toBe("keychain locked");

    act(() => {
      result.current[2].retry();
    });
    await act(async () => undefined);
    expect(result.current[2].status).toBe("saved");
    expect(result.current[0]).toBe("v1");
  });
});
