"""Application operations shared by the Studio API and future local clients."""
import difflib
import hashlib
import io
import json
import zipfile
from pathlib import Path
from typing import Any

from agent.workspace import Workspace
from projects.store import ProjectStore
from projects.preview_policy import is_private_path


class RevisionConflict(ValueError):
    pass


class ProjectService:
    def __init__(self, store: ProjectStore) -> None:
        self.store = store

    def revision(self, project_id: str) -> str:
        files = self.store.manifest(self.store.workspace_file(project_id, "index.html").parent)
        return hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()

    def files(self, project_id: str) -> dict[str, Any]:
        workspace = self.store.load_workspace(project_id)
        return {"revision": self.revision(project_id), "files": workspace.files}

    def write_file(self, project_id: str, path: str, content: str, revision: str) -> dict[str, Any]:
        if revision != self.revision(project_id):
            raise RevisionConflict("The project changed. Reload before saving your draft.")
        workspace = self.store.load_workspace(project_id)
        workspace.write(path, content)
        self.store.save_workspace(project_id, workspace)
        version = self.store.save_iteration(project_id, "manual", workspace, "Manual edit", f"Edited {path}")
        return {**self.files(project_id), "iteration": version}

    def snapshot(self, project_id: str, iteration_id: str) -> Workspace:
        entry = self.store.iteration_file(project_id, iteration_id, "index.html")
        base = entry.parent
        if not base.is_dir():
            raise FileNotFoundError(iteration_id)
        files: dict[str, str] = {}
        for path in base.rglob("*"):
            if not path.is_file() or path.is_symlink():
                continue
            relative = path.relative_to(base).as_posix()
            if relative == "iteration.json" and base.name != "files":
                continue
            try:
                files[relative] = path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue
        return Workspace(files=files)

    def restore(self, project_id: str, iteration_id: str, revision: str) -> dict[str, Any]:
        if self.revision(project_id) != revision:
            raise RevisionConflict("The project changed. Reload before restoring.")
        workspace = self.snapshot(project_id, iteration_id)
        self.store.save_workspace(project_id, workspace,
                                  binary_source=self.store.iteration_file(project_id, iteration_id, "index.html").parent)
        return self.store.save_iteration(project_id, "restore", workspace,
                                         f"Restored {iteration_id}", f"Restored from {iteration_id}")

    def diff(self, project_id: str, iteration_id: str) -> dict[str, Any]:
        before = self.snapshot(project_id, iteration_id).files
        after = self.store.load_workspace(project_id).files
        changes = []
        for path in sorted(before.keys() | after.keys()):
            if before.get(path) == after.get(path):
                continue
            changes.append({"path": path,
                "kind": "added" if path not in before else "deleted" if path not in after else "modified",
                "diff": "".join(difflib.unified_diff(
                    before.get(path, "").splitlines(keepends=True),
                    after.get(path, "").splitlines(keepends=True), fromfile=path, tofile=path,
                ))})
        return {"changes": changes, "revision": self.revision(project_id)}

    def export(self, project_id: str) -> bytes:
        entry = self.store.workspace_file(project_id, "index.html")
        base = entry.parent
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
            for path in base.rglob("*"):
                relative = path.relative_to(base)
                if path.is_symlink() or not path.is_file():
                    continue
                if is_private_path(relative.as_posix()):
                    continue
                archive.write(path, relative.as_posix())
        return output.getvalue()
