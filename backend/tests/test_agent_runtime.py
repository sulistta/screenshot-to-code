"""Tests for the agent runtime loop: tool sequencing, budget, stuck
detection, ask_user gating, and event emission.
"""
import asyncio
from typing import List, Optional

import pytest
from openai.types.chat import ChatCompletionMessageParam

from agent.providers.base import EventSink, ExecutedToolCall, ProviderTurn
from agent.runtime.errors import BudgetExceededError, StuckLoopError
from agent.runtime.events import RunEvent
from agent.runtime.interaction import QuestionGate
from agent.runtime.loop import AgentRuntime, RuntimeConfig
from agent.runtime.statuses import RunStatus
from agent.state import AgentFileState
from agent.tools import AgentToolRuntime
from agent.tools.types import ToolCall
from llm import Llm


class ScriptedSession:
    """Returns scripted provider turns in order."""

    def __init__(self, turns: List[ProviderTurn], cost_usd: Optional[float] = None):
        self.turns = list(turns)
        self.cost_usd = cost_usd
        self.appended: List[List[ExecutedToolCall]] = []
        self.closed = False

    async def stream_turn(self, on_event: EventSink) -> ProviderTurn:
        return self.turns.pop(0)

    async def append_tool_results(
        self,
        turn: ProviderTurn,
        executed_tool_calls: List[ExecutedToolCall],
    ) -> None:
        self.appended.append(executed_tool_calls)

    def total_cost_usd(self) -> Optional[float]:
        return self.cost_usd

    async def close(self) -> None:
        self.closed = True


def _create_call(content: str = "<html>hi</html>", call_id: str = "c1") -> ToolCall:
    return ToolCall(id=call_id, name="create_file", arguments={"content": content})


def _noop_runtime(file_state: Optional[AgentFileState] = None) -> AgentToolRuntime:
    return AgentToolRuntime(
        file_state=file_state or AgentFileState(),
        should_generate_images=False,
        openai_api_key=None,
        openai_base_url=None,
    )


class EventLog:
    def __init__(self) -> None:
        self.events: List[RunEvent] = []

    async def __call__(self, event: RunEvent) -> None:
        self.events.append(event)

    def types(self) -> List[str]:
        return [event.type for event in self.events]


@pytest.mark.asyncio
async def test_tool_turn_then_final_turn_returns_file_content() -> None:
    session = ScriptedSession(
        [
            ProviderTurn(assistant_text="", tool_calls=[_create_call()]),
            ProviderTurn(assistant_text="done", tool_calls=[]),
        ]
    )
    log = EventLog()
    runtime = AgentRuntime(
        session=session,
        tool_runtime=_noop_runtime(),
        emit=log,
        config=RuntimeConfig(budget_usd=None),
    )
    result = await runtime.run(Llm.GPT_5_5_HIGH, [])
    assert result == "<html>hi</html>"
    assert runtime.status is RunStatus.COMPLETED
    assert "tool_start" in log.types()
    assert "tool_result" in log.types()
    assert len(session.appended) == 1
    assert session.appended[0][0].result.ok is True
    assert session.closed is False  # engine facade owns the session


@pytest.mark.asyncio
async def test_no_tool_calls_finalizes_from_seeded_file_state() -> None:
    file_state = AgentFileState(content="<html>seeded</html>")
    session = ScriptedSession([ProviderTurn(assistant_text="done", tool_calls=[])])
    runtime = AgentRuntime(
        session=session,
        tool_runtime=_noop_runtime(file_state),
        emit=EventLog(),
    )
    result = await runtime.run(Llm.GPT_5_5_HIGH, [])
    assert result == "<html>seeded</html>"
    assert runtime.file_state is file_state


@pytest.mark.asyncio
async def test_budget_aborts_mid_run() -> None:
    session = ScriptedSession(
        [
            ProviderTurn(assistant_text="", tool_calls=[_create_call()]),
            ProviderTurn(
                assistant_text="more", tool_calls=[_create_call("x", "c2")]
            ),
        ],
        cost_usd=5.0,
    )
    runtime = AgentRuntime(
        session=session,
        tool_runtime=_noop_runtime(),
        emit=EventLog(),
        config=RuntimeConfig(budget_usd=3.0),
    )
    with pytest.raises(BudgetExceededError):
        await runtime.run(Llm.GPT_5_5_HIGH, [])
    assert runtime.status is RunStatus.FAILED
    # The over-budget check precedes tool execution: nothing ran.
    assert len(session.appended) == 0


