import { useCallback, useEffect, useRef, useState } from "react";
import { projectSocketUrl } from "@/lib/studioApi";
import type { StudioRunEvent } from "@/types/studio";

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

    const connect = () => {
      if (disposed) return;
      socket = new WebSocket(projectSocketUrl(projectId));
      socketRef.current = socket;

      socket.onopen = () => setConnected(true);
      socket.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data) as StudioRunEvent;
          onEventRef.current(event);
        } catch {
          // Ignore malformed frames; the backend sends JSON only.
        }
      };
      socket.onclose = () => {
        setConnected(false);
        socketRef.current = null;
        if (!disposed) {
          retryTimer = setTimeout(connect, 1500);
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
      socketRef.current = null;
    };
  }, [projectId]);

  const send = useCallback((payload: Record<string, unknown>) => {
    socketRef.current?.send(JSON.stringify(payload));
  }, []);

  return { connected, send };
}
