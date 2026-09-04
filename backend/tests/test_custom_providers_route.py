import pytest
from types import SimpleNamespace
from typing import Any

from routes import custom_providers
from routes.custom_providers import CustomProviderTestRequest


class _FakeStream:
    def __init__(self) -> None:
        self._events: list[Any] = []

    def __aiter__(self) -> "_FakeStream":
        return self

    async def __anext__(self) -> Any:
        if not self._events:
            raise StopAsyncIteration
        return self._events.pop(0)


class FakeResponses:
    def __init__(self, parent: "FakeOpenAIClient") -> None:
        self._parent = parent

    async def create(self, **kwargs: Any) -> Any:
        self._parent.calls.append(("responses.create", kwargs))
        return _FakeStream()


class FakeChatCompletions:
    def __init__(self, parent: "FakeOpenAIClient") -> None:
        self._parent = parent

    async def create(self, **kwargs: Any) -> Any:
        self._parent.calls.append(("chat.completions.create", kwargs))
        return SimpleNamespace(choices=[])


class FakeModels:
    def __init__(self, parent: "FakeOpenAIClient") -> None:
        self._parent = parent

    async def list(self) -> Any:
        self._parent.calls.append(("models.list", {}))
        return SimpleNamespace(
            data=[
                SimpleNamespace(id="model-b"),
                SimpleNamespace(id="model-a"),
                SimpleNamespace(id="model-a"),
            ]
        )


class FakeOpenAIClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.closed = False
        # Typed as Any so the error-injection tests can swap attributes out.
        self.chat: Any = SimpleNamespace(completions=FakeChatCompletions(self))
        self.responses: Any = FakeResponses(self)
        self.models: Any = FakeModels(self)

    async def close(self) -> None:
        self.closed = True


@pytest.mark.asyncio
async def test_chat_completions_probe_succeeds_and_discovers_models(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = FakeOpenAIClient()
    monkeypatch.setattr(
        "routes.custom_providers.AsyncOpenAI", lambda **_: fake
    )

    result = await custom_providers.test_custom_provider(
        CustomProviderTestRequest(
            baseUrl="https://provider.example.com/v1/",
            apiKey="key",
            modelId="model-a",
            protocol="chat_completions",
            headers={"X-Team": "core"},
        )
    )

    assert result.ok is True
    assert result.models == ["model-a", "model-b"]
    assert result.detail is not None and "chat/completions" in result.detail
    assert fake.calls[0] == ("models.list", {})
    probe_name, probe_kwargs = fake.calls[1]
    assert probe_name == "chat.completions.create"
    assert probe_kwargs["model"] == "model-a"
    assert fake.closed is True


@pytest.mark.asyncio
async def test_responses_probe_uses_responses_endpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = FakeOpenAIClient()
    monkeypatch.setattr("routes.custom_providers.AsyncOpenAI", lambda **_: fake)

    result = await custom_providers.test_custom_provider(
        CustomProviderTestRequest(
            baseUrl="https://provider.example.com/v1",
            modelId="model-a",
            protocol="responses",
        )
    )

    assert result.ok is True
    assert fake.calls[1][0] == "responses.create"


@pytest.mark.asyncio
async def test_probe_reports_connection_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = FakeOpenAIClient()
    monkeypatch.setattr("routes.custom_providers.AsyncOpenAI", lambda **_: fake)

    import openai

    async def raise_connection_error(**_: Any) -> Any:
        raise openai.APIConnectionError(
            message="Connection error.",
            request=SimpleNamespace(),  # type: ignore[arg-type]
        )

    # A connection failure on the probe call surfaces as a friendly error
    # string instead of an unhandled exception.
    fake.chat = SimpleNamespace(completions=SimpleNamespace(create=raise_connection_error))
    fake.responses = SimpleNamespace(create=raise_connection_error)

    result = await custom_providers.test_custom_provider(
        CustomProviderTestRequest(
            baseUrl="https://provider.example.com/v1",
            modelId="model-a",
            protocol="chat_completions",
        )
    )

    assert result.ok is False
    assert result.error is not None and "Could not reach the provider" in result.error


@pytest.mark.asyncio
async def test_probe_rejects_invalid_base_url() -> None:
    result = await custom_providers.test_custom_provider(
        CustomProviderTestRequest(baseUrl="not-a-url", modelId="model-a")
    )

    assert result.ok is False
    assert result.error is not None and "http" in result.error
