"""The agent loop: stream a provider turn, execute tool calls, feed results
back, repeat — with a budget ceiling, a max-turn limit, stuck detection, and
mid-run user questions.

This is transport-agnostic: it emits typed RunEvents and depends on the
UserInteraction port. The engine facade adapts events to the WS protocol and
owns session/provider construction.
"""
import asyncio
import json
import uuid
from dataclasses import dataclass
from typing import Awaitable, Callable, List, Optional, cast

from codegen.utils import extract_html_content
from openai.types.chat import ChatCompletionMessageParam

from agent.providers.base import ExecutedToolCall, ProviderSession, StreamEvent
from agent.state import AgentFileState, ensure_str, seed_file_state_from_messages
from agent.tools import (
    AgentToolRuntime,
    extract_content_from_args,
    extract_path_from_args,
    summarize_tool_input,
)
from agent.tools.types import ToolCall, ToolExecutionResult
from agent.runtime.errors import (
    BudgetExceededError,
    MaxStepsExceededError,
    StuckLoopError,
)
from agent.runtime.events import (
    AssistantDeltaEvent,
    QuestionEvent,
    RunEvent,
    SetCodeEvent,
    ThinkingDeltaEvent,
    ToolResultEvent,
)
from agent.runtime.interaction import UserInteraction
from agent.runtime.preview import CodePreviewStreamer
from agent.runtime.statuses import RunStatus
from fs_logging.agent_runs import AgentRunRecorder
from llm import Llm

RunEventSink = Callable[[RunEvent], Awaitable[None]]
EventIdFactory = Callable[[str], str]


def _default_event_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


@dataclass
class RuntimeConfig:
    max_steps: int = 30
    # None disables the ceiling (unpriced models already report None).
    budget_usd: Optional[float] = None
    # Repeating an identical tool call this many times triggers a warning
    # injected into the tool result; the next threshold fails the run.
    stuck_warn_after: int = 3
    stuck_fail_after: int = 5
    event_id_factory: EventIdFactory = _default_event_id


