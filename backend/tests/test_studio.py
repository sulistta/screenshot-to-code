"""Tests for the research tool and the studio prompt override."""
import httpx
import pytest

from agent.tools.research import _extract_text, fetch_research, is_public_http_url
from projects.manager import build_run_prompts, RunRequest
from projects.store import ProjectStore, TranscriptMessage
from agent.workspace import Workspace
from prompts.studio_system_prompt import STUDIO_SYSTEM_PROMPT


# --- SSRF guard ---------------------------------------------------------------


@pytest.mark.parametrize(
    "url,expected",
    [
        ("https://example.com/docs", True),
        ("http://example.com", True),
        ("ftp://example.com", False),
        ("https://localhost/x", False),
        ("https://127.0.0.1/x", False),
        ("https://10.0.0.1/x", False),
        ("https://192.168.1.1/x", False),
        ("https://172.16.0.9/x", False),
        ("https://8.8.8.8/x", True),
        ("https://machine.local/x", False),
    ],
)
def test_is_public_http_url(url: str, expected: bool) -> None:
    assert is_public_http_url(url) is expected


# --- text extraction -----------------------------------------------------------


def test_extract_text_prefers_main_and_drops_scripts() -> None:
    html = """
    <html><head><title>Docs Home</title></head><body>
    <script>var x = 1;</script>
    <nav>Menu junk</nav>
    <main>
      <h1>Getting started</h1>
      <p>Install the package first.</p>
    </main>
    </body></html>
    """
    title, text = _extract_text(html)
    assert title == "Docs Home"
    assert "Install the package first." in text
    assert "var x" not in text
    assert "Menu junk" not in text


# --- fetch -----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fetch_research_rejects_private_urls() -> None:
    outcome = await fetch_research("https://127.0.0.1/secret")
    assert outcome["ok"] is False


@pytest.mark.asyncio
async def test_fetch_research_extracts_page(monkeypatch: pytest.MonkeyPatch) -> None:
    html = "<html><title>Py3 docs</title><body><main><p>Hello world content</p></main></body></html>"

    class FakeResponse:
        status_code = 200
        headers = {"content-type": "text/html"}
        text = html
        url = "https://docs.example.com/"

    class FakeClient:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        async def __aenter__(self) -> "FakeClient":
            return self

        async def __aexit__(self, *args: object) -> None:
            return None

        async def get(self, url: str, **kwargs: object) -> FakeResponse:
            return FakeResponse()

    class FakeAsyncClient(FakeClient):
        pass

    monkeypatch.setattr(
        "agent.tools.research.httpx.AsyncClient", FakeAsyncClient
    )
    outcome = await fetch_research("https://docs.example.com/")
    assert outcome["ok"] is True
    assert outcome["title"] == "Py3 docs"
    assert "Hello world content" in outcome["content"]


@pytest.mark.asyncio
async def test_fetch_research_handles_http_error() -> None:
    class FailingClient:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        async def __aenter__(self) -> "FailingClient":
            return self

        async def __aexit__(self, *args: object) -> None:
            return None

        async def get(self, url: str, **kwargs: object) -> None:
            raise httpx.ConnectError("nope")

    monkeypatch_target = httpx.AsyncClient
    original = monkeypatch_target
    monkeypatch_target = FailingClient  # noqa: F841 — replaced below
    import agent.tools.research as research

    research.httpx.AsyncClient = FailingClient  # type: ignore[assignment]
    try:
        outcome = await fetch_research("https://example.com/x")
    finally:
        research.httpx.AsyncClient = original
    assert outcome["ok"] is False


# --- studio prompt integration ------------------------------------------------------


@pytest.mark.asyncio
async def test_run_prompts_use_studio_system_prompt(tmp_path) -> None:
    store = ProjectStore(tmp_path / "projects")
    meta = store.create(name="p", brief="b")
    workspace = store.load_workspace(meta.id)
    messages = await build_run_prompts(
        workspace,
        RunRequest(text="a bold landing page", settings={}),
    )
    assert messages[0]["role"] == "system"
    assert messages[0]["content"] == STUDIO_SYSTEM_PROMPT
    joined = str(messages[-1]["content"])
    assert "a bold landing page" in joined


@pytest.mark.asyncio
async def test_run_prompts_replay_transcript_history(tmp_path) -> None:
    store = ProjectStore(tmp_path / "projects")
    meta = store.create(name="p", brief="b")
    workspace = Workspace(content="<html>existing</html>")
    history = [
        TranscriptMessage(role="user", text="first request"),
        TranscriptMessage(role="assistant", text="built it", run_id="r1"),
    ]
    messages = await build_run_prompts(
        workspace,
        RunRequest(text="make it darker", settings={}),
        history=history,
    )
    joined = " ".join(str(m.get("content")) for m in messages)
    assert "first request" in joined
    assert "built it" in joined
    assert "make it darker" in joined


@pytest.mark.asyncio
async def test_studio_prompt_leaves_standard_flow_untouched(tmp_path) -> None:
    """The standard single-shot flow keeps its own system prompt."""
    from prompts.pipeline import build_prompt_messages
    from prompts.system_prompt import SYSTEM_PROMPT

    messages = await build_prompt_messages(
        stack="html_tailwind",
        input_mode="text",
        generation_type="create",
        prompt={"text": "hi", "images": [], "videos": []},
        history=[],
        system_prompt_override=STUDIO_SYSTEM_PROMPT,
    )
    assert messages[0]["content"] == STUDIO_SYSTEM_PROMPT

    messages_standard = await build_prompt_messages(
        stack="html_tailwind",
        input_mode="text",
        generation_type="create",
        prompt={"text": "hi", "images": [], "videos": []},
        history=[],
    )
    assert messages_standard[0]["content"] == SYSTEM_PROMPT
