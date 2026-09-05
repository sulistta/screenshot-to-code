import io
import stat
import zipfile
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from agent.workspace import Workspace
from projects.portability import import_zip, checkpoint
from projects.service import ProjectService
from projects.store import ProjectStore
from studio_security import BrowserOriginBoundary


def archive_bytes(files: dict[str, bytes]) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        for name, data in files.items():
            archive.writestr(name, data)
    return output.getvalue()


def test_import_preserves_binary_and_filters_secrets(tmp_path: Path) -> None:
    store = ProjectStore(tmp_path)
    project = store.create("Import", "")
    import_zip(store, project.id, archive_bytes({
        "sample/index.html": b"<html></html>", "sample/image.png": b"\x89PNG\xff",
        "sample/.env": b"SECRET=hidden", "sample/data/private.sqlite": b"private",
    }))
    assert store.workspace_file(project.id, "image.png").read_bytes() == b"\x89PNG\xff"
    assert ".env" not in store.load_workspace(project.id).files
    assert not store.workspace_file(project.id, "data/private.sqlite").exists()
    with pytest.raises(ValueError, match="empty project"):
        import_zip(store, project.id, archive_bytes({"index.html": b"replacement"}))


@pytest.mark.parametrize("name", ["../escape", "/absolute", "foo/../../escape", "foo\\bar"])
def test_import_rejects_unsafe_paths(tmp_path: Path, name: str) -> None:
    store = ProjectStore(tmp_path)
    project = store.create("Import", "")
    with pytest.raises(ValueError):
        import_zip(store, project.id, archive_bytes({name: b"unsafe"}))
    assert store.load_workspace(project.id).files == {}


def test_import_rejects_symlink(tmp_path: Path) -> None:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        link = zipfile.ZipInfo("link")
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(link, "/etc/passwd")
    store = ProjectStore(tmp_path)
    project = store.create("Import", "")
    with pytest.raises(ValueError, match="symbolic link"):
        import_zip(store, project.id, output.getvalue())


def test_restoring_version_restores_its_binary_assets(tmp_path: Path) -> None:
    store = ProjectStore(tmp_path)
    project = store.create("Restore", "")
    store.workspace_file(project.id, "image.png").write_bytes(b"\xffold")
    workspace = Workspace(files={"index.html": "old"})
    store.save_workspace(project.id, workspace)
    version = store.save_iteration(project.id, "first", workspace, "First", "")
    source = tmp_path / "replacement"
    source.mkdir()
    (source / "image.png").write_bytes(b"\xffnew")
    store.save_workspace(project.id, Workspace(files={"index.html": "new"}), binary_source=source)
    service = ProjectService(store)
    service.restore(project.id, version["id"], service.revision(project.id))
    assert store.workspace_file(project.id, "image.png").read_bytes() == b"\xffold"


@pytest.mark.asyncio
async def test_git_checkpoint_is_local_and_excludes_private_data(tmp_path: Path) -> None:
    store = ProjectStore(tmp_path)
    project = store.create("Git", "")
    store.save_workspace(project.id, Workspace(files={"index.html": "hello", ".env": "secret"}))
    commit = await checkpoint(ProjectService(store), project.id, "Initial version")
    assert len(commit) == 40
    repository = tmp_path / project.id / "repository"
    assert (repository / "index.html").read_text() == "hello"
    assert not (repository / ".env").exists()


def test_opaque_preview_origin_cannot_mutate_control_api() -> None:
    app = FastAPI()
    app.add_middleware(BrowserOriginBoundary)

    @app.post("/api/projects")
    async def create() -> dict[str, bool]:
        return {"ok": True}

    with TestClient(app) as client:
        assert client.post("/api/projects", headers={"Origin": "null"}).status_code == 403
        assert client.post("/api/projects", headers={"Origin": "https://untrusted.example"}).status_code == 403
        assert client.post("/api/projects", headers={"Origin": "http://localhost:5173"}).status_code == 200
