import { streamBatch } from "@/lib/streamBatch";
import { useCallback, useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { native } from "@/lib/native";
import type { StudioRunEvent } from "@/types/studio";
import { useStudioStore } from "@/store/studio-store";

/** Channels belong to a subscription, so an old effect's cleanup cannot remove
 * the replacement subscription during React StrictMode or project switching. */
export function useProjectEvents(projectId: string | null, onEvent: (event: StudioRunEvent) => void) {
  const [connected, setConnected] = useState(false);
  const callback = useRef(onEvent);
  callback.current = onEvent;
  useEffect(() => {
    if (!projectId) return;
    let disposed = false;
    const subscriptionId = crypto.randomUUID();
    const channel = new Channel<StudioRunEvent>();
    const batch = streamBatch((event) => { if (!disposed) callback.current(event); });
    channel.onmessage = (event) => { if (!disposed) batch.push(event); };
    const cursor = useStudioStore.getState().eventCursor;
    const subscription = native<void>("subscribe_project", {
      projectId, subscriptionId, onEvent: channel,
      after: cursor?.streamId === projectId ? cursor.sequence : 0,
    });
    subscription.then(() => { if (!disposed) setConnected(true); }).catch((error: Error) => {
      if (!disposed) useStudioStore.getState().setError(error.message);
    });
    return () => {
      batch.flush();
      batch.dispose();
      disposed = true; setConnected(false);
      void subscription.then(() => native("unsubscribe_project", { subscriptionId })).catch(() => undefined);
    };
  }, [projectId]);
  const send = useCallback(async (payload: Record<string, unknown>) => {
    if (!projectId || payload.type !== "answer") throw new Error("No active question");
    await native("answer_question", { projectId, questionId: payload.questionId, answer: payload.answer });
  }, [projectId]);
  return { connected, send };
}
