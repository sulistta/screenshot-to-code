"""Regression tests for atomic publication and immutable version files."""
import json
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from agent.workspace import Workspace
from projects.manager import ProjectRunManager
from projects.store import InvalidProjectPath, ProjectNotFoundError, ProjectStore
from routes import projects


def test_failed_publication_keeps_the_previous_generation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = ProjectStore(tmp_path)
    project = store.create("Atomic", "")
    store.save_workspace(project.id, Workspace(content="old"))
    previous_path = store.workspace_file(project.id, "index.html")
    real_write = __import__("projects.store", fromlist=["atomic_json"]).atomic_json

    def fail_pointer(path: Path, value: object) -> None:
        if path.name == "workspace-state.json":
            raise OSError("disk full")
        real_write(path, value)

    monkeypatch.setattr("projects.store.atomic_json", fail_pointer)
    with pytest.raises(OSError):
        store.save_workspace(project.id, Workspace(content="new"))
    assert store.load_workspace(project.id).content == "old"
    assert previous_path.read_text() == "old"
    # The committed pointer remains usable after a process restart.
    assert ProjectStore(tmp_path).load_workspace(project.id).content == "old"


def test_failed_snapshot_write_is_invisible(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = ProjectStore(tmp_path)
    project = store.create("Atomic", "")
    store.save_workspace(project.id, Workspace(content="old"))

    def fail_write(path: Path, content: bytes) -> None:
        raise OSError("disk full")

    monkeypatch.setattr("projects.store.write_bytes", fail_write)
    with pytest.raises(OSError):
        store.save_workspace(project.id, Workspace(content="new"))
    assert store.load_workspace(project.id).content == "old"


def test_legacy_workspace_and_binary_assets_survive_save(tmp_path: Path) -> None:
    store = ProjectStore(tmp_path)
    project = store.create("Legacy", "")
    legacy = tmp_path / project.id / "workspace"
    (legacy / "index.html").write_text("old")
    (legacy / "obsolete.css").write_text("body{}")
    (legacy / "logo.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    workspace = store.load_workspace(project.id)
    workspace.write("index.html", "new")
    del workspace.files["obsolete.css"]
    store.save_workspace(project.id, workspace)
    assert store.load_workspace(project.id).files == {"index.html": "new"}
    assert store.workspace_file(project.id, "logo.png").read_bytes() == b"\x89PNG\r\n\x1a\n"
    assert not store.workspace_file(project.id, "obsolete.css").exists()
    assert (legacy / "index.html").read_text() == "old"


def test_versions_are_atomic_and_do_not_overwrite_project_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = ProjectStore(tmp_path)
    project = store.create("Versions", "")
    workspace = Workspace(files={"index.html": "first", "iteration.json": "user data"})
    first = store.save_iteration(project.id, "r1", workspace, "First", "")
    assert store.iteration_file(project.id, first["id"], "iteration.json").read_text() == "user data"

    def fail_write(path: Path, content: bytes) -> None:
        raise OSError("disk full")

    with monkeypatch.context() as context:
        context.setattr("projects.store.write_bytes", fail_write)
        with pytest.raises(OSError):
            store.save_iteration(project.id, "r2", Workspace(content="second"), "Second", "")
    assert store.list_iterations(project.id) == [first]
    second = store.save_iteration(project.id, "r2", Workspace(content="second"), "Second", "")
    assert second["id"] == "i002"
    assert store.iteration_file(project.id, first["id"], "index.html").read_text() == "first"


@pytest.mark.parametrize("identifier", ["..", "../other", "/tmp", "a/b", "a\\b"])
def test_project_ids_cannot_escape_the_store(tmp_path: Path, identifier: str) -> None:
    with pytest.raises(ProjectNotFoundError):
        ProjectStore(tmp_path).get(identifier)


def test_unvalidated_workspace_map_cannot_escape_snapshot(tmp_path: Path) -> None:
    store = ProjectStore(tmp_path)
    project = store.create("Paths", "")
    store.save_workspace(project.id, Workspace(content="safe"))
    with pytest.raises(InvalidProjectPath):
        store.save_workspace(project.id, Workspace(files={"../project.json": "bad"}))
    assert store.load_workspace(project.id).content == "safe"


def test_legacy_iteration_remains_readable(tmp_path: Path) -> None:
    store = ProjectStore(tmp_path)
    project = store.create("Legacy", "")
    old = tmp_path / project.id / "iterations" / "i001"
    old.mkdir(parents=True)
    (old / "iteration.json").write_text(json.dumps({"id": "i001", "label": "Old"}))
    (old / "index.html").write_text("legacy")
    assert store.iteration_file(project.id, "i001", "index.html").read_text() == "legacy"


def test_live_and_historical_entries_resolve_relative_resources(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = ProjectStore(tmp_path)
    manager = ProjectRunManager(store)
    monkeypatch.setattr(projects, "_manager", manager)
    app = FastAPI()
    app.include_router(projects.router)
    project = store.create("Preview", "")
    workspace = Workspace(files={
        "index.html": '<link rel="stylesheet" href="styles.css"><script src="app.js"></script>',
        "styles.css": 'body{background:red}', "app.js": "window.loaded=true;",
        "assets/logo.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
    })
    store.save_workspace(project.id, workspace)
    iteration = store.save_iteration(project.id, "r1", workspace, "First", "")
    with TestClient(app) as client:
        for path in (
            f"/workspace/{project.id}",
            f"/workspace/{project.id}/",
            f"/api/projects/{project.id}/iterations/{iteration['id']}",
        ):
            response = client.get(path)
            assert response.status_code == 200
            for resource in ("styles.css", "app.js", "assets/logo.svg"):
                asset = client.get(urljoin(str(response.url), resource))
                assert asset.status_code == 200
                assert asset.text == workspace.files[resource]
