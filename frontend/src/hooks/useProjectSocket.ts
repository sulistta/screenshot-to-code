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
        // Only tear down the shared ref if this socket is still the live
        // one: in StrictMode the first mount closes after the second
        // mount replaced the ref, and that late close must not null the
        // healthy socket out.
        if (socketRef.current === socket) {
          socketRef.current = null;
          setConnected(false);
        }
        if (!disposed) {
          retryTimer = setTimeout(connect, 1500);
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
    socketRef.current?.send(JSON.stringify(payload));
  }, []);

  return { connected, send };
}
