"""Throttled live code preview: streams create_file content to the UI as
setCode events while the tool call arguments are still streaming, so the
user watches the page being written instead of waiting for the full tool.

Extracted in behavior from the previous engine implementation.
"""
import asyncio
from typing import Awaitable, Callable, Dict, Optional, Set

from agent.runtime.events import RunEvent, SetCodeEvent, ToolStartEvent
from agent.tools.summaries import summarize_text

# A streaming delta is flushed once the content grew by this many chars.
DELTA_FLUSH_CHARS = 40
# Cosmetic replay after the tool call completes: at most this many chunks.
MAX_REPLAY_CHUNKS = 18
MIN_REPLAY_CHUNK_CHARS = 200
REPLAY_CHUNK_DELAY_S = 0.01


class CodePreviewStreamer:
    """Tracks streamed create_file args and emits start/preview events."""

    def __init__(
        self,
        emit: Callable[[RunEvent], Awaitable[None]],
        on_replay_finished: Optional[Callable[[int], None]] = None,
    ) -> None:
        self._emit = emit
        self._on_replay_finished = on_replay_finished
        self._sent_lengths: Dict[str, int] = {}
        self._started_ids: Set[str] = set()

    def is_started(self, tool_event_id: str) -> bool:
        return tool_event_id in self._started_ids

    async def start(
        self,
        tool_event_id: str,
        name: str,
        tool_input: Dict[str, object],
    ) -> None:
        self._started_ids.add(tool_event_id)
        await self._emit(
            ToolStartEvent(event_id=tool_event_id, name=name, input=tool_input)
        )

    async def handle_streamed_args(
        self, tool_call_id: str, path: str, content: str
    ) -> None:
        """Emit toolStart (lazily, on first content) + throttled previews.

        The preview starts on the first extractable content so the user sees
        code immediately, then flushes at most once per DELTA_FLUSH_CHARS.
        """
        if not content:
            return
        if tool_call_id not in self._started_ids:
            await self.start(
                tool_call_id,
                "create_file",
                {
                    "path": path,
                    "contentLength": len(content),
                    "preview": summarize_text(content, 200),
                },
            )
        last_len = self._sent_lengths.get(tool_call_id, 0)
        should_flush = last_len == 0 or (
            len(content) - last_len >= DELTA_FLUSH_CHARS
        )
        if should_flush:
            self._sent_lengths[tool_call_id] = len(content)
            await self._emit(SetCodeEvent(content=content, source="tool_stream"))

    async def replay_complete(self, tool_call_id: str, content: str) -> bool:
        """Cosmetic replay of complete content in chunks (non-streaming path).

        Returns True when anything was emitted, so the caller can record the
        preview. Skips silently when streaming already sent everything.
        """
        already_sent = self._sent_lengths.get(tool_call_id, 0)
        total_len = len(content)
        if already_sent >= total_len:
            return False

        step = max(MIN_REPLAY_CHUNK_CHARS, total_len // MAX_REPLAY_CHUNKS)
        start = already_sent if already_sent > 0 else 0
        for end in range(start + step, total_len, step):
            await self._emit(
                SetCodeEvent(content=content[:end], source="tool_stream")
            )
            self._sent_lengths[tool_call_id] = end
            await asyncio.sleep(REPLAY_CHUNK_DELAY_S)

        await self._emit(SetCodeEvent(content=content, source="tool_stream"))
        self._sent_lengths[tool_call_id] = total_len
        if self._on_replay_finished is not None:
            self._on_replay_finished(total_len)
        return True
