import io
import zipfile
from pathlib import Path

import pytest
from agent.workspace import Workspace
from projects.event_store import EventJournal
from projects.service import ProjectService, RevisionConflict
from projects.store import ProjectStore


def test_journal_survives_restart_and_replays_after_cursor(tmp_path: Path) -> None:
    journal = EventJournal(tmp_path / "events.sqlite3")
    first = journal.append("p", {"type": "assistant_delta", "text": "hello"})
    journal.append("other", {"type": "status"})
    second = journal.append("p", {"type": "run_status", "status": "completed"})
    reopened = EventJournal(tmp_path / "events.sqlite3")
    assert reopened.stream_id == journal.stream_id
    assert reopened.read("p", first["sequence"]) == [second]


def test_file_edit_conflict_restore_and_export(tmp_path: Path) -> None:
    store = ProjectStore(tmp_path)
    project = store.create("Workbench", "")
    store.save_workspace(project.id, Workspace(files={
        "index.html": "<html>first</html>", "styles.css": "body{}", ".env": "SECRET=value"
    }))
    service = ProjectService(store)
    revision = service.revision(project.id)
    edited = service.write_file(project.id, "styles.css", "body{color:red}", revision)
    with pytest.raises(RevisionConflict):
        service.write_file(project.id, "styles.css", "stale", revision)
    newer = service.write_file(project.id, "styles.css", "body{color:blue}", edited["revision"])
    diff = service.diff(project.id, edited["iteration"]["id"])
    assert diff["changes"][0]["path"] == "styles.css"
    service.restore(project.id, edited["iteration"]["id"], newer["revision"])
    assert store.load_workspace(project.id).files["styles.css"] == "body{color:red}"
    assert len(store.list_iterations(project.id)) == 3
    with zipfile.ZipFile(io.BytesIO(service.export(project.id))) as archive:
        assert ".env" not in archive.namelist()
        assert archive.read("styles.css") == b"body{color:red}"


def test_database_import_is_verified_and_idempotent(tmp_path: Path) -> None:
    import json
    from projects.database import ProjectDatabase
    project_dir = tmp_path / "p"
    project_dir.mkdir()
    source = project_dir / "project.json"
    source.write_text(json.dumps({"id": "p", "name": "Legacy"}))
    database = ProjectDatabase(tmp_path)
    assert database.get(source)["name"] == "Legacy"
    database.put(source, {"id": "p", "name": "Updated"})
    database.engine.dispose()
    reopened = ProjectDatabase(tmp_path)
    assert reopened.get(source)["name"] == "Updated"
    assert json.loads((tmp_path / ".migration-backup-v1/p/project.json").read_text())["name"] == "Legacy"


def test_restart_finishes_interrupted_run_once(tmp_path: Path) -> None:
    from projects.manager import ProjectRunManager
    store = ProjectStore(tmp_path)
    project = store.create("Interrupted", "")
    store.start_run_record(project.id, "run1", {})
    manager = ProjectRunManager(store)
    record = store.get_run_record(project.id, "run1")
    assert record is not None and record["status"] == "failed"
    assert manager.journal.read(project.id)[-1]["status"] == "failed"
    ProjectRunManager(store)
    assert len(store.read_transcript(project.id)) == 1