@pytest.mark.asyncio
async def test_identical_tool_calls_warn_then_fail() -> None:
    calls = [
        ProviderTurn(assistant_text="", tool_calls=[_create_call("same", f"c{i}")])
        for i in range(1, 6)
    ]
    session = ScriptedSession(calls)
    log = EventLog()
    runtime = AgentRuntime(
        session=session,
        tool_runtime=_noop_runtime(),
        emit=log,
        config=RuntimeConfig(budget_usd=None),
    )
    with pytest.raises(StuckLoopError):
        await runtime.run(Llm.GPT_5_5_HIGH, [])
    assert runtime.status is RunStatus.STUCK
    # Calls 3 and 4 warn (tool_result carries repeat_warning); call 5 fails.
    warning_events = [
        event
        for event in log.events
        if event.type == "tool_result" and "repeat_warning" in event.output
    ]
    assert len(warning_events) == 2


@pytest.mark.asyncio
async def test_ask_user_parks_until_answer() -> None:
    gate = QuestionGate()
    question_seen = asyncio.Event()

    async def answerer() -> None:
        await question_seen.wait()
        assert gate.has_pending()
        assert gate.deliver("dark blue")
        # Delivering with nothing pending fails cleanly.
        assert gate.deliver("nobody home") is False

    answer_task = asyncio.get_running_loop().create_task(answerer())

    session = ScriptedSession(
        [
            ProviderTurn(
                assistant_text="",
                tool_calls=[
                    ToolCall(
                        id="q1",
                        name="ask_user",
                        arguments={
                            "question": "Blue or red?",
                            "options": ["blue", "red", "green", "purple"],
                        },
                    )
                ],
            ),
            ProviderTurn(assistant_text="", tool_calls=[_create_call()]),
            ProviderTurn(assistant_text="done", tool_calls=[]),
        ]
    )
    log = EventLog()

    async def emit(event: RunEvent) -> None:
        await log(event)
        if event.type == "question":
            question_seen.set()

    runtime = AgentRuntime(
        session=session,
        tool_runtime=_noop_runtime(),
        emit=emit,
        interaction=gate,
        config=RuntimeConfig(budget_usd=None),
    )
    result = await runtime.run(Llm.GPT_5_5_HIGH, [])
    await answer_task
    assert result == "<html>hi</html>"
    question_events = [e for e in log.events if e.type == "question"]
    assert len(question_events) == 1
    assert question_events[0].question == "Blue or red?"
    assert question_events[0].options == ["blue", "red", "green", "purple"]
    # The answer reached the model as the tool result.
    executed = session.appended[0][0]
    assert executed.result.result["answer"] == "dark blue"


@pytest.mark.asyncio
async def test_ask_user_without_interaction_returns_error_tool_result() -> None:
    session = ScriptedSession(
        [
            ProviderTurn(
                assistant_text="",
                tool_calls=[
                    ToolCall(id="q1", name="ask_user", arguments={"question": "Yes?", "options": ["a", "b", "c", "d"]})
                ],
            ),
            ProviderTurn(assistant_text="", tool_calls=[_create_call()]),
            ProviderTurn(assistant_text="done", tool_calls=[]),
        ]
    )
    runtime = AgentRuntime(
        session=session,
        tool_runtime=_noop_runtime(),
        emit=EventLog(),
        interaction=None,
    )
    await runtime.run(Llm.GPT_5_5_HIGH, [])
    executed = session.appended[0][0]
    assert executed.result.ok is False


@pytest.mark.asyncio
async def test_ask_user_empty_answer_is_a_decline() -> None:
    gate = QuestionGate()
    question_seen = asyncio.Event()

    async def decliner() -> None:
        await question_seen.wait()
        assert gate.deliver("")

    decliner_task = asyncio.get_running_loop().create_task(decliner())
    session = ScriptedSession(
        [
            ProviderTurn(
                assistant_text="",
                tool_calls=[
                    ToolCall(id="q1", name="ask_user", arguments={"question": "Ok?", "options": ["a", "b", "c", "d"]})
                ],
            ),
            ProviderTurn(assistant_text="", tool_calls=[_create_call()]),
            ProviderTurn(assistant_text="done", tool_calls=[]),
        ]
    )
    log = EventLog()

    async def emit(event: RunEvent) -> None:
        await log(event)
        if event.type == "question":
            question_seen.set()

    runtime = AgentRuntime(
        session=session,
        tool_runtime=_noop_runtime(),
        emit=emit,
        interaction=gate,
    )
    await runtime.run(Llm.GPT_5_5_HIGH, [])
    await decliner_task
    executed = session.appended[0][0]
    assert executed.result.ok is True
    assert executed.result.summary["declined"] is True


