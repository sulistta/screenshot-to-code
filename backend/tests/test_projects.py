"""Tests for the durable project layer: store round-trips, the run manager
(with a fake provider session), and the HTTP routes.
"""
import asyncio
import json
from pathlib import Path
from typing import Any, List, Optional

import pytest
from openai.types.chat import ChatCompletionMessageParam

from agent.providers.base import EventSink, ExecutedToolCall, ProviderTurn
from agent.tools.types import ToolCall
from projects.manager import (
    ProjectRunManager,
    RunAlreadyActive,
    RunRequest,
    build_run_prompts,
)
from projects.store import ProjectStore, TranscriptMessage


# --- store -------------------------------------------------------------------


def test_project_store_round_trip(tmp_path: Path) -> None:
    store = ProjectStore(tmp_path / "projects")
    meta = store.create(name="Tea shop", brief="Landing page for Kettle & Co.")
    assert meta.name == "Tea shop"
    assert store.get(meta.id).brief == "Landing page for Kettle & Co."
    assert [p.id for p in store.list()] == [meta.id]

    store.update(meta.id, name="Kettle & Co")
    assert store.get(meta.id).name == "Kettle & Co"

    # Workspace persistence
    workspace = store.load_workspace(meta.id)
    workspace.write("index.html", "<html>hi</html>")
    workspace.write("assets/theme.css", "body{}")
    store.save_workspace(meta.id, workspace)
    reloaded = store.load_workspace(meta.id)
    assert reloaded.read("index.html") == "<html>hi</html>"
    assert reloaded.read("assets/theme.css") == "body{}"

    # Transcript
    store.append_transcript_message(
        meta.id, TranscriptMessage(role="user", text="build it")
    )
    store.append_transcript_message(
        meta.id, TranscriptMessage(role="assistant", text="done", run_id="r1")
    )
    transcript = store.read_transcript(meta.id)
    assert [m.role for m in transcript] == ["user", "assistant"]
    assert transcript[1].run_id == "r1"

    store.delete(meta.id)
    with pytest.raises(KeyError):
        store.get(meta.id)


# --- run manager ---------------------------------------------------------------


class FakeSession:
    """Scripted turns; final text is streamed as a delta like real providers."""

    def __init__(self, turns: List[ProviderTurn]) -> None:
        self.turns = list(turns)
        self.closed = False

    async def stream_turn(self, on_event: EventSink) -> ProviderTurn:
        turn = self.turns.pop(0)
        if turn.assistant_text and not turn.tool_calls:
            from agent.providers.base import StreamEvent

            await on_event(
                StreamEvent(type="assistant_delta", text=turn.assistant_text)
            )
        return turn

    async def append_tool_results(
        self,
        turn: ProviderTurn,
        executed_tool_calls: List[ExecutedToolCall],
    ) -> None:
        return None

    def total_cost_usd(self) -> Optional[float]:
        return None

    async def close(self) -> None:
        self.closed = True


def _install_fake_session(
    monkeypatch: pytest.MonkeyPatch, turns: List[ProviderTurn]
) -> FakeSession:
    session = FakeSession(turns)

    def fake_create(**kwargs: Any) -> FakeSession:
        return session

    monkeypatch.setattr(
        "projects.manager.create_provider_session", fake_create
    )
    return session


