"""Tests for execution configuration: model selection, run snapshots, and
iterations. The coordinator delegates; specialists write files, so the fake
sessions mirror that split."""
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

DELEGATE = ProviderTurn(
    assistant_text="",
    tool_calls=[
        ToolCall(
            id="d1",
            name="spawn_agent",
            arguments={
                "role": "engineer",
                "objective": "create the page",
                "file_paths": ["index.html"],
            },
        )
    ],
)


class FakeSession:
    """Coordinator: delegates once, then finishes. Specialists write v1."""

    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs
        self.turn = 0
        self.closed = False

    async def stream_turn(self, on_event: Any) -> ProviderTurn:
        from agent.providers.base import StreamEvent

        self.turn += 1
        if self.turn == 1:
            return DELEGATE
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


class SpecialistSession:
    """Writes one file then finishes (the implementation side of the team)."""

    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs
        self.written = False
        self.closed = False

    async def stream_turn(self, on_event: Any) -> ProviderTurn:
        from agent.providers.base import StreamEvent

        if not self.written:
            self.written = True
            return ProviderTurn(
                assistant_text="",
                tool_calls=[
                    ToolCall(
                        id="s1",
                        name="create_file",
                        arguments={"content": "<html>v1</html>"},
                    )
                ],
            )
        await on_event(StreamEvent(type="assistant_delta", text="Done."))
        return ProviderTurn(assistant_text="Done.", tool_calls=[])

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
        "projects.subagents.create_provider_session",
        lambda **kw: SpecialistSession(**kw),
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
    meta = type("M", (), {"primary_model": "", "subagent_model": ""})()
    config = resolve_execution_config(meta, {"primaryModel": "gpt-5.5 (no thinking)"}, keys)
    assert config["subagent_model"] == ""
    assert config["primary_model"] == "gpt-5.5 (no thinking)"


def test_project_default_model_used_when_request_omits(env) -> None:
    store = env[1]
    meta = store.create(name="p", brief="")
    store.update(
        meta.id,
        primary_model="gemini-3-flash-preview (minimal thinking)",
    )
    meta = store.get(meta.id)
    config = resolve_execution_config(
        meta, {}, {"gemini_api_key": "k", "openai_api_key": None}
    )
    assert config["primary_model"] == "gemini-3-flash-preview (minimal thinking)"


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
                return DELEGATE
            await asyncio.sleep(30)
            raise asyncio.CancelledError()

    monkeypatch.setattr(
        "projects.manager.create_provider_session", lambda **kw: HangingSession()
    )
    monkeypatch.setattr(
        "projects.subagents.create_provider_session",
        lambda **kw: SpecialistSession(**kw),
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
    # The cancelled run's partial file goes to a draft; the live workspace
    # stays empty (nothing was validated before the cancel).
    assert store.load_workspace(meta.id).read("index.html") == ""
    assert len(store.list_drafts(meta.id)) == 1


# --- orchestrator-only coordinator ---------------------------------------------------


def test_coordinator_session_is_orchestrator(env, monkeypatch) -> None:
    manager, store = env
    meta = store.create(name="p", brief="")
    captured: dict = {}

    def spy(**kwargs: Any) -> Any:
        captured.update(kwargs)
        return FakeSession(**kwargs)

    monkeypatch.setattr("projects.manager.create_provider_session", spy)
    asyncio.run(_run_to_completion(manager, meta.id, settings={"openAiApiKey": "k"}))
    assert captured.get("orchestrator") is True


def test_orchestrator_toolset_has_no_writing_tools() -> None:
    from agent.tools.definitions import canonical_tool_definitions

    orchestrator_names = {
        tool.name
        for tool in canonical_tool_definitions(
            orchestrator=True, ask_user_enabled=True
        )
    }
    assert "create_file" not in orchestrator_names
    assert "edit_file" not in orchestrator_names
    assert "generate_images" not in orchestrator_names
    assert "save_assets" not in orchestrator_names
    assert {"spawn_agent", "spawn_agents", "read_file", "list_files",
            "ask_user"} <= orchestrator_names

    specialist_names = {
        tool.name for tool in canonical_tool_definitions(spawn_agent_enabled=False)
    }
    assert "create_file" in specialist_names
    assert "spawn_agent" not in specialist_names


@pytest.mark.asyncio
async def test_orchestrator_cannot_write_files() -> None:
    from agent.tools import AgentToolRuntime
    from agent.workspace import Workspace

    runtime = AgentToolRuntime(
        file_state=Workspace(),
        should_generate_images=False,
        openai_api_key=None,
        openai_base_url=None,
        orchestrator=True,
    )
    result = await runtime.execute(
        ToolCall(id="t1", name="create_file", arguments={"content": "<html/>"})
    )
    assert result.ok is False
    assert "orchestrator" in str(result.result["error"]).lower()
    # The workspace was not touched.
    assert runtime.file_state.files == {}
