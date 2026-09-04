"""Durable projects: the unit of long-lived work.

A project is a directory under the data root:

    projects/<id>/
        project.json     # meta (id, name, brief, timestamps)
        workspace/       # the real files the agent writes (index.html, ...)
        sessions/main.json  # the conversation transcript

Workspace files live on disk so projects survive restarts and can be served
or exported later. The in-memory Workspace used during a run is loaded from
and saved back to this directory around each run.
"""
import json
import shutil
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

from agent.workspace import Workspace


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())


@dataclass
class ProjectMeta:
    id: str
    name: str
    brief: str
    created_at: str
    updated_at: str
    # Execution configuration; "" means "let the runtime resolve".
    primary_model: str = ""
    subagent_model: str = ""
    # "auto" | "single" | "swarm"
    execution_mode: str = "auto"

    def to_json(self) -> Dict[str, str]:
        return asdict(self)


@dataclass
class TranscriptMessage:
    role: str  # "user" | "assistant"
    text: str
    created_at: str = field(default_factory=_now_iso)
    run_id: Optional[str] = None
    images: List[str] = field(default_factory=lambda: [])

    def to_json(self) -> Dict[str, object]:
        return asdict(self)


class ProjectNotFoundError(KeyError):
    pass


class ProjectStore:
    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    # --- meta ----------------------------------------------------------------
    def create(self, name: str, brief: str) -> ProjectMeta:
        meta = ProjectMeta(
            id=uuid.uuid4().hex[:12],
            name=name.strip() or "Untitled project",
            brief=brief.strip(),
            created_at=_now_iso(),
            updated_at=_now_iso(),
        )
        project_dir = self._dir(meta.id)
        project_dir.mkdir(parents=True, exist_ok=False)
        (project_dir / "workspace").mkdir()
        self._write_meta(meta)
        return meta

    def get(self, project_id: str) -> ProjectMeta:
        meta_path = self._dir(project_id) / "project.json"
        if not meta_path.exists():
            raise ProjectNotFoundError(project_id)
        data = json.loads(meta_path.read_text())
        return ProjectMeta(
            id=data["id"],
            name=data["name"],
            brief=data.get("brief", ""),
            created_at=data.get("created_at", ""),
            updated_at=data.get("updated_at", ""),
            primary_model=data.get("primary_model", ""),
            subagent_model=data.get("subagent_model", ""),
            execution_mode=data.get("execution_mode", "auto"),
        )

    def list(self) -> List[ProjectMeta]:
        projects: List[ProjectMeta] = []
        if not self.root.exists():
            return projects
        for project_dir in sorted(self.root.iterdir()):
            if (project_dir / "project.json").exists():
                projects.append(self.get(project_dir.name))
        return projects

    def update(
        self,
        project_id: str,
        name: Optional[str] = None,
        brief: Optional[str] = None,
        primary_model: Optional[str] = None,
        subagent_model: Optional[str] = None,
        execution_mode: Optional[str] = None,
    ) -> ProjectMeta:
        meta = self.get(project_id)
        if name is not None and name.strip():
            meta.name = name.strip()
        if brief is not None:
            meta.brief = brief
        if primary_model is not None:
            meta.primary_model = primary_model.strip()
        if subagent_model is not None:
            meta.subagent_model = subagent_model.strip()
        if execution_mode is not None:
            if execution_mode not in ("auto", "single", "swarm"):
                raise ValueError(f"Invalid execution mode: {execution_mode}")
            meta.execution_mode = execution_mode
        meta.updated_at = _now_iso()
        self._write_meta(meta)
        return meta

    def delete(self, project_id: str) -> None:
        project_dir = self._dir(project_id)
        if not project_dir.exists():
            raise ProjectNotFoundError(project_id)
        shutil.rmtree(project_dir)

    def _write_meta(self, meta: ProjectMeta) -> None:
        path = self._dir(meta.id) / "project.json"
        path.write_text(json.dumps(meta.to_json(), indent=2))

    # --- workspace -------------------------------------------------------------
    def load_workspace(self, project_id: str) -> Workspace:
        """Load workspace files from disk into an in-memory Workspace."""
        self.get(project_id)  # raises when missing
        workspace_dir = self._dir(project_id) / "workspace"
        workspace = Workspace()
        if workspace_dir.exists():
            for file_path in sorted(workspace_dir.rglob("*")):
                if file_path.is_file():
                    relative = file_path.relative_to(workspace_dir).as_posix()
                    try:
                        workspace.files[relative] = file_path.read_text()
                    except UnicodeDecodeError:
                        # Binary assets are served from local_assets, not the
                        # workspace text map.
                        continue
        return workspace

    def save_workspace(self, project_id: str, workspace: Workspace) -> None:
        """Persist the in-memory workspace to disk (replacing prior files)."""
        self.get(project_id)
        workspace_dir = self._dir(project_id) / "workspace"
        if workspace_dir.exists():
            shutil.rmtree(workspace_dir)
        workspace_dir.mkdir(parents=True)
        for path, content in workspace.files.items():
            file_path = workspace_dir / path
            file_path.parent.mkdir(parents=True, exist_ok=True)
            file_path.write_text(content)
        meta = self.get(project_id)
        meta.updated_at = _now_iso()
        self._write_meta(meta)

    def workspace_file(self, project_id: str, relative_path: str) -> Path:
        """Path of a workspace file; caller must guard against traversal."""
        self.get(project_id)
        workspace_dir = (self._dir(project_id) / "workspace").resolve()
        candidate = (workspace_dir / relative_path).resolve()
        if not candidate.is_relative_to(workspace_dir):
            raise InvalidProjectPath(relative_path)
        return candidate

    # --- transcript --------------------------------------------------------------
    def append_transcript_message(
        self, project_id: str, message: TranscriptMessage, session_id: str = "main"
    ) -> None:
        transcript = self.read_transcript(project_id, session_id)
        transcript.append(message)
        self._write_transcript(project_id, session_id, transcript)

    def read_transcript(
        self, project_id: str, session_id: str = "main"
    ) -> List[TranscriptMessage]:
        path = self._transcript_path(project_id, session_id)
        if not path.exists():
            return []
        data = json.loads(path.read_text())
        return [
            TranscriptMessage(
                role=item["role"],
                text=item.get("text", ""),
                created_at=item.get("created_at", ""),
                run_id=item.get("run_id"),
                images=item.get("images", []),
            )
            for item in data
        ]

    def _write_transcript(
        self,
        project_id: str,
        session_id: str,
        messages: List[TranscriptMessage],
    ) -> None:
        path = self._transcript_path(project_id, session_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps([m.to_json() for m in messages]))

    # --- execution records -----------------------------------------------------
    #
    # Every execution snapshots its resolved model configuration at start;
    # later settings changes never rewrite history.

    def start_run_record(
        self, project_id: str, run_id: str, config: Dict[str, str]
    ) -> None:
        self.get(project_id)
        record = {
            "run_id": run_id,
            "status": "running",
            "started_at": _now_iso(),
            "finished_at": None,
            # Resolved effective configuration for THIS execution.
            "config": config,
            "files_changed": [],
            "iteration_id": None,
            "error": None,
        }
        record_path = self._run_record_path(project_id, run_id)
        record_path.parent.mkdir(parents=True, exist_ok=True)
        record_path.write_text(json.dumps(record))

    def finish_run_record(
        self,
        project_id: str,
        run_id: str,
        status: str,
        files_changed: Optional[List[str]] = None,
        iteration_id: Optional[str] = None,
        error: Optional[str] = None,
    ) -> None:
        path = self._run_record_path(project_id, run_id)
        if not path.exists():
            return
        record = json.loads(path.read_text())
        record["status"] = status
        record["finished_at"] = _now_iso()
        if files_changed is not None:
            record["files_changed"] = files_changed
        if iteration_id is not None:
            record["iteration_id"] = iteration_id
        if error is not None:
            record["error"] = error
        path.write_text(json.dumps(record))

    def get_run_record(self, project_id: str, run_id: str) -> Optional[Dict[str, str]]:
        path = self._run_record_path(project_id, run_id)
        if not path.exists():
            return None
        return json.loads(path.read_text())

    def list_run_records(self, project_id: str) -> List[Dict[str, str]]:
        runs_dir = self._dir(project_id) / "runs"
        if not runs_dir.exists():
            return []
        records = []
        for path in sorted(runs_dir.glob("*.json")):
            records.append(json.loads(path.read_text()))
        return records

    def _run_record_path(self, project_id: str, run_id: str) -> Path:
        return self._dir(project_id) / "runs" / f"{run_id}.json"

    # --- iterations --------------------------------------------------------------
    #
    # An iteration is a meaningful checkpoint: a completed execution's
    # workspace snapshot plus its change summary. Failed and cancelled runs
    # never create iterations.

    def save_iteration(
        self,
        project_id: str,
        run_id: str,
        workspace: Workspace,
        label: str,
        summary: str,
    ) -> Dict[str, str]:
        meta = self.get(project_id)
        iterations_dir = self._dir(project_id) / "iterations"
        iterations_dir.mkdir(exist_ok=True)
        index = len(self.list_iterations(project_id)) + 1
        iteration_id = f"i{index:03d}"
        snapshot_dir = iterations_dir / iteration_id
        if snapshot_dir.exists():
            shutil.rmtree(snapshot_dir)
        snapshot_dir.mkdir()
        for path, content in workspace.files.items():
            file_path = snapshot_dir / path
            file_path.parent.mkdir(parents=True, exist_ok=True)
            file_path.write_text(content)
        record = {
            "id": iteration_id,
            "run_id": run_id,
            "label": label,
            "summary": summary,
            "created_at": _now_iso(),
        }
        (snapshot_dir / "iteration.json").write_text(json.dumps(record))
        meta.updated_at = _now_iso()
        self._write_meta(meta)
        return record

    def list_iterations(self, project_id: str) -> List[Dict[str, str]]:
        iterations_dir = self._dir(project_id) / "iterations"
        if not iterations_dir.exists():
            return []
        records = []
        for path in sorted(iterations_dir.glob("i*/iteration.json")):
            records.append(json.loads(path.read_text()))
        return records

    def iteration_file(self, project_id: str, iteration_id: str, relative: str) -> Path:
        """Path inside an iteration snapshot; traversal-guarded."""
        self.get(project_id)
        if not iteration_id.replace("i", "").isdigit():
            raise InvalidProjectPath(iteration_id)
        base = (self._dir(project_id) / "iterations" / iteration_id).resolve()
        candidate = (base / relative).resolve()
        if not candidate.is_relative_to(base):
            raise InvalidProjectPath(relative)
        return candidate

    # --- paths --------------------------------------------------------------------
    def _dir(self, project_id: str) -> Path:
        return self.root / project_id

    def _transcript_path(self, project_id: str, session_id: str) -> Path:
        self.get(project_id)
        return self._dir(project_id) / "sessions" / f"{session_id}.json"


class InvalidProjectPath(ValueError):
    pass


def default_store() -> ProjectStore:
    """Store rooted at the platform data dir (env-overridable)."""
    import os

    root = os.environ.get("SCREENSHOT_TO_CODE_DATA_DIR")
    if root:
        return ProjectStore(Path(root) / "projects")
    return ProjectStore(Path.home() / ".screenshot-to-code" / "projects")
