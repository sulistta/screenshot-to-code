import json
from typing import Any, Dict, List, cast

from openai import AsyncOpenAI
from openai.types.chat import ChatCompletionMessageParam

from agent.providers.base import ExecutedToolCall, EventSink, ProviderTurn, StreamEvent
from agent.providers.openai import (
    OpenAIResponsesParseState,
    _build_provider_turn,
    _convert_message_to_responses_input,
    parse_event,
)
from agent.tools import ToolCall


class OpenAICompatibleProviderSession:
    """Adapter for providers implementing OpenAI Chat Completions + tools."""

    def __init__(
        self,
        client: AsyncOpenAI,
        model_name: str,
        prompt_messages: List[ChatCompletionMessageParam],
        tools: List[Dict[str, Any]],
    ) -> None:
        self._client = client
        self._model_name = model_name
        self._messages: List[Any] = list(prompt_messages)
        # The core OpenAI provider uses the Responses API, whose function
        # definitions are flat. Chat Completions requires the same definition
        # nested under `function`.
        self._tools = [
            {
                "type": "function",
                "function": {
                    key: value
                    for key, value in tool.items()
                    if key != "type"
                },
            }
            for tool in tools
        ]

    async def stream_turn(self, on_event: EventSink) -> ProviderTurn:
        response = await self._client.chat.completions.create(
            model=self._model_name,
            messages=self._messages,
            tools=self._tools,  # type: ignore[arg-type]
            tool_choice="auto",
        )
        message = response.choices[0].message
        assistant_text = message.content or ""
        if assistant_text:
            await on_event(StreamEvent(type="assistant_delta", text=assistant_text))

        tool_calls: list[ToolCall] = []
        for call in message.tool_calls or []:
            if call.type != "function":
                continue
            try:
                arguments = json.loads(call.function.arguments or "{}")
            except json.JSONDecodeError:
                arguments = {}
            tool_calls.append(
                ToolCall(id=call.id, name=call.function.name, arguments=arguments)
            )

        return ProviderTurn(
            assistant_text=assistant_text,
            tool_calls=tool_calls,
            assistant_turn=message.model_dump(exclude_none=True),
        )

    async def append_tool_results(
        self,
        turn: ProviderTurn,
        executed_tool_calls: list[ExecutedToolCall],
    ) -> None:
        self._messages.append(turn.assistant_turn)
        for executed in executed_tool_calls:
            self._messages.append(
                {
                    "role": "tool",
                    "tool_call_id": executed.tool_call.id,
                    "content": json.dumps(executed.result.result),
                }
            )

    def total_cost_usd(self) -> None:
        return None

    async def close(self) -> None:
        await self._client.close()


class OpenAICompatibleResponsesProviderSession:
    """Adapter for custom providers implementing the OpenAI Responses API.

    Some compatible endpoints expose /v1/responses instead of
    /v1/chat/completions; the settings UI picks the wire protocol per
    provider. Tool definitions and event parsing are shared with the
    first-party OpenAI session.
    """

    def __init__(
        self,
        client: AsyncOpenAI,
        model_name: str,
        prompt_messages: List[ChatCompletionMessageParam],
        tools: List[Dict[str, Any]],
    ) -> None:
        self._client = client
        self._model_name = model_name
        # Responses input items (text/image parts) instead of chat messages;
        # the list grows with assistant output items and tool results.
        self._input_items: List[Dict[str, Any]] = [
            _convert_message_to_responses_input(message) for message in prompt_messages
        ]
        # serialize_openai_tools already emits the flat Responses shape.
        self._tools = list(tools)

    async def stream_turn(self, on_event: EventSink) -> ProviderTurn:
        state = OpenAIResponsesParseState()
        stream = cast(Any, await self._client.responses.create(
            model=self._model_name,
            input=self._input_items,  # type: ignore[arg-type]
            tools=self._tools,  # type: ignore[arg-type]
            tool_choice="auto",
            stream=True,
        ))
        async for event in stream:  # type: ignore
            await parse_event(event, state, on_event)
        return _build_provider_turn(state)

    async def append_tool_results(
        self,
        turn: ProviderTurn,
        executed_tool_calls: list[ExecutedToolCall],
    ) -> None:
        # Replay only message/function_call items; provider-specific items
        # (e.g. reasoning entries) are not valid input for every endpoint.
        assistant_items: List[Dict[str, Any]] = []
        for item in cast(List[Any], turn.assistant_turn or []):
            if isinstance(item, dict) and item.get("type") in (
                "message",
                "function_call",
            ):
                assistant_items.append(item)
        self._input_items.extend(assistant_items)
        for executed in executed_tool_calls:
            self._input_items.append(
                {
                    "type": "function_call_output",
                    "call_id": executed.tool_call.id,
                    "output": json.dumps(executed.result.result),
                }
            )

    def total_cost_usd(self) -> None:
        return None

    async def close(self) -> None:
        await self._client.close()
