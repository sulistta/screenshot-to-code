"""Durable agent identity for project runs.

Every run has a coordinator; the coordinator may delegate to specialist
subagents. Each agent gets a stable id, a short human name separate from its
role (Nora · Coordinator, Theo · Interface), explicit lifecycle states and a
persisted record so the team — names, states, files, results — survives page
reloads, reconnects and backend restarts.

Records live as database documents under
``projects/<project_id>/agents/<run_id>/<agent_id>.json``.
"""
import re
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, cast

from projects.store import ProjectStore

COORDINATOR_ROLE = "coordinator"
COORDINATOR_NAME = "Nora"

# Short names handed to specialists in delegation order; role still shows
# what they do (name != function).
SPECIALIST_NAMES = ("Theo", "Maya", "Iris", "Leo", "Ada", "Sam", "Nia", "Ori")

# Explicit agent states; blocked is expressed by the coordinator surfacing a
# specialist failure, not an inferred state.
AGENT_ACTIVE_STATES = ("queued", "working", "verifying")


def _empty_paths() -> List[str]:
    return []


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())


@dataclass
class AgentRun:
    agent_id: str
    run_id: str
    name: str
    role: str
    parent_agent_id: Optional[str]
    objective: str
    status: str  # queued|working|verifying|completed|failed|cancelled
    file_paths: List[str] = field(default_factory=_empty_paths)
    started_at: str = field(default_factory=now_iso)
    finished_at: Optional[str] = None
    summary: str = ""
    files: List[str] = field(default_factory=_empty_paths)
    error: Optional[str] = None

    def to_json(self) -> Dict[str, object]:
        return asdict(self)

    @classmethod
    def from_json(cls, data: Dict[str, object]) -> "AgentRun":
        def string_list(key: str) -> List[str]:
            value = data.get(key)
            if not isinstance(value, list):
                return []
            return [str(item) for item in cast(List[object], value) if item is not None]

        return cls(
            agent_id=str(data["agent_id"]),
            run_id=str(data["run_id"]),
            name=str(data.get("name", "")),
            role=str(data.get("role", "")),
            parent_agent_id=(
                str(data["parent_agent_id"]) if data.get("parent_agent_id") else None
            ),
            objective=str(data.get("objective", "")),
            status=str(data.get("status", "")),
            file_paths=string_list("file_paths"),
            started_at=str(data.get("started_at", "")),
            finished_at=(
                str(data["finished_at"]) if data.get("finished_at") else None
            ),
            summary=str(data.get("summary", "")),
            files=string_list("files"),
            error=str(data["error"]) if data.get("error") else None,
        )


class AgentTeam:
    """Names and ids for one run's agents, unique within the run."""

    def __init__(self) -> None:
        self._used: set[str] = set()

    def specialist_name(self, preferred: str) -> str:
        base = preferred.strip().title() if preferred.strip() else ""
        candidate = base if base and not base.lower().startswith("specialist") else ""
        index = len(self._used)
        while not candidate or candidate in self._used:
            candidate = SPECIALIST_NAMES[index % len(SPECIALIST_NAMES)]
            suffix = index // len(SPECIALIST_NAMES)
            if suffix:
                candidate = f"{candidate} {suffix + 1}"
            index += 1
        self._used.add(candidate)
        return candidate

    def new_agent_id(self) -> str:
        agent_id = f"agent-{uuid.uuid4().hex[:8]}"
        while agent_id in self._used:
            agent_id = f"agent-{uuid.uuid4().hex[:8]}"
        self._used.add(agent_id)
        return agent_id


class AgentRunStore:
    """Persistence for AgentRun records, keyed by project and run."""

    def __init__(self, store: ProjectStore) -> None:
        self.store = store

    def save(self, project_id: str, agent: AgentRun) -> None:
        path = self._path(project_id, agent.run_id, agent.agent_id)
        self.store.database.put(path, agent.to_json())

    def get(self, project_id: str, run_id: str, agent_id: str) -> Optional[AgentRun]:
        path = self._path(project_id, run_id, agent_id)
        try:
            data = self.store.database.get(path)
        except (FileNotFoundError, KeyError):
            return None
        return AgentRun.from_json(data)

    def list_run(self, project_id: str, run_id: str) -> List[AgentRun]:
        agents: List[AgentRun] = []
        prefix = self._relative_dir(project_id, run_id) + "/"
        for _key, data in self.store.database.list_prefix(prefix):
            agents.append(AgentRun.from_json(data))
        return sorted(agents, key=lambda agent: agent.started_at)

    def list_running(self, project_id: str) -> List[AgentRun]:
        running: List[AgentRun] = []
        for run_record in self.store.list_run_records(project_id):
            for agent in self.list_run(project_id, str(run_record["run_id"])):
                if agent.status in AGENT_ACTIVE_STATES:
                    running.append(agent)
        return running

    def _relative_dir(self, project_id: str, run_id: str) -> str:
        return f"{project_id}/agents/{run_id}"

    def _path(self, project_id: str, run_id: str, agent_id: str) -> Path:
        if not re.fullmatch(r"[A-Za-z0-9_-]+", run_id) or not re.fullmatch(
            r"[A-Za-z0-9_-]+", agent_id
        ):
            raise ValueError(f"Invalid agent record id: {run_id}/{agent_id}")
        return self.store.root / self._relative_dir(project_id, run_id) / f"{agent_id}.json"


def coordinator_agent(run_id: str, objective: str) -> AgentRun:
    return AgentRun(
        agent_id="coordinator",
        run_id=run_id,
        name=COORDINATOR_NAME,
        role=COORDINATOR_ROLE,
        parent_agent_id=None,
        objective=objective,
        status="working",
    )