class AgentRuntime:
    def __init__(
        self,
        session: ProviderSession,
        tool_runtime: AgentToolRuntime,
        emit: RunEventSink,
        recorder: Optional[AgentRunRecorder] = None,
        interaction: Optional[UserInteraction] = None,
        config: Optional[RuntimeConfig] = None,
        file_state: Optional[AgentFileState] = None,
    ) -> None:
        self.session = session
        self.tool_runtime = tool_runtime
        self.emit = emit
        self.recorder = recorder
        self.interaction = interaction
        self.config = config or RuntimeConfig()
        # The tool runtime owns the file state; adopting it here guarantees
        # the loop and the tools always mutate the same document.
        self.file_state = (
            file_state if file_state is not None else tool_runtime.file_state
        )
        self.status = RunStatus.RUNNING
        self._preview = CodePreviewStreamer(
            self.emit, self._record_stream_preview
        )
        self._last_signature: Optional[str] = None
        self._repeat_count = 0

    def _record_stream_preview(self, content_len: int) -> None:
        if self.recorder is not None:
            self.recorder.record_set_code(content_len, "stream_preview")

    async def run(self, model: Llm, prompt_messages: List[ChatCompletionMessageParam]) -> str:
        self.tool_runtime.input_images = extract_input_images(prompt_messages)
        seed_file_state_from_messages(self.file_state, prompt_messages)

        if self.recorder is not None:
            self.recorder.record_run_start(model, prompt_messages)

        try:
            result = await self._loop()
            self.status = RunStatus.COMPLETED
            return result
        except asyncio.CancelledError:
            self.status = RunStatus.CANCELLED
            raise
        except StuckLoopError:
            self.status = RunStatus.STUCK
            raise
        except BaseException:
            self.status = RunStatus.FAILED
            raise

    async def _loop(self) -> str:
        for _ in range(self.config.max_steps):
            finalized = await self._step()
            if finalized is not None:
                return finalized
        raise MaxStepsExceededError()

    async def _step(self) -> Optional[str]:
        """One provider turn; returns final content when the model is done."""
        assistant_event_id = self.config.event_id_factory("assistant")
        thinking_event_id = self.config.event_id_factory("thinking")

        async def on_event(event: StreamEvent) -> None:
            if self.recorder is not None:
                if event.type == "assistant_delta":
                    stream_event_id = assistant_event_id
                elif event.type == "thinking_delta":
                    stream_event_id = thinking_event_id
                else:
                    stream_event_id = event.tool_call_id
                self.recorder.record_stream_event(event, stream_event_id)

            if event.type == "assistant_delta":
                if event.text:
                    await self.emit(
                        AssistantDeltaEvent(
                            text=event.text, event_id=assistant_event_id
                        )
                    )
                return

            if event.type == "thinking_delta":
                if event.text:
                    await self.emit(
                        ThinkingDeltaEvent(
                            text=event.text, event_id=thinking_event_id
                        )
                    )
                return

            if event.type == "tool_call_delta":
                await self._handle_streamed_tool_delta(event)

        turn = await self.session.stream_turn(on_event)

        if not turn.tool_calls:
            return await self._finalize_response(turn.assistant_text)

        # Abort only when the run would otherwise continue: a run that just
        # produced its final answer is already paid for. Unpriced models
        # return None and are not bounded.
        spent = self.session.total_cost_usd()
        if (
            self.config.budget_usd is not None
            and spent is not None
            and spent > self.config.budget_usd
        ):
            raise BudgetExceededError()

        executed_tool_calls: List[ExecutedToolCall] = []
        for tool_call in turn.tool_calls:
            executed_tool_calls.append(await self._execute_tool(tool_call))

        await self.session.append_tool_results(turn, executed_tool_calls)
        return None

    async def _execute_tool(self, tool_call: ToolCall) -> ExecutedToolCall:
        tool_event_id = tool_call.id or self.config.event_id_factory("tool")
        if not self._preview.is_started(tool_event_id):
            await self._preview.start(
                tool_event_id,
                tool_call.name,
                summarize_tool_input(tool_call, self.file_state),
            )

        if tool_call.name == "create_file":
            content = extract_content_from_args(tool_call.arguments)
            if content:
                # Timing starts after the cosmetic preview stream, so tool
                # durations measure execution only.
                await self._preview.replay_complete(tool_event_id, content)

        if self.recorder is not None:
            self.recorder.record_tool_start(tool_event_id, tool_call)

        if tool_call.name == "ask_user":
            tool_result = await self._run_ask_user(tool_call, tool_event_id)
        else:
            tool_result = await self.tool_runtime.execute(tool_call)

        if self.recorder is not None:
            self.recorder.record_tool_end(tool_event_id, tool_call, tool_result)

        tool_result = self._check_stuck(tool_call, tool_result)

        if tool_result.updated_content:
            await self.emit(
                SetCodeEvent(
                    content=tool_result.updated_content, source="tool_result"
                )
            )
            if self.recorder is not None:
                self.recorder.record_set_code(
                    len(tool_result.updated_content), "tool_result"
                )

        await self.emit(
            ToolResultEvent(
                event_id=tool_event_id,
                name=tool_call.name,
                output=tool_result.summary,
                ok=tool_result.ok,
            )
        )
        return ExecutedToolCall(tool_call=tool_call, result=tool_result)

    async def _handle_streamed_tool_delta(self, event: StreamEvent) -> None:
        if event.type != "tool_call_delta" or event.tool_name != "create_file":
            return
        if not event.tool_call_id:
            return

        content = extract_content_from_args(event.tool_arguments)
        if content is None:
            return

        path = (
            extract_path_from_args(event.tool_arguments)
            or self.file_state.path
            or "index.html"
        )
        await self._preview.handle_streamed_args(
            event.tool_call_id, path, content
        )

    async def _run_ask_user(
        self, tool_call: ToolCall, tool_event_id: str
    ) -> ToolExecutionResult:
        question = ensure_str(tool_call.arguments.get("question")).strip()
        if not question:
            return ToolExecutionResult(
                ok=False,
                result={"error": "ask_user requires a non-empty question."},
                summary={"error": "Missing question"},
            )
        options: Optional[list[str]] = None
        raw_options = tool_call.arguments.get("options")
        if isinstance(raw_options, list):
            cleaned: list[str] = []
            for raw_option in cast(List[object], raw_options):
                if not isinstance(raw_option, (str, int, float)):
                    continue
                option = str(raw_option).strip()
                if option:
                    cleaned.append(option)
            if cleaned:
                options = cleaned

        if self.interaction is None:
            return ToolExecutionResult(
                ok=False,
                result={
                    "error": (
                        "ask_user is not available in this run; decide using "
                        "the available context."
                    )
                },
                summary={"error": "Questions unavailable"},
            )

        self.status = RunStatus.WAITING_FOR_USER
        try:
            await self.emit(
                QuestionEvent(
                    event_id=tool_event_id,
                    question=question,
                    options=options,
                )
            )
            answer = await self.interaction.ask(
                question, options=options, context=None
            )
        finally:
            self.status = RunStatus.RUNNING

        if not answer.strip():
            return ToolExecutionResult(
                ok=True,
                result={
                    "answer": "",
                    "note": (
                        "The user did not provide an answer; proceed with "
                        "your best judgment."
                    ),
                },
                summary={"question": question, "declined": True},
            )
        return ToolExecutionResult(
            ok=True,
            result={"answer": answer},
            summary={"question": question, "answer": answer},
        )

    def _check_stuck(
        self, tool_call: ToolCall, tool_result: ToolExecutionResult
    ) -> ToolExecutionResult:
        signature = f"{tool_call.name}:{json.dumps(tool_call.arguments, sort_keys=True, default=str)}"
        if signature == self._last_signature:
            self._repeat_count += 1
        else:
            self._last_signature = signature
            self._repeat_count = 1

        if self._repeat_count >= self.config.stuck_fail_after:
            raise StuckLoopError(tool_call.name, self._repeat_count)
        if self._repeat_count >= self.config.stuck_warn_after:
            warning = (
                f"Warning: you already made this exact {tool_call.name} call "
                f"{self._repeat_count} times. It produces the same result. "
                "Change approach, or finish with your best result."
            )
            tool_result.result = {
                **tool_result.result,
                "repeat_warning": warning,
            }
            tool_result.summary = {
                **tool_result.summary,
                "repeat_warning": warning,
            }
        return tool_result

    async def _finalize_response(self, assistant_text: str) -> str:
        if self.file_state.content:
            return self.file_state.content

        html = extract_html_content(assistant_text)
        if html:
            self.file_state.content = html
            await self.emit(SetCodeEvent(content=html, source="finalize"))
            if self.recorder is not None:
                self.recorder.record_set_code(len(html), "finalize")

        return self.file_state.content


def extract_input_images(
    prompt_messages: List[ChatCompletionMessageParam],
) -> List[str]:
    """Collect still-image data URLs from the prompt for asset extraction.

    Video parts use the OpenAI-compatible `image_url` shape too, but
    extract_assets can only crop still-image data URLs. Keep non-image media
    out of the tool runtime so video-only prompts do not expose a tool that
    is guaranteed to fail.
    """
    images: List[str] = []
    for message in prompt_messages:
        content = message.get("content")
        if not isinstance(content, list):
            continue
        for part in content:
            if not isinstance(part, dict) or part.get("type") != "image_url":
                continue
            image_url = part.get("image_url")
            if not isinstance(image_url, dict):
                continue
            url = cast(object, image_url.get("url"))
            if (
                isinstance(url, str)
                and url.startswith("data:image/")
                and "," in url
            ):
                images.append(url)
    return images
