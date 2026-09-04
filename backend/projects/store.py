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
        self, project_id: str, name: Optional[str] = None, brief: Optional[str] = None
    ) -> ProjectMeta:
        meta = self.get(project_id)
        if name is not None and name.strip():
            meta.name = name.strip()
        if brief is not None:
            meta.brief = brief
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
