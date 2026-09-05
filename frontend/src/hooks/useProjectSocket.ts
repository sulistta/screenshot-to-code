import { useCallback, useEffect, useRef, useState } from "react";
import { projectSocketUrl } from "@/lib/studioApi";
import type { StudioRunEvent } from "@/types/studio";
import { useStudioStore } from "@/store/studio-store";

/** One persistent socket per open project; replays events buffered by the
 * manager, so attaching late (or reconnecting) still gets full history. */
export function useProjectSocket(
  projectId: string | null,
  onEvent: (event: StudioRunEvent) => void,
) {
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!projectId) {
      setConnected(false);
      return;
    }
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let socket: WebSocket | null = null;
    let attempts = 0;

    const connect = () => {
      if (disposed) return;
      const cursor = useStudioStore.getState().eventCursor;
      const url = new URL(projectSocketUrl(projectId));
      if (cursor) {
        url.searchParams.set("after", String(cursor.sequence));
        url.searchParams.set("streamId", cursor.streamId);
      }
      socket = new WebSocket(url);
      socketRef.current = socket;

      socket.onopen = () => {
        if (disposed) return;
        attempts = 0;
        setConnected(true);
      };
      socket.onmessage = (message) => {
        if (disposed || socketRef.current !== socket) return;
        try {
          const event = JSON.parse(message.data) as StudioRunEvent;
          if (!event || typeof event.type !== "string") return;
          onEventRef.current({ ...event, projectId });
        } catch {
          // Ignore malformed frames; the backend sends JSON only.
        }
      };
      socket.onclose = () => {
        // Only tear down the shared ref if this socket is still the live
        // one: in StrictMode the first mount closes after the second
        // mount replaced the ref, and that late close must not null the
        // healthy socket out.
        if (socketRef.current === socket) {
          socketRef.current = null;
          setConnected(false);
        }
        if (!disposed) {
          const delay = Math.min(1500 * 2 ** attempts++, 15000);
          retryTimer = setTimeout(connect, delay + Math.random() * 500);
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      // Mark the socket as deliberately discarded before closing so its
      // close handler does not clobber the replacement socket's ref.
      const closing = socket;
      if (closing && socketRef.current === closing) {
        socketRef.current = null;
      }
      closing?.close();
    };
  }, [projectId]);

  const send = useCallback((payload: Record<string, unknown>) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected. Wait for reconnection and try again.");
    }
    socketRef.current.send(JSON.stringify(payload));
  }, []);

  return { connected, send };
}
