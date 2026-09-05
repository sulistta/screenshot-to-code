export interface PendingPrompt {
  text: string;
  images: string[];
  savedAt: number;
  error?: string;
}

const keyFor = (projectId: string) => `pending-prompt:${projectId}`;

/**
 * A creation request that outlives the New Project composer: when project
 * creation succeeds but generation cannot start, the brief is handed to the
 * project conversation so it can be retried without creating a duplicate.
 */
export function savePendingPrompt(projectId: string, prompt: PendingPrompt): void {
  try {
    sessionStorage.setItem(keyFor(projectId), JSON.stringify(prompt));
  } catch {
    /* best-effort */
  }
}

export function loadPendingPrompt(projectId: string): PendingPrompt | null {
  try {
    const raw = sessionStorage.getItem(keyFor(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingPrompt>;
    if (typeof parsed.text !== "string" || !Array.isArray(parsed.images)) return null;
    return {
      text: parsed.text,
      error: typeof parsed.error === "string" ? parsed.error : undefined,
      images: parsed.images.filter((item): item is string => typeof item === "string"),
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
    };
  } catch {
    return null;
  }
}

export function clearPendingPrompt(projectId: string): void {
  try {
    sessionStorage.removeItem(keyFor(projectId));
  } catch {
    /* ignore */
  }
}
