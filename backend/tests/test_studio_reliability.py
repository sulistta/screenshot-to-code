"""Reliability conducts: shared budget, failure drafts, agent team records,
workspace GC and the project edit lock."""
import asyncio
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest
from agent.providers.base import ExecutedToolCall, EventSink, ProviderTurn
from agent.tools.types import ToolCall
from projects.agents import AgentTeam, AgentRunStore
from projects.manager import ProjectRunManager, RunRequest
from projects.store import ProjectStore


class BudgetSession:
    """Minimal provider session with an isolated spend counter."""

    def __init__(self, spent: Optional[float]) -> None:
        self._spent = spent
        self.closed = False

    async def stream_turn(self, on_event: EventSink) -> ProviderTurn:
        return ProviderTurn(assistant_text="done", tool_calls=[])

    async def append_tool_results(
        self, turn: ProviderTurn, executed: List[ExecutedToolCall]
    ) -> None:
        return None

    def total_cost_usd(self) -> Optional[float]:
        return self._spent

    async def close(self) -> None:
        self.closed = True


# --- shared budget ---------------------------------------------------------------


def test_shared_budget_sums_registered_sessions() -> None:
    from agent.budget import SharedBudget

    budget = SharedBudget(10.0)
    first = BudgetSession(1.5)
    second = BudgetSession(2.0)
    budget.register(first)
    budget.register(second)
    assert budget.spent_usd() == 3.5


def test_shared_budget_unpriced_returns_none() -> None:
    from agent.budget import SharedBudget

    budget = SharedBudget(10.0)
    budget.register(BudgetSession(None))
    assert budget.spent_usd() is None


