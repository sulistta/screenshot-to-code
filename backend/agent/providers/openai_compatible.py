import json
from typing import Any, Dict, List

from openai import AsyncOpenAI
from openai.types.chat import ChatCompletionMessageParam

from agent.providers.base import ExecutedToolCall, EventSink, ProviderTurn, StreamEvent
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
            tools=self._tools,
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
