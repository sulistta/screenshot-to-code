import { useCallback, useRef, useState, type SetStateAction } from "react";
import { readPreference, writePreference } from "@/lib/preferences";
import { useStudioStore } from "@/store/studio-store";

export type PersistStatus = "saved" | "saving" | "error";

/**
 * Persisted preference with an honest status. The edited value stays visible
 * while saving; a failed write keeps the edit, reports the error, and offers
 * a retry instead of silently dropping the change. Writes stay serialized so
 * an older confirmation can never overwrite a newer edit.
 */
export function usePersistedState<T>(initialValue: T, key: string) {
  const [value, setValue] = useState<T>(() => readPreference(key, initialValue));
  const [status, setStatus] = useState<PersistStatus>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const version = useRef(0);

  const persist = useCallback((next: T) => {
    const current = ++version.current;
    setStatus("saving");
    setSaveError(null);
    return writePreference(key, next).then(
      () => {
        if (version.current === current) {
          setStatus("saved");
          useStudioStore.getState().setError(null);
        }
      },
      (error: unknown) => {
        if (version.current === current) {
          const message = error instanceof Error ? error.message : String(error);
          setStatus("error");
          setSaveError(message);
          useStudioStore.getState().setError(message);
        }
        throw error;
      },
    );
  }, [key]);

  const update = useCallback((next: SetStateAction<T>) => {
    const current = readPreference(key, initialValue);
    const resolved = next instanceof Function ? next(current) : next;
    setValue(resolved);
    void persist(resolved).catch(() => undefined);
  }, [key, initialValue, persist]);

  const retry = useCallback(() => {
    void persist(value).catch(() => undefined);
  }, [persist, value]);

  return [value, update, { status, error: saveError, retry }] as const;
}
