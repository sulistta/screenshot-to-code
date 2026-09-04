"""Typed run events: the single stream consumed by the WS transport, the
run recorder, and (future) recovery/eval tooling.

Every observable thing that happens during a run becomes a RunEvent. The
transport layer adapts these to the wire protocol; it never inspects loop
internals. Each subclass carries its wire discriminator as the ``type``
default so emitters never pass it manually.
"""
from dataclasses import dataclass, field
from typing import Any, Dict, Optional


def _empty_tool_input() -> Dict[str, Any]:
    return {}


@dataclass
class RunEvent:
    """Base for run events; ``type`` is the discriminator sent on the wire."""

    type: str = ""


@dataclass
class StatusEvent(RunEvent):
    type: str = "status"
    message: str = ""
    # Machine-readable phase for progress UIs (e.g. "planning", "building").
    phase: Optional[str] = None


@dataclass
class SetCodeEvent(RunEvent):
    type: str = "set_code"
    content: str = ""
    source: str = ""


@dataclass
class ThinkingDeltaEvent(RunEvent):
    type: str = "thinking_delta"
    text: str = ""
    event_id: Optional[str] = None


@dataclass
class AssistantDeltaEvent(RunEvent):
    type: str = "assistant_delta"
    text: str = ""
    event_id: Optional[str] = None


@dataclass
class ToolStartEvent(RunEvent):
    type: str = "tool_start"
    event_id: str = ""
    name: str = ""
    input: Dict[str, Any] = field(default_factory=_empty_tool_input)


@dataclass
class ToolResultEvent(RunEvent):
    type: str = "tool_result"
    event_id: str = ""
    name: str = ""
    output: Dict[str, Any] = field(default_factory=_empty_tool_input)
    ok: bool = True


@dataclass
class QuestionEvent(RunEvent):
    """The run asked the user something and is now WAITING_FOR_USER."""

    type: str = "question"
    event_id: str = ""
    question: str = ""
    options: Optional[list[str]] = None
    context: Optional[str] = None
