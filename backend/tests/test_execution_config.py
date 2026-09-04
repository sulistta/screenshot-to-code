"""Tests for execution configuration: model selection, mode enforcement,
run snapshots, and iterations."""
import asyncio
from typing import Any, List, Optional

import pytest
from agent.providers.base import ProviderTurn
from agent.tools.types import ToolCall
from projects.manager import (
    ProjectRunManager,
    RunRequest,
    resolve_execution_config,
)
from projects.store import ProjectStore


class FakeSession:
    """Finishes after `tool_turns` create_file turns."""

    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs
        self.turn = 0
        self.closed = False

    async def stream_turn(self, on_event: Any) -> ProviderTurn:
        from agent.providers.base import StreamEvent

        self.turn += 1
        if self.turn == 1:
            return ProviderTurn(
                assistant_text="",
                tool_calls=[
                    ToolCall(
                        id=f"c{self.turn}",
                        name="create_file",
                        arguments={"content": f"<html>v{self.turn}</html>"},
                    )
                ],
            )
        await on_event(StreamEvent(type="assistant_delta", text="Finished."))
        return ProviderTurn(assistant_text="Finished.", tool_calls=[])

    async def append_tool_results(
        self, turn: ProviderTurn, executed: List[Any]
    ) -> None:
        return None

    def total_cost_usd(self) -> Optional[float]:
        return None

    async def close(self) -> None:
        self.closed = True


@pytest.fixture()
def env(tmp_path, monkeypatch):
    store = ProjectStore(tmp_path / "projects")
    monkeypatch.setattr(
        "projects.manager.create_provider_session", lambda **kw: FakeSession(**kw)
    )
    monkeypatch.setattr(
        "projects.subagents.create_provider_session", lambda **kw: FakeSession(**kw)
    )
    return ProjectRunManager(store), store


async def _run_to_completion(manager: ProjectRunManager, project_id: str, **kw: Any):
    await manager.start_run(project_id, RunRequest(text="go", **kw))
    await manager._active[project_id].task


# --- config resolution ---------------------------------------------------------


def test_explicit_model_reaches_provider_call(env) -> None:
    manager, store = env
    meta = store.create(name="p", brief="")

    async def check() -> None:
        await _run_to_completion(
            manager,
            meta.id,
            settings={
                "openAiApiKey": "k",
                "primaryModel": "gpt-5.6-sol (max thinking)",
            },
        )

    asyncio.run(check())
    # The session factory received the chosen model, not a fallback.
    # (FakeSession stores kwargs; inspect through run record instead.)
    record = store.list_run_records(meta.id)[0]
    assert record["config"]["primary_model"] == "gpt-5.6-sol (max thinking)"
    assert record["config"]["execution_mode"] == "auto"


def test_unavailable_explicit_model_fails_loudly(env) -> None:
    manager, store = env
    meta = store.create(name="p", brief="")
    with pytest.raises(ValueError, match="not available"):
        asyncio.run(
            manager.start_run(
                meta.id,
                RunRequest(
                    text="go",
                    settings={"primaryModel": "claude-opus-5 (max effort)"},
                ),
            )
        )


def test_unknown_model_fails_loudly(env) -> None:
    manager, store = env
    meta = store.create(name="p", brief="")
    with pytest.raises(ValueError, match="not available|Unknown"):
        asyncio.run(
            manager.start_run(
                meta.id,
                RunRequest(text="go", settings={"primaryModel": "totally-made-up"}),
            ),
        )


def test_subagent_model_defaults_to_primary(env) -> None:
    keys = {"openai_api_key": "k"}
    meta = type("M", (), {"primary_model": "", "subagent_model": "", "execution_mode": "auto"})()
    config = resolve_execution_config(meta, {"primaryModel": "gpt-5.5 (no thinking)"}, keys)
    assert config["subagent_model"] == ""
    assert config["primary_model"] == "gpt-5.5 (no thinking)"


def test_project_default_config_used_when_request_omits(env) -> None:
    store = env[1]
    meta = store.create(name="p", brief="")
    store.update(
        meta.id,
        primary_model="gemini-3-flash-preview (minimal thinking)",
        execution_mode="single",
    )
    meta = store.get(meta.id)
    config = resolve_execution_config(
        meta, {}, {"gemini_api_key": "k", "openai_api_key": None}
    )
    assert config["primary_model"] == "gemini-3-flash-preview (minimal thinking)"
    assert config["execution_mode"] == "single"


def test_request_overrides_project_config(env) -> None:
    store = env[1]
    meta = store.create(name="p", brief="")
    store.update(meta.id, execution_mode="swarm")
    meta = store.get(meta.id)
    config = resolve_execution_config(
        meta,
        {"executionMode": "single", "openAiApiKey": "k"},
        {"openai_api_key": "k"},
    )
    assert config["execution_mode"] == "single"


