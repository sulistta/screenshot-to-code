import { native } from "./native";
const cache = new Map<string, unknown>();
const writes = new Map<string, Promise<void>>();
export async function initializePreferences(): Promise<void> {
  await Promise.all(["setting", "app-theme"].map(async (key) => {
    cache.set(key, await native("load_preferences", { key }));
  }));
}
export function readPreference<T>(key: string, fallback: T): T {
  const value = cache.get(key);
  if (value == null) return fallback;
  return typeof fallback === "object" ? { ...fallback, ...value as Partial<T> } : value as T;
}
export function writePreference<T>(key: string, value: T): Promise<void> {
  cache.set(key, value);
  const previous = writes.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => native<void>("save_preferences", { key, value }));
  writes.set(key, next);
  return next;
}