@pytest.mark.asyncio
async def test_loop_has_no_step_ceiling() -> None:
    """The loop runs past the old 30-turn cap until the model finishes.

    Distinct arguments each turn (real long work), so stuck detection
    stays quiet while the budget ceiling is disabled.
    """
    calls = [
        ProviderTurn(
            assistant_text="",
            tool_calls=[_create_call(f"<html>v{i}</html>", f"c{i}")],
        )
        for i in range(45)
    ]
    calls.append(ProviderTurn(assistant_text="finally done", tool_calls=[]))
    session = ScriptedSession(calls)
    runtime = AgentRuntime(
        session=session,
        tool_runtime=_noop_runtime(),
        emit=EventLog(),
        config=RuntimeConfig(budget_usd=None),
    )
    result = await runtime.run(Llm.GPT_5_5_HIGH, [])
    assert result == "<html>v44</html>"
    assert runtime.status is RunStatus.COMPLETED


@pytest.mark.asyncio
async def test_multi_file_run_finalizes_self_contained() -> None:
    session = ScriptedSession(
        [
            ProviderTurn(
                assistant_text="",
                tool_calls=[
                    _create_call(
                        '<html><head><script src="main.js"></script></head>'
                        "<body></body></html>",
                        "c1",
                    ),
                    ToolCall(
                        id="c2",
                        name="create_file",
                        arguments={"path": "main.js", "content": "init();"},
                    ),
                ],
            ),
            ProviderTurn(assistant_text="done", tool_calls=[]),
        ]
    )
    runtime = AgentRuntime(
        session=session,
        tool_runtime=_noop_runtime(),
        emit=EventLog(),
        config=RuntimeConfig(budget_usd=None),
    )
    result = await runtime.run(Llm.GPT_5_5_HIGH, [])
    # The entry references main.js, so the returned document inlines it.
    assert "<script>\ninit();\n</script>" in result


class FlakySession:
    """Fails with transient provider errors, then succeeds."""

    def __init__(self, failures: int, exc: Exception) -> None:
        self.remaining = failures
        self.exc = exc
        self.calls = 0
        self.closed = False

    async def stream_turn(self, on_event):
        from agent.providers.base import StreamEvent

        self.calls += 1
        if self.remaining > 0:
            self.remaining -= 1
            raise self.exc
        await on_event(
            StreamEvent(type="assistant_delta", text="recovered")
        )
        return ProviderTurn(assistant_text="recovered", tool_calls=[])

    async def append_tool_results(self, turn, executed):
        return None

    def total_cost_usd(self):
        return None

    async def close(self):
        self.closed = True


@pytest.mark.asyncio
async def test_transient_provider_errors_are_retried() -> None:
    class RateLimit(Exception):
        pass

    session = FlakySession(2, RateLimit("rate limit exceeded, try later"))
    log = EventLog()

    class ShortDelays(RuntimeConfig):
        retry_delays = (0.01, 0.01, 0.01)

    runtime = AgentRuntime(
        session=session,
        tool_runtime=_noop_runtime(),
        emit=log,
        config=ShortDelays(),
    )
    result = await runtime.run(Llm.GPT_5_5_HIGH, [])
    assert result == "recovered"
    assert session.calls == 3
    # The user saw what happened.
    statuses = [e.message for e in log.events if e.type == "status"]
    assert any("retrying" in message for message in statuses)


@pytest.mark.asyncio
async def test_non_transient_errors_fail_fast() -> None:
    class AuthFail(Exception):
        pass

    session = FlakySession(3, AuthFail("invalid api key"))
    runtime = AgentRuntime(
        session=session,
        tool_runtime=_noop_runtime(),
        emit=EventLog(),
        config=RuntimeConfig(),
    )
    with pytest.raises(AuthFail):
        await runtime.run(Llm.GPT_5_5_HIGH, [])
    assert session.calls == 1


@pytest.mark.asyncio
async def test_retries_stop_after_limit() -> None:
    class RateLimit(Exception):
        pass

    session = FlakySession(10, RateLimit("rate limit"))
    runtime = AgentRuntime(
        session=session,
        tool_runtime=_noop_runtime(),
        emit=EventLog(),
        config=RuntimeConfig(provider_retries=1, retry_delays=(0.01,)),
    )
    with pytest.raises(RateLimit):
        await runtime.run(Llm.GPT_5_5_HIGH, [])
    assert session.calls == 2  # 1 initial + 1 retry