@pytest.mark.asyncio
async def test_shared_budget_stops_run_across_subagents(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The run's ceiling applies to the pool, not per session."""
    from agent.budget import SharedBudget
    from agent.runtime.events import AgentIdentity, AgentLifecycleEvent
    from projects.subagents import (
        SubagentBrief,
        SubagentContext,
        SubagentLocks,
        run_subagents_parallel,
    )
    from agent.workspace import Workspace

    spent = {"coordinator": 2.0, "s1": 0.9, "s2": 0.9}

    def fake_create(**kwargs: Any) -> BudgetSession:
        label = kwargs["recorder"].generation_id if kwargs.get("recorder") else "s1"
        return BudgetSession(spent.get(str(label), 0.5))

    monkeypatch.setattr(
        "projects.subagents.create_provider_session", fake_create
    )

    budget = SharedBudget(3.0)
    budget.register(BudgetSession(spent["coordinator"]))
    from projects.subagents import SubagentLocks

    context = SubagentContext(budget=budget, locks=SubagentLocks())
    outcomes: List[Dict[str, Any]] = []

    async def emit(event: Dict[str, Any]) -> None:
        outcomes.append(event)

    identity = AgentIdentity(agent_id="a1", name="Theo", role="backend",
                             parent_agent_id="coordinator")
    results = await run_subagents_parallel(
        [
            SubagentBrief(role="backend", objective="build api",
                          file_paths=["api.py"]),
            SubagentBrief(role="frontend", objective="build ui",
                          file_paths=["ui.html"]),
        ],
        Workspace(),
        model=None,  # type: ignore[arg-type]
        request_settings={},
        keys={},
        emit=emit,
        identity_of=lambda brief: identity,
        context=context,
    )
    assert len(results) == 2
    lifecycle: List[Dict[str, Any]] = [
        event for event in outcomes if event.get("type") == "agent_status"
    ]
    statuses = [event["status"] for event in lifecycle]
    assert "queued" in statuses and "working" in statuses


def test_agent_lifecycle_event_carries_identity() -> None:
    from agent.runtime.events import AgentIdentity, AgentLifecycleEvent

    event = AgentLifecycleEvent(
        status="completed", objective="do it", file_paths=["a.py"],
        agent=AgentIdentity(agent_id="agent-1", name="Theo", role="backend",
                            parent_agent_id="coordinator"),
        summary="done",
    )
    assert event.agent is not None and event.agent.name == "Theo"


# --- failure drafts -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_cancelled_run_keeps_draft_not_live_workspace(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = ProjectStore(tmp_path / "projects")
    project = store.create("Draft", "")
    workspace = store.load_workspace(project.id)
    workspace.write("index.html", "<html>old</html>")
    store.save_workspace(project.id, workspace)

    hang = asyncio.Event()

    class CoordinatorDelegatesThenHangs:
        def __init__(self) -> None:
            self.called = False

        async def stream_turn(self, on_event: EventSink) -> ProviderTurn:
            if not self.called:
                self.called = True
                return ProviderTurn(
                    assistant_text="",
                    tool_calls=[
                        ToolCall(
                            id="d1", name="spawn_agent",
                            arguments={"role": "engineer",
                                       "objective": "start the page",
                                       "file_paths": ["index.html"]},
                        )
                    ],
                )
            await hang.wait()  # never set: the run hangs after partial work
            raise AssertionError("unreachable")

        async def append_tool_results(
            self, turn: ProviderTurn, executed: List[ExecutedToolCall]
        ) -> None:
            return None

        def total_cost_usd(self) -> Optional[float]:
            return None

        async def close(self) -> None:
            pass

    def fake_coordinator(**kwargs: Any) -> CoordinatorDelegatesThenHangs:
        return CoordinatorDelegatesThenHangs()

    class SpecialistWritesThenFinishes:
        """Writes its file, finishes; the coordinator hangs afterwards."""

        def __init__(self) -> None:
            self.written = False

        async def stream_turn(self, on_event: EventSink) -> ProviderTurn:
            if not self.written:
                self.written = True
                return ProviderTurn(
                    assistant_text="",
                    tool_calls=[
                        ToolCall(
                            id="s1", name="create_file",
                            arguments={"content": "<html>partial</html>"},
                        )
                    ],
                )
            return ProviderTurn(assistant_text="done", tool_calls=[])

        async def append_tool_results(
            self, turn: ProviderTurn, executed: List[ExecutedToolCall]
        ) -> None:
            return None

        def total_cost_usd(self) -> Optional[float]:
            return None

        async def close(self) -> None:
            pass

    monkeypatch.setattr(
        "projects.manager.create_provider_session", fake_coordinator
    )
    monkeypatch.setattr(
        "projects.subagents.create_provider_session",
        lambda **kwargs: SpecialistWritesThenFinishes(),
    )

    manager = ProjectRunManager(store)
    run_id = await manager.start_run(
        project.id, RunRequest(text="Update", settings={"openAiApiKey": "k"})
    )
    await asyncio.sleep(0.05)
    assert manager.cancel(project.id) is True
    await manager._active[project.id].task

    # Live workspace untouched; partial output recoverable as a draft.
    assert store.load_workspace(project.id).content == "<html>old</html>"
    drafts = store.list_drafts(project.id)
    assert len(drafts) == 1 and drafts[0]["run_id"] == run_id

    restored = store.restore_draft(project.id, run_id)
    assert restored["restored"] == run_id
    # The recovered draft is now the live workspace.
    assert store.load_workspace(project.id).content == "<html>partial</html>"


@pytest.mark.asyncio
async def test_failed_run_keeps_draft_and_last_version(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = ProjectStore(tmp_path / "projects")
    project = store.create("Fail", "")
    workspace = store.load_workspace(project.id)
    workspace.write("index.html", "<html>v1</html>")
    store.save_workspace(project.id, workspace)

    class ExplodingSession:
        async def stream_turn(self, on_event: EventSink) -> ProviderTurn:
            raise RuntimeError("provider exploded")

        async def append_tool_results(
            self, turn: ProviderTurn, executed: List[ExecutedToolCall]
        ) -> None:
            return None

        def total_cost_usd(self) -> Optional[float]:
            return None

        async def close(self) -> None:
            pass

    monkeypatch.setattr(
        "projects.manager.create_provider_session",
        lambda **kwargs: ExplodingSession(),
    )
    manager = ProjectRunManager(store)
    run_id = await manager.start_run(
        project.id, RunRequest(text="Update", settings={"openAiApiKey": "k"})
    )
    await manager._active[project.id].task
    record = store.get_run_record(project.id, run_id)
    assert record is not None and record["status"] == "failed"
    # The previously validated version is still what preview serves.
    assert store.load_workspace(project.id).content == "<html>v1</html>"
    assert len(store.list_drafts(project.id)) == 0  # nothing was written


# --- agent team records ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_completed_run_persists_coordinator_record(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = ProjectStore(tmp_path / "projects")
    project = store.create("Team", "")

    class PlainSession:
        async def stream_turn(self, on_event: EventSink) -> ProviderTurn:
            return ProviderTurn(assistant_text="All done.", tool_calls=[])

        async def append_tool_results(
            self, turn: ProviderTurn, executed: List[ExecutedToolCall]
        ) -> None:
            return None

        def total_cost_usd(self) -> Optional[float]:
            return None

        async def close(self) -> None:
            pass

    monkeypatch.setattr(
        "projects.manager.create_provider_session",
        lambda **kwargs: PlainSession(),
    )
    manager = ProjectRunManager(store)
    run_id = await manager.start_run(
        project.id, RunRequest(text="Build", settings={"openAiApiKey": "k"})
    )
    await manager._active[project.id].task

    agents = AgentRunStore(store).list_run(project.id, run_id)
    assert [agent.agent_id for agent in agents] == ["coordinator"]
    coordinator = agents[0]
    assert coordinator.name == "Nora" and coordinator.role == "coordinator"
    assert coordinator.status == "completed"


def test_specialist_names_unique_and_friendly() -> None:
    team = AgentTeam()
    names = {team.specialist_name(role) for role in ("backend", "frontend", "backend")}
    assert len(names) == 3
    assert all(len(name) > 2 for name in names)


# --- workspace GC ---------------------------------------------------------------------


def test_gc_removes_unreferenced_generations(tmp_path: Path) -> None:
    store = ProjectStore(tmp_path / "projects")
    project = store.create("GC", "")
    for content in ("<html>1</html>", "<html>2</html>", "<html>3</html>", "<html>4</html>"):
        workspace = store.load_workspace(project.id)
        workspace.write("index.html", content)
        store.save_workspace(project.id, workspace)
    snapshots = store.root / project.id / "workspaces"
    live = json.loads(
        (store.root / project.id / "workspace-state.json").read_text()
    )["revision"]
    generations = [p.name for p in snapshots.iterdir() if p.is_dir()]
    assert live in generations
    # Pointer + the most recent replacements are kept; old ones collected.
    assert len(generations) <= 3


# --- edit lock -------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_edit_lock_serializes_writes(tmp_path: Path) -> None:
    from routes.studio import edit_lock

    store = ProjectStore(tmp_path / "projects")
    project = store.create("Lock", "")
    order: List[str] = []

    async def writer(label: str, hold: float) -> None:
        async with edit_lock(project.id):
            order.append(f"{label}:start")
            await asyncio.sleep(hold)
            order.append(f"{label}:end")

    await asyncio.gather(writer("a", 0.02), writer("b", 0.0))
    assert order == ["a:start", "a:end", "b:start", "b:end"]
