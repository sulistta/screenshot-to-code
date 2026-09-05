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
import hashlib
import re
import shutil
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

from agent.workspace import InvalidWorkspacePath, Workspace, normalize_path
from projects.persistence import atomic_json, sync_directory, write_bytes
from projects.database import ProjectDatabase


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
        self.database = ProjectDatabase(self.root)

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
        data = self.database.get(meta_path)
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
        self.database.delete_project(project_id)

    def _write_meta(self, meta: ProjectMeta) -> None:
        path = self._dir(meta.id) / "project.json"
        atomic_json(path, meta.to_json())
        self.database.put(path, meta.to_json())

    # --- workspace -------------------------------------------------------------
    def load_workspace(self, project_id: str) -> Workspace:
        """Load workspace files from disk into an in-memory Workspace."""
        self.get(project_id)  # raises when missing
        workspace_dir = self._workspace_root(project_id)
        workspace = Workspace()
        if workspace_dir.exists():
            for file_path in sorted(workspace_dir.rglob("*")):
                if file_path.is_symlink():
                    raise InvalidProjectPath(str(file_path))
                if file_path.is_file():
                    relative = file_path.relative_to(workspace_dir).as_posix()
                    try:
                        workspace.files[relative] = file_path.read_text(encoding="utf-8")
                    except UnicodeDecodeError:
                        # Binary assets are served from local_assets, not the
                        # workspace text map.
                        continue
        return workspace

    def save_workspace(self, project_id: str, workspace: Workspace, *, binary_source: Optional[Path] = None) -> None:
        """Publish a complete generation through an atomic pointer.

        Legacy workspace/ directories are read unchanged until the first save.
        Previous generations stay available, including paths held by in-flight
        FileResponses. Retention/GC belongs to the upcoming revision store.
        """
        meta = self.get(project_id)
        revision = uuid.uuid4().hex
        snapshots = self._dir(project_id) / "workspaces"
        snapshots.mkdir(exist_ok=True)
        destination = snapshots / revision
        self._write_snapshot(project_id, destination, workspace, binary_source=binary_source)
        atomic_json(snapshots / f"{revision}.manifest.json", self.manifest(destination))
        sync_directory(snapshots)
        meta.updated_at = _now_iso()
        self._write_meta(meta)
        atomic_json(
            self._dir(project_id) / "workspace-state.json",
            {"version": 1, "revision": revision},
        )

    def _workspace_root(self, project_id: str) -> Path:
        project_dir = self._dir(project_id)
        pointer = project_dir / "workspace-state.json"
        if not pointer.exists():
            return project_dir / "workspace"
        state = json.loads(pointer.read_text(encoding="utf-8"))
        revision = state.get("revision", "")
        if state.get("version") != 1 or not re.fullmatch(r"[a-f0-9]{32}", revision):
            raise InvalidProjectPath("Invalid workspace pointer")
        return self._contained(project_dir, f"workspaces/{revision}")

    def _write_snapshot(
        self, project_id: str, destination: Path, workspace: Workspace, *, binary_source: Optional[Path] = None
    ) -> None:
        destination.mkdir(parents=True, exist_ok=False)
        # Binary files cannot be represented by Workspace.files. Preserve them
        # when importing an existing workspace instead of silently deleting them.
        source = binary_source if binary_source is not None else self._workspace_root(project_id)
        if source.exists():
            for file_path in source.rglob("*"):
                if file_path.is_symlink():
                    raise InvalidProjectPath(str(file_path))
                if not file_path.is_file():
                    continue
                relative = file_path.relative_to(source).as_posix()
                if relative in workspace.files:
                    continue
                data = file_path.read_bytes()
                try:
                    data.decode("utf-8")
                except UnicodeDecodeError:
                    write_bytes(destination / relative, data)
        for relative, content in workspace.files.items():
            try:
                normalized = normalize_path(relative)
            except InvalidWorkspacePath as exc:
                raise InvalidProjectPath(relative) from exc
            if normalized != relative or "\x00" in relative:
                raise InvalidProjectPath(relative)
            write_bytes(destination / normalized, content.encode("utf-8"))
        for directory in sorted(
            (p for p in destination.rglob("*") if p.is_dir()),
            key=lambda p: len(p.parts), reverse=True,
        ):
            sync_directory(directory)
        sync_directory(destination)

    @staticmethod
    def manifest(base: Path) -> Dict[str, str]:
        return {path.relative_to(base).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                for path in sorted(base.rglob("*")) if path.is_file() and not path.is_symlink()}

    def workspace_file(self, project_id: str, relative_path: str) -> Path:
        """Path of a workspace file; caller must guard against traversal."""
        self.get(project_id)
        return self._contained(self._workspace_root(project_id), relative_path)

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
        data = self.database.get(path)
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
        atomic_json(path, [m.to_json() for m in messages])
        self.database.put(path, [m.to_json() for m in messages])

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
        atomic_json(record_path, record)
        self.database.put(record_path, record)

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
        record = self.database.get(path)
        record["status"] = status
        record["finished_at"] = _now_iso()
        if files_changed is not None:
            record["files_changed"] = files_changed
        if iteration_id is not None:
            record["iteration_id"] = iteration_id
        if error is not None:
            record["error"] = error
        atomic_json(path, record)
        self.database.put(path, record)

    def get_run_record(self, project_id: str, run_id: str) -> Optional[Dict[str, str]]:
        path = self._run_record_path(project_id, run_id)
        if not path.exists():
            return None
        return self.database.get(path)

    def list_run_records(self, project_id: str) -> List[Dict[str, str]]:
        runs_dir = self._dir(project_id) / "runs"
        if not runs_dir.exists():
            return []
        records = []
        for path in sorted(runs_dir.glob("*.json")):
            records.append(self.database.get(path))
        return records

    def _run_record_path(self, project_id: str, run_id: str) -> Path:
        self._validate_id(run_id)
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
        index = max(
            (int(p.name[1:]) for p in iterations_dir.iterdir()
             if re.fullmatch(r"i\d+", p.name)), default=0,
        ) + 1
        iteration_id = f"i{index:03d}"
        snapshot_dir = iterations_dir / iteration_id
        staging = iterations_dir / f".staging-{uuid.uuid4().hex}"
        self._write_snapshot(project_id, staging / "files", workspace)
        atomic_json(staging / "manifest.json", self.manifest(staging / "files"))
        record = {
            "id": iteration_id,
            "run_id": run_id,
            "label": label,
            "summary": summary,
            "created_at": _now_iso(),
            "format_version": "2",
        }
        atomic_json(staging / "iteration.json", record)
        meta.updated_at = _now_iso()
        self._write_meta(meta)
        staging.rename(snapshot_dir)
        sync_directory(iterations_dir)
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
        if not re.fullmatch(r"i\d+", iteration_id):
            raise InvalidProjectPath(iteration_id)
        base = self._contained(self._dir(project_id), f"iterations/{iteration_id}")
        record_path = base / "iteration.json"
        if record_path.exists():
            record = json.loads(record_path.read_text(encoding="utf-8"))
            if record.get("format_version") == "2":
                base = base / "files"
        return self._contained(base, relative)

    # --- paths --------------------------------------------------------------------
    def _dir(self, project_id: str) -> Path:
        self._validate_id(project_id)
        candidate = self.root / project_id
        if candidate.is_symlink():
            raise ProjectNotFoundError(project_id)
        return candidate

    @staticmethod
    def _validate_id(identifier: str) -> None:
        if not re.fullmatch(r"[A-Za-z0-9_-]+", identifier):
            raise ProjectNotFoundError(identifier)

    @staticmethod
    def _contained(base: Path, relative: str) -> Path:
        candidate = (base / relative).resolve()
        if not candidate.is_relative_to(base.resolve()):
            raise InvalidProjectPath(relative)
        return candidate

    def _transcript_path(self, project_id: str, session_id: str) -> Path:
        self.get(project_id)
        self._validate_id(session_id)
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
