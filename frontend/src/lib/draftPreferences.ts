import { native } from "./native";

/** Raw preference access for values outside the preloaded cache (e.g. drafts). */
export async function loadPreference<T>(key: string): Promise<T | null> {
  try {
    return await native<T | null>("load_preferences", { key });
  } catch {
    return null;
  }
}

export function savePreference<T>(key: string, value: T): Promise<void> {
  return native<void>("save_preferences", { key, value });
}
