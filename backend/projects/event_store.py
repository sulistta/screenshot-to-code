"""Transactional, cursor-addressable event journal for project runs."""
import json
import sqlite3
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


class EventJournal:
    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS journal_meta (
                    key TEXT PRIMARY KEY, value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS events (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id TEXT NOT NULL,
                    payload TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS events_project_sequence
                    ON events(project_id, sequence);
            """)
            db.execute("INSERT OR IGNORE INTO journal_meta VALUES ('stream_id', ?)",
                       (uuid.uuid4().hex,))
            self.stream_id = str(db.execute(
                "SELECT value FROM journal_meta WHERE key='stream_id'"
            ).fetchone()[0])

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.path, timeout=10)
        try:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA synchronous=FULL")
            with db:
                yield db
        finally:
            db.close()

    def append(self, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        with self.connection() as db:
            cursor = db.execute(
                "INSERT INTO events(project_id, payload) VALUES (?, ?)",
                (project_id, json.dumps(payload)),
            )
            return {**payload, "projectId": project_id,
                    "streamId": self.stream_id, "sequence": cursor.lastrowid}

    def read(self, project_id: str, after: int = 0, limit: int = 500) -> list[dict[str, Any]]:
        with self.connection() as db:
            rows = db.execute(
                "SELECT sequence, payload FROM events WHERE project_id=? AND sequence>? "
                "ORDER BY sequence LIMIT ?", (project_id, after, limit),
            ).fetchall()
        return [{**json.loads(payload), "projectId": project_id,
                 "streamId": self.stream_id, "sequence": sequence}
                for sequence, payload in rows]

    def prune(self, project_id: str, keep: int = 1000) -> None:
        """Retention: keep only the newest `keep` events of a project."""
        with self.connection() as db:
            db.execute(
                "DELETE FROM events WHERE project_id=? AND sequence NOT IN "
                "(SELECT sequence FROM events WHERE project_id=? "
                "ORDER BY sequence DESC LIMIT ?)",
                (project_id, project_id, keep),
            )

    def delete_project(self, project_id: str) -> None:
        with self.connection() as db:
            db.execute("DELETE FROM events WHERE project_id=?", (project_id,))
