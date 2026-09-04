"""Compatibility facade over AgentRuntime.

The WS pipeline (routes/generate_code.py), evals, and tests construct
AgentEngine and call ``run(model, prompt_messages)``; internally the work now
happens in agent.runtime.loop.AgentRuntime, which is transport-agnostic and
emits typed RunEvents. This adapter converts RunEvents back into the legacy
send_message protocol so the existing frontend contract is untouched.
"""
import traceback
from typing import Any, Awaitable, Callable, Dict, List, Optional

from openai.types.chat import ChatCompletionMessageParam

from agent.providers.custom import CustomProvider
from agent.providers.factory import create_provider_session
from agent.runtime.errors import BudgetExceededError, EmptyOutputError  # noqa: F401
from agent.runtime.interaction import UserInteraction
from agent.runtime.loop import (
    AgentRuntime,
    RuntimeConfig,
    extract_input_images,
)
from agent.state import AgentFileState
from agent.tools import AgentToolRuntime
from config import GENERATION_MAX_COST_USD
from fs_logging.agent_runs import AgentRunRecorder
from llm import Llm

SendMessage = Callable[
    [str, Optional[str], int, Optional[Dict[str, Any]], Optional[str]],
    Awaitable[None],
]


class AgentEngine:
    def __init__(
        self,
        send_message: SendMessage,
        variant_index: int,
        openai_api_key: Optional[str],
        openai_base_url: Optional[str],
        anthropic_api_key: Optional[str],
        gemini_api_key: Optional[str],
        replicate_api_key: Optional[str],
        should_generate_images: bool,
        should_extract_assets: bool = True,
        asset_base_url: str = "",
        initial_file_state: Optional[Dict[str, str]] = None,
        option_codes: Optional[List[str]] = None,
        recorder: Optional[AgentRunRecorder] = None,
        openai_compatible: Optional[CustomProvider] = None,
        interaction: Optional[UserInteraction] = None,
    ):
        self.send_message = send_message
        self.variant_index = variant_index
        self.recorder = recorder
        self.openai_api_key = openai_api_key
        self.openai_base_url = openai_base_url
        self.anthropic_api_key = anthropic_api_key
        self.gemini_api_key = gemini_api_key
        self.replicate_api_key = replicate_api_key
        self.should_generate_images = should_generate_images
        self.should_extract_assets = should_extract_assets
        self.openai_compatible = openai_compatible
        self.interaction = interaction
        self._runtime: Optional[AgentRuntime] = None

        self.file_state = AgentFileState()
        if initial_file_state and initial_file_state.get("content"):
            self.file_state.path = initial_file_state.get("path") or "index.html"
            self.file_state.content = initial_file_state["content"]

        self.tool_runtime = AgentToolRuntime(
            file_state=self.file_state,
            should_generate_images=should_generate_images,
            openai_api_key=openai_api_key,
            openai_base_url=openai_base_url,
            gemini_api_key=gemini_api_key,
            replicate_api_key=replicate_api_key,
            asset_base_url=asset_base_url,
            option_codes=option_codes,
        )

    @property
    def status(self) -> str:
        if self._runtime is not None:
            return self._runtime.status.value
        return "running"

    async def _emit_run_event(self, event: Any) -> None:
        """Adapt a typed RunEvent to the legacy send_message protocol."""
        if event.type == "set_code":
            await self.send_message(
                "setCode", event.content, self.variant_index, None, None
            )
        elif event.type == "thinking_delta":
            await self.send_message(
                "thinking",
                event.text,
                self.variant_index,
                None,
                event.event_id,
            )
        elif event.type == "assistant_delta":
            await self.send_message(
                "assistant",
                event.text,
                self.variant_index,
                None,
                event.event_id,
            )
        elif event.type == "tool_start":
            await self.send_message(
                "toolStart",
                None,
                self.variant_index,
                {"name": event.name, "input": event.input},
                event.event_id,
            )
        elif event.type == "tool_result":
            await self.send_message(
                "toolResult",
                None,
                self.variant_index,
                {"name": event.name, "output": event.output, "ok": event.ok},
                event.event_id,
            )
        elif event.type == "question":
            # Questions ride the same WS channel; the legacy protocol has no
            # consumer for them yet, so surface as a status line. The project
            # transport (phase 3) handles them natively.
            await self.send_message(
                "status",
                f"Waiting for your answer: {event.question}",
                self.variant_index,
                {
                    "questionId": event.event_id,
                    "question": event.question,
                    "options": event.options,
                },
                event.event_id,
            )
        elif event.type == "status":
            await self.send_message(
                "status", event.message, self.variant_index, None, None
            )

    async def run(
        self, model: Llm, prompt_messages: List[ChatCompletionMessageParam]
    ) -> str:
        if self.recorder is not None:
            self.recorder.record_run_start(model, prompt_messages)

        session = create_provider_session(
            model=model,
            prompt_messages=prompt_messages,
            should_generate_images=self.should_generate_images,
            openai_api_key=self.openai_api_key,
            openai_base_url=self.openai_base_url,
            anthropic_api_key=self.anthropic_api_key,
            gemini_api_key=self.gemini_api_key,
            replicate_api_key=self.replicate_api_key,
            # Only advertise extraction when the request actually contains a
            # still image the runtime can crop. In particular, Gemini videos
            # share the image_url message shape but are not valid extractor
            # inputs.
            should_extract_assets=(
                self.should_extract_assets
                and bool(extract_input_images(prompt_messages))
            ),
            recorder=self.recorder,
            custom_provider=self.openai_compatible,
            custom_model_index=self.variant_index,
            ask_user_enabled=self.interaction is not None,
        )
        try:
            runtime = AgentRuntime(
                session=session,
                tool_runtime=self.tool_runtime,
                emit=self._emit_run_event,
                recorder=self.recorder,
                interaction=self.interaction,
                config=RuntimeConfig(budget_usd=GENERATION_MAX_COST_USD),
                file_state=self.file_state,
            )
            self._runtime = runtime
            result = await runtime.run(model, prompt_messages)
            if not result:
                raise EmptyOutputError()
            if self.recorder is not None:
                await self.recorder.record_run_end("completed", final_html=result)
            return result
        # BaseException so cancellation (client disconnect) still finalizes
        # the run record instead of leaving it stuck at "running".
        except BaseException as exc:
            if self.recorder is not None:
                await self.recorder.record_run_end(
                    "failed",
                    error="".join(
                        traceback.format_exception_only(type(exc), exc)
                    ).strip(),
                )
            raise
        finally:
            await session.close()
