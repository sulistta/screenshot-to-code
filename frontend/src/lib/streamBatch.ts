import type { StudioRunEvent } from "@/types/studio";

/** Coalesce transport fragments, preserving sequence boundaries and terminal ordering. */
export function streamBatch(deliver: (event: StudioRunEvent) => void) {
  let pending: StudioRunEvent | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer); timer = undefined;
    if (pending) { const event = pending; pending = undefined; deliver(event); }
  };
  return {
    push(event: StudioRunEvent) {
      const text = event.type === "thinking_delta" || event.type === "assistant_delta";
      if (!text) { flush(); deliver(event); return; }
      if (pending && (pending.type !== event.type || pending.agentId !== event.agentId || pending.runId !== event.runId || pending.streamId !== event.streamId)) flush();
      if (pending && event.sequence !== undefined && pending.sequence !== undefined && event.sequence <= pending.sequence) return;
      pending = { ...event, text: (pending?.text ?? "") + (event.text ?? "") };
      timer ??= setTimeout(flush, 50);
    },
    flush,
    dispose() { clearTimeout(timer); pending = undefined; },
  };
}
