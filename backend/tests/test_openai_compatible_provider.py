import json
from types import SimpleNamespace
from typing import Any

import pytest

from agent.providers.openai_compatible import OpenAICompatibleProviderSession
from agent.tools import ToolCall, ToolExecutionResult
from agent.providers.base import ExecutedToolCall
from llm import Llm
from routes.generate_code import ModelSelectionStage


class FakeCompletions:
    def __init__(self, message: Any) -> None:
        self.message = message
        self.request: dict[str, Any] | None = None

    async def create(self, **kwargs: Any) -> Any:
        self.request = kwargs
        return SimpleNamespace(choices=[SimpleNamespace(message=self.message)])


class FakeMessage:
    content = ""

    def __init__(self) -> None:
        self.tool_calls = [
            SimpleNamespace(
                type="function",
                id="call-1",
                function=SimpleNamespace(
                    name="create_file",
                    arguments=json.dumps({"path": "index.html", "content": "ok"}),
                ),
            )
        ]

    def model_dump(self, **_: Any) -> dict[str, Any]:
        return {
            "role": "assistant",
            "tool_calls": [
                {
                    "id": "call-1",
                    "type": "function",
                    "function": {
                        "name": "create_file",
                        "arguments": json.dumps(
                            {"path": "index.html", "content": "ok"}
                        ),
                    },
                }
            ],
        }


class FakeClient:
    def __init__(self) -> None:
        self.completions = FakeCompletions(FakeMessage())
        self.chat = SimpleNamespace(completions=self.completions)

    async def close(self) -> None:
        pass


@pytest.mark.asyncio
async def test_custom_provider_uses_chat_completions_and_custom_model() -> None:
    client = FakeClient()
    session = OpenAICompatibleProviderSession(
        client=client,  # type: ignore[arg-type]
        model_name="custom-model",
        prompt_messages=[{"role": "user", "content": "build"}],
        tools=[
            {
                "type": "function",
                "name": "create_file",
                "description": "Create a file",
                "parameters": {"type": "object", "properties": {}},
                "strict": True,
            }
        ],
    )

    turn = await session.stream_turn(lambda event: _ignore_event(event))

    assert client.completions.request is not None
    assert client.completions.request["model"] == "custom-model"
    assert client.completions.request["tools"] == [
        {
            "type": "function",
            "function": {
                "name": "create_file",
                "description": "Create a file",
                "parameters": {"type": "object", "properties": {}},
                "strict": True,
            },
        }
    ]
    assert turn.tool_calls[0].name == "create_file"

    result = ToolExecutionResult(
        ok=True,
        result={"status": "ok"},
        summary={"status": "ok"},
    )
    await session.append_tool_results(
        turn,
        [ExecutedToolCall(ToolCall("call-1", "create_file", {}), result)],
    )
    assert session._messages[-1]["role"] == "tool"


async def _ignore_event(_: Any) -> None:
    pass


@pytest.mark.asyncio
async def test_custom_model_is_selected_for_every_variant() -> None:
    async def throw_error(_: str) -> None:
        raise AssertionError("unexpected error")

    models = await ModelSelectionStage(throw_error).select_models(
        generation_type="create",
        input_mode="image",
        openai_api_key=None,
        anthropic_api_key=None,
        openai_compatible_model="custom-model",
    )

    assert models
    assert set(models) == {Llm.OPENAI_COMPATIBLE}
