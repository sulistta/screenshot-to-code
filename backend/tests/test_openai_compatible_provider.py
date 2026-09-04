import json
from types import SimpleNamespace
from typing import Any

import pytest

from agent.providers.custom import CustomProvider, resolve_active_custom_provider
from agent.providers.openai_compatible import (
    OpenAICompatibleProviderSession,
    OpenAICompatibleResponsesProviderSession,
)
from agent.tools import ToolCall, ToolExecutionResult
from agent.providers.base import ExecutedToolCall
from llm import Llm
from routes.generate_code import ModelSelectionStage


def _custom_provider() -> CustomProvider:
    return CustomProvider(
        id="test-provider",
        name="Test provider",
        base_url="https://provider.example.com/v1",
        api_key=None,
        protocol="chat_completions",
        models=["custom-model"],
    )


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
        custom_provider=_custom_provider(),
    )

    assert models
    assert set(models) == {Llm.OPENAI_COMPATIBLE}


@pytest.mark.asyncio
async def test_custom_provider_variants_cycle_across_models() -> None:
    async def throw_error(_: str) -> None:
        raise AssertionError("unexpected error")

    provider = CustomProvider(
        id="test-provider",
        name="Test provider",
        base_url="https://provider.example.com/v1",
        api_key=None,
        protocol="chat_completions",
        models=["model-a", "model-b"],
    )
    models = await ModelSelectionStage(throw_error).select_models(
        generation_type="create",
        input_mode="image",
        openai_api_key=None,
        anthropic_api_key=None,
        custom_provider=provider,
    )

    assert len(models) == 4
    assert set(models) == {Llm.OPENAI_COMPATIBLE}


def test_resolve_active_custom_provider_selects_enabled_entry() -> None:
    provider = resolve_active_custom_provider(
        [
            {
                "id": "gmi",
                "name": "GMICloud",
                "baseUrl": "https://api.gmi.example/v1/",
                "apiKey": "  ",
                "protocol": "chat_completions",
                "models": [{"id": "qwen3-coder", "name": "Qwen3 Coder"}],
                "headers": {"X-Team": "core"},
                "enabled": True,
            }
        ],
        "gmi",
    )

    assert provider is not None
    assert provider.base_url == "https://api.gmi.example/v1"
    assert provider.models == ["qwen3-coder"]
    assert provider.headers == {"X-Team": "core"}
    assert provider.protocol == "chat_completions"


def test_resolve_active_custom_provider_without_selection_is_none() -> None:
    providers = [{"id": "gmi", "name": "GMICloud", "baseUrl": "https://x/v1", "models": ["m"], "enabled": False}]

    assert resolve_active_custom_provider(providers, None) is None
    with pytest.raises(ValueError, match="disabled"):
        resolve_active_custom_provider(providers, "gmi")
    with pytest.raises(ValueError, match="no longer available"):
        resolve_active_custom_provider(providers, "missing")


def test_resolve_active_custom_provider_rejects_invalid_entry() -> None:
    with pytest.raises(ValueError, match="Base URL"):
        resolve_active_custom_provider(
            [{"id": "bad", "name": "Bad", "baseUrl": "ftp://x", "models": ["m"], "enabled": True}],
            "bad",
        )


class _FakeResponsesStream:
    def __init__(self, events: list[Any]) -> None:
        self._events = events

    def __aiter__(self) -> "_FakeResponsesStream":
        return self

    async def __anext__(self) -> Any:
        if not self._events:
            raise StopAsyncIteration
        return self._events.pop(0)


class FakeResponsesClient:
    def __init__(self, events: list[Any]) -> None:
        self.events = events
        self.request: dict[str, Any] | None = None
        self.responses = SimpleNamespace(create=self._create)

    async def _create(self, **kwargs: Any) -> Any:
        self.request = kwargs
        return _FakeResponsesStream(list(self.events))

    async def close(self) -> None:
        pass


@pytest.mark.asyncio
async def test_responses_protocol_session_parses_text_and_tool_calls() -> None:
    client = FakeResponsesClient(
        [
            SimpleNamespace(type="response.output_text.delta", delta="hello"),
            SimpleNamespace(
                type="response.output_item.done",
                output_index=0,
                item={
                    "type": "function_call",
                    "id": "fc_1",
                    "call_id": "call-1",
                    "name": "create_file",
                    "arguments": json.dumps({"path": "index.html", "content": "ok"}),
                },
            ),
        ]
    )
    session = OpenAICompatibleResponsesProviderSession(
        client=client,  # type: ignore[arg-type]
        model_name="custom-model",
        prompt_messages=[
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "build"},
        ],
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

    deltas: list[str] = []

    async def on_event(event: Any) -> None:
        if event.type == "assistant_delta":
            deltas.append(event.text)

    turn = await session.stream_turn(on_event)

    assert client.request is not None
    assert client.request["model"] == "custom-model"
    assert client.request["tools"][0]["name"] == "create_file"
    assert client.request["input"][0] == {"role": "system", "content": "sys"}
    assert turn.assistant_text == "hello"
    assert deltas == ["hello"]
    assert turn.tool_calls[0].id == "call-1"
    assert turn.tool_calls[0].name == "create_file"
    assert turn.tool_calls[0].arguments == {"path": "index.html", "content": "ok"}

    result = ToolExecutionResult(ok=True, result={"status": "ok"}, summary={"status": "ok"})
    await session.append_tool_results(
        turn,
        [ExecutedToolCall(ToolCall("call-1", "create_file", {}), result)],
    )
    assert session._input_items[-2]["type"] == "function_call"
    assert session._input_items[-1] == {
        "type": "function_call_output",
        "call_id": "call-1",
        "output": json.dumps({"status": "ok"}),
    }