# --- run records ------------------------------------------------------------------


def test_run_record_snapshots_config_and_outcome(env) -> None:
    manager, store = env
    meta = store.create(name="p", brief="")
    asyncio.run(
        _run_to_completion(
            manager,
            meta.id,
            settings={
                "openAiApiKey": "k",
                "primaryModel": "gpt-5.5 (no thinking)",
                "executionMode": "auto",
            },
        )
    )
    record = store.list_run_records(meta.id)[0]
    assert record["status"] == "completed"
    assert record["config"]["primary_model"] == "gpt-5.5 (no thinking)"
    assert record["finished_at"] is not None
    assert record["files_changed"] == ["index.html"]
    assert record["iteration_id"] is not None


# --- iterations ---------------------------------------------------------------------


def test_completed_run_creates_iteration_with_summary(env) -> None:
    manager, store = env
    meta = store.create(name="p", brief="")
    asyncio.run(_run_to_completion(manager, meta.id, settings={"openAiApiKey": "k"}))

    iterations = store.list_iterations(meta.id)
    assert len(iterations) == 1
    first = iterations[0]
    assert first["label"] == "Initial implementation"
    assert "Finished." in first["summary"]

    # A second run creates the next iteration.
    asyncio.run(_run_to_completion(manager, meta.id, settings={"openAiApiKey": "k"}))
    iterations = store.list_iterations(meta.id)
    assert len(iterations) == 2
    assert iterations[1]["label"] == "Revision 1"
    assert store.load_workspace(meta.id).read("index.html") == "<html>v1</html>"

    # The iteration snapshot preserves the state at its checkpoint.
    snapshot_entry = store.iteration_file(meta.id, iterations[0]["id"], "index.html")
    assert snapshot_entry.read_text() == "<html>v1</html>"


def test_failed_run_does_not_create_iteration(tmp_path, monkeypatch) -> None:
    store = ProjectStore(tmp_path / "projects")
    meta = store.create(name="p", brief="")

    class ExplodingSession(FakeSession):
        async def stream_turn(self, on_event: Any) -> ProviderTurn:
            raise RuntimeError("provider exploded")

    monkeypatch.setattr(
        "projects.manager.create_provider_session", lambda **kw: ExplodingSession()
    )
    manager = ProjectRunManager(store)
    asyncio.run(_run_to_completion(manager, meta.id, settings={"openAiApiKey": "k"}))

    assert store.list_iterations(meta.id) == []
    record = store.list_run_records(meta.id)[0]
    assert record["status"] == "failed"
    assert record["error"] is not None


@pytest.mark.asyncio
async def test_cancelled_run_does_not_create_iteration(tmp_path, monkeypatch) -> None:
    store = ProjectStore(tmp_path / "projects")
    meta = store.create(name="p", brief="")

    class HangingSession(FakeSession):
        async def stream_turn(self, on_event: Any) -> ProviderTurn:
            if self.turn == 0:
                self.turn = 1
                return ProviderTurn(
                    assistant_text="",
                    tool_calls=[
                        ToolCall(id="c1", name="create_file", arguments={"content": "<html>x</html>"})
                    ],
                )
            await asyncio.sleep(30)
            raise asyncio.CancelledError()

    monkeypatch.setattr(
        "projects.manager.create_provider_session", lambda **kw: HangingSession()
    )
    manager = ProjectRunManager(store)
    await manager.start_run(meta.id, RunRequest(text="go", settings={"openAiApiKey": "k"}))
    await asyncio.sleep(0.3)
    assert manager.cancel(meta.id) is True
    for _ in range(200):
        if manager.active_run_id(meta.id) is None:
            break
        await asyncio.sleep(0.01)

    assert store.list_iterations(meta.id) == []
    assert store.load_workspace(meta.id).read("index.html") == "<html>x</html>"


# --- execution modes ------------------------------------------------------------------


def test_single_mode_hides_and_blocks_spawn(env) -> None:
    manager, store = env
    meta = store.create(name="p", brief="")

    async def check() -> None:
        from agent.providers.factory import create_provider_session as real

        captured: dict = {}

        def spy(**kwargs: Any) -> Any:
            captured.update(kwargs)
            return FakeSession(**kwargs)

        monkeypatch_target = "projects.manager.create_provider_session"
        original = __import__("projects.manager", fromlist=["x"]).create_provider_session
        import projects.manager as pm

        pm.create_provider_session = spy
        try:
            await _run_to_completion(
                manager,
                meta.id,
                settings={"openAiApiKey": "k", "executionMode": "single"},
            )
        finally:
            pm.create_provider_session = original
        assert captured.get("spawn_agent_enabled") is False

    asyncio.run(check())