@pytest.mark.asyncio
async def test_manager_run_completes_and_persists(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = ProjectStore(tmp_path / "projects")
    meta = store.create(name="p", brief="b")
    manager = ProjectRunManager(store)
    session = _install_fake_session(
        monkeypatch,
        [
            ProviderTurn(
                assistant_text="",
                tool_calls=[
                    ToolCall(id="c1", name="create_file", arguments={"content": "<html>x</html>"})
                ],
            ),
            ProviderTurn(assistant_text="Built the page.", tool_calls=[]),
        ],
    )

    events: List[dict] = []

    async def sink(event: dict) -> None:
        events.append(event)

    manager.attach_sink(meta.id, sink)
    run_id = await manager.start_run(meta.id, RunRequest(text="build a page", settings={"openAiApiKey": "k"}))
    active = manager._active[meta.id]
    await active.task

    assert session.closed is True
    # Workspace persisted.
    assert store.load_workspace(meta.id).read("index.html") == "<html>x</html>"
    # Transcript holds the exchange.
    transcript = store.read_transcript(meta.id)
    assert transcript[0].role == "user"
    assert transcript[1].role == "assistant"
    assert transcript[1].text == "Built the page."
    # Events streamed, incl. terminal run_status.
    types = [e["type"] for e in events]
    assert "tool_start" in types and "tool_result" in types
    assert events[-1]["type"] == "run_status"
    assert events[-1]["status"] == "completed"


@pytest.mark.asyncio
async def test_manager_rejects_concurrent_runs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = ProjectStore(tmp_path / "projects")
    meta = store.create(name="p", brief="b")
    manager = ProjectRunManager(store)

    gate_hold = asyncio.Event()

    class HoldingSession(FakeSession):
        async def stream_turn(self, on_event: EventSink) -> ProviderTurn:
            await gate_hold.wait()
            return ProviderTurn(assistant_text="done", tool_calls=[])

    def fake_create(**kwargs: Any) -> HoldingSession:
        return HoldingSession([])

    monkeypatch.setattr("projects.manager.create_provider_session", fake_create)

    await manager.start_run(meta.id, RunRequest(text="first", settings={"openAiApiKey": "k"}))
    with pytest.raises(RunAlreadyActive):
        await manager.start_run(meta.id, RunRequest(text="second", settings={"openAiApiKey": "k"}))
    gate_hold.set()
    await manager._active[meta.id].task


@pytest.mark.asyncio
async def test_manager_ask_user_round_trip(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = ProjectStore(tmp_path / "projects")
    meta = store.create(name="p", brief="b")
    manager = ProjectRunManager(store)
    _install_fake_session(
        monkeypatch,
        [
            ProviderTurn(
                assistant_text="",
                tool_calls=[
                    ToolCall(
                        id="q1",
                        name="ask_user",
                        arguments={"question": "Dark or light?", "options": ["dark", "light", "system", "high contrast"]},
                    )
                ],
            ),
            ProviderTurn(assistant_text="ok", tool_calls=[]),
        ],
    )

    questions: List[dict] = []

    async def sink(event: dict) -> None:
        if event.get("type") == "question":
            questions.append(event)

    manager.attach_sink(meta.id, sink)
    await manager.start_run(meta.id, RunRequest(text="build", settings={"openAiApiKey": "k"}))

    # Wait until the question event arrives, then answer.
    for _ in range(200):
        if questions:
            break
        await asyncio.sleep(0.005)
    assert questions, "expected a question event"
    assert manager.answer(meta.id, "dark", questions[0]["questionId"])

    await manager._active[meta.id].task
    transcript = store.read_transcript(meta.id)
    assert transcript[-1].role == "assistant"


@pytest.mark.asyncio
async def test_manager_cancel_keeps_partial_workspace(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = ProjectStore(tmp_path / "projects")
    meta = store.create(name="p", brief="b")
    manager = ProjectRunManager(store)

    class WriteThenHangSession(FakeSession):
        async def stream_turn(self, on_event: EventSink) -> ProviderTurn:
            if self.turns:
                return self.turns.pop(0)
            # Second provider turn: hang until the test cancels the run.
            await asyncio.sleep(30)
            raise asyncio.CancelledError()

    _install = monkeypatch.setattr(
        "projects.manager.create_provider_session",
        lambda **kwargs: WriteThenHangSession(
            [
                ProviderTurn(
                    assistant_text="",
                    tool_calls=[
                        ToolCall(
                            id="c1",
                            name="create_file",
                            arguments={"content": "<html>partial</html>"},
                        )
                    ],
                )
            ]
        ),
    )

    await manager.start_run(meta.id, RunRequest(text="go", settings={"openAiApiKey": "k"}))
    await asyncio.sleep(0.2)
    assert manager.cancel(meta.id) is True
    for _ in range(200):
        if manager.active_run_id(meta.id) is None:
            break
        await asyncio.sleep(0.01)
    # Partial workspace survived the cancel: the file the agent already
    # wrote is persisted even though the run never finished.
    assert store.load_workspace(meta.id).read("index.html") == "<html>partial</html>"


@pytest.mark.asyncio
async def test_build_run_prompts_create_then_update(tmp_path: Path) -> None:
    store = ProjectStore(tmp_path / "projects")
    meta = store.create(name="p", brief="b")

    workspace = store.load_workspace(meta.id)
    create_messages = await build_run_prompts(
        workspace, RunRequest(text="landing page", settings={"generatedCodeConfig": "html_tailwind"})
    )
    assert any("landing page" in str(m.get("content")) for m in create_messages)

    workspace.write("index.html", "<html>current</html>")
    update_messages = await build_run_prompts(
        workspace, RunRequest(text="make it blue", settings={})
    )
    joined = " ".join(str(m.get("content")) for m in update_messages)
    assert "make it blue" in joined


@pytest.mark.asyncio
async def test_immediate_cancel_finalizes_run(tmp_path: Path) -> None:
    store = ProjectStore(tmp_path)
    project = store.create("Cancel", "")
    manager = ProjectRunManager(store)
    run_id = await manager.start_run(
        project.id, RunRequest(text="Build", settings={"openAiApiKey": "k"})
    )
    task = manager._active[project.id].task
    assert manager.cancel(project.id)
    assert not manager.cancel(project.id)
    await task
    record = store.get_run_record(project.id, run_id)
    assert record is not None
    assert record["status"] == "cancelled"
    assert manager.active_run_id(project.id) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["save_workspace", "save_iteration"])
async def test_persistence_failure_never_reports_completed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, operation: str
) -> None:
    store = ProjectStore(tmp_path)
    project = store.create("Failure", "")
    workspace = store.load_workspace(project.id)
    workspace.write("index.html", "<html>old</html>")
    store.save_workspace(project.id, workspace)
    manager = ProjectRunManager(store)
    _install_fake_session(monkeypatch, [ProviderTurn(assistant_text="Done", tool_calls=[])])

    def fail(*args: Any, **kwargs: Any) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(store, operation, fail)
    run_id = await manager.start_run(
        project.id, RunRequest(text="Update", settings={"openAiApiKey": "k"})
    )
    await manager._active[project.id].task
    record = store.get_run_record(project.id, run_id)
    assert record is not None
    assert record["status"] == "failed"
    assert "Could not save" in record["error"]
    assert manager._event_buffers[project.id][-1]["status"] == "failed"
    assert store.load_workspace(project.id).content == "<html>old</html>"


@pytest.mark.asyncio
async def test_modified_files_and_broken_sink(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = ProjectStore(tmp_path)
    project = store.create("Diff", "")
    workspace = store.load_workspace(project.id)
    workspace.write("index.html", "<html>old</html>")
    store.save_workspace(project.id, workspace)
    manager = ProjectRunManager(store)

    async def broken_sink(event: Any) -> None:
        raise ConnectionError("gone")

    manager.attach_sink(project.id, broken_sink)
    _install_fake_session(monkeypatch, [
        ProviderTurn(assistant_text="", tool_calls=[ToolCall(
            id="edit", name="create_file", arguments={"content": "<html>new</html>"}
        )]),
        ProviderTurn(assistant_text="Updated", tool_calls=[]),
    ])
    run_id = await manager.start_run(
        project.id, RunRequest(text="Update", settings={"openAiApiKey": "k"})
    )
    await manager._active[project.id].task
    record = store.get_run_record(project.id, run_id)
    assert record is not None
    assert record["status"] == "completed"
    assert record["files_changed"] == ["index.html"]
    events = manager._event_buffers[project.id]
    assert [event["sequence"] for event in events] == list(range(1, len(events) + 1))
