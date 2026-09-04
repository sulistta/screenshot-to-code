"""Tests for scoped subagents and the spawn_agent tool."""
import asyncio
from typing import Any, List, Optional

import pytest
from agent.providers.base import EventSink, ExecutedToolCall, ProviderTurn
from agent.tools import AgentToolRuntime
from agent.tools.types import ToolCall
from agent.workspace import Workspace
from projects.subagents import (
    SubagentBrief,
    build_subagent_messages,
    run_subagent,
)


class FakeSession:
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


def _install_factory(
    monkeypatch: pytest.MonkeyPatch, sessions: List[FakeSession]
) -> None:
    queue = list(sessions)

    def fake_create(**kwargs: Any) -> FakeSession:
        return queue.pop(0)

    monkeypatch.setattr("projects.subagents.create_provider_session", fake_create)


# --- brief validation and prompts -------------------------------------------------


@pytest.mark.asyncio
async def test_subagent_requires_scope() -> None:
    brief = SubagentBrief(role="r", objective="o", file_paths=[])
    result = await run_subagent(
        brief,
        Workspace(),
        model=Any,  # never reached: the factory is never called
        request_settings={},
        keys={},
    )
    assert result.ok is False
    assert result.error is not None and "file_paths" in result.error


def test_subagent_messages_carry_brief() -> None:
    messages = build_subagent_messages(
        SubagentBrief(
            role="motion designer",
            objective="add scroll reveals",
            file_paths=["main.js"],
            guidance="use IO",
            parent_context="dark theme",
        ),
        {"generatedCodeConfig": "html_tailwind"},
    )
    system = messages[0]["content"]
    user = messages[1]["content"]
    assert "specialist subagent" in str(system)
    assert "scroll reveals" in str(user)
    assert "main.js" in str(user)
    assert "use IO" in str(user)
    assert "dark theme" in str(user)


# --- scope isolation and merge ------------------------------------------------------


@pytest.mark.asyncio
async def test_subagent_writes_scoped_files_and_merges_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    parent = Workspace()
    parent.write("index.html", "<html>entry</html>")
    parent.write("hero.html", "<section>old</section>")

    # The fake subagent session edits its scoped copy and adds a file.
    sub_turns = [
        ProviderTurn(
            assistant_text="",
            tool_calls=[
                ToolCall(
                    id="c1",
                    name="edit_file",
                    arguments={
                        "path": "hero.html",
                        "old_text": "old",
                        "new_text": "new",
                    },
                ),
                ToolCall(
                    id="c2",
                    name="create_file",
                    arguments={"path": "hero.css", "content": ".hero{}"},
                ),
            ],
        ),
        ProviderTurn(assistant_text="Hero rebuilt.", tool_calls=[]),
    ]
    _install_factory(monkeypatch, [FakeSession(sub_turns)])

    keys = {"openai_api_key": "k"}
    result = await run_subagent(
        SubagentBrief(role="designer", objective="redo hero", file_paths=["hero.html"]),
        parent,
        model=Any,
        request_settings={},
        keys=keys,
    )
    assert result.ok is True
    assert result.summary == "Hero rebuilt."
    # Scoped file edits and new files merge back into the parent.
    assert parent.read("hero.html") == "<section>new</section>"
    assert parent.read("hero.css") == ".hero{}"
    # Out-of-scope parent files are untouched.
    assert parent.read("index.html") == "<html>entry</html>"
    # Out-of-scope files never entered the subagent workspace; its writes
    # could not affect them even if it tried.
    assert sorted(result.files) == ["hero.css", "hero.html"]


# --- spawn_agent tool dispatch -------------------------------------------------------


@pytest.mark.asyncio
async def test_spawn_agent_without_runner_errors() -> None:
    runtime = AgentToolRuntime(
        file_state=Workspace(),
        should_generate_images=False,
        openai_api_key=None,
        openai_base_url=None,
    )
    result = await runtime.execute(
        ToolCall(id="1", name="spawn_agent", arguments={"role": "x"})
    )
    assert result.ok is False


@pytest.mark.asyncio
async def test_spawn_agent_dispatches_to_runner() -> None:
    received: List[dict] = []

    async def runner(args: dict) -> Any:
        from agent.tools.types import ToolExecutionResult

        received.append(args)
        return ToolExecutionResult(
            ok=True,
            result={"summary": "done", "files": ["a.js"]},
            summary={"ok": True},
        )

    runtime = AgentToolRuntime(
        file_state=Workspace(),
        should_generate_images=False,
        openai_api_key=None,
        openai_base_url=None,
        subagent_runner=runner,
    )
    result = await runtime.execute(
        ToolCall(
            id="1",
            name="spawn_agent",
            arguments={"role": "assets", "objective": "make icons", "file_paths": ["icons/"]},
        )
    )
    assert result.ok is True
    assert received and received[0]["role"] == "assets"


# --- orchestrator session wiring ------------------------------------------------------


@pytest.mark.asyncio
async def test_orchestrator_spawns_scoped_subagent(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Full loop: orchestrator turn calls spawn_agent; the subagent session
    writes its scoped file; the orchestrator finishes; parent workspace has
    the merged result."""
    from projects.manager import ProjectRunManager, RunRequest
    from projects.store import ProjectStore

    store = ProjectStore(tmp_path / "projects")
    meta = store.create(name="p", brief="b")
    manager = ProjectRunManager(store)

    class OrchestratorSession(FakeSession):
        def __init__(self, **kwargs: Any) -> None:
            super().__init__(
                [
                    ProviderTurn(
                        assistant_text="",
                        tool_calls=[
                            ToolCall(
                                id="s1",
                                name="spawn_agent",
                                arguments={
                                    "role": "writer",
                                    "objective": "write the page",
                                    "file_paths": ["index.html"],
                                },
                            )
                        ],
                    ),
                    ProviderTurn(assistant_text="done", tool_calls=[]),
                ]
            )

    class SubagentSession(FakeSession):
        def __init__(self, **kwargs: Any) -> None:
            super().__init__(
                [
                    ProviderTurn(
                        assistant_text="",
                        tool_calls=[
                            ToolCall(
                                id="w1",
                                name="create_file",
                                arguments={"content": "<html>sub page</html>"},
                            )
                        ],
                    ),
                    ProviderTurn(assistant_text="wrote it", tool_calls=[]),
                ]
            )

    sessions = [OrchestratorSession(), SubagentSession()]

    def fake_create(**kwargs: Any) -> Any:
        return sessions.pop(0)

    monkeypatch.setattr("projects.manager.create_provider_session", fake_create)
    # The subagent module has its own factory reference.
    monkeypatch.setattr(
        "projects.subagents.create_provider_session",
        lambda **kwargs: SubagentSession(),
    )

    await manager.start_run(
        meta.id, RunRequest(text="build", settings={"openAiApiKey": "k"})
    )
    await manager._active[meta.id].task

    workspace = store.load_workspace(meta.id)
    assert workspace.read("index.html") == "<html>sub page</html>"
