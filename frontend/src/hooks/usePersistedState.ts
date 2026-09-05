import { useCallback, useState, type SetStateAction } from "react";
import { readPreference, writePreference } from "@/lib/preferences";
import { useStudioStore } from "@/store/studio-store";

/** Startup hydration completes before any editor mounts. Save only user
 * changes, and serialize writes so slow keychains cannot reorder keystrokes. */
export function usePersistedState<T>(initialValue: T, key: string) {
  const [value, setValue] = useState<T>(() => readPreference(key, initialValue));
  const update = useCallback((next: SetStateAction<T>) => {
    const current = readPreference(key, initialValue);
    const resolved = next instanceof Function ? next(current) : next;
    setValue(resolved);
    void writePreference(key, resolved).catch((error: Error) => useStudioStore.getState().setError(error.message));
  }, [key, initialValue]);
  return [value, update] as const;
}
