"""Transactional, cursor-addressable event journal for project runs.

Runs stream events (including every assistant delta) through this journal,
so a single persistent connection is used instead of one connection per
append — the per-event connect/PRAGMA/commit cycle dominated streaming
latency. All calls happen on the backend's event loop and never interleave
(no awaits inside the methods), so no extra locking is needed.
"""
import json
import sqlite3
import uuid
from pathlib import Path
from typing import Any


class EventJournal:
    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(self.path, timeout=10)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=FULL")
        with self._db:
            self._db.executescript("""
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
            self._db.execute(
                "INSERT OR IGNORE INTO journal_meta VALUES ('stream_id', ?)",
                (uuid.uuid4().hex,),
            )
            self.stream_id = str(self._db.execute(
                "SELECT value FROM journal_meta WHERE key='stream_id'"
            ).fetchone()[0])

    def _decorate(
        self, project_id: str, rows: list[tuple[int, str]]
    ) -> list[dict[str, Any]]:
        return [
            {**json.loads(payload), "projectId": project_id,
             "streamId": self.stream_id, "sequence": sequence}
            for sequence, payload in rows
        ]

    def append(self, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        cursor = self._db.execute(
            "INSERT INTO events(project_id, payload) VALUES (?, ?)",
            (project_id, json.dumps(payload)),
        )
        self._db.commit()
        return {**payload, "projectId": project_id,
                "streamId": self.stream_id, "sequence": cursor.lastrowid}

    def read(self, project_id: str, after: int = 0, limit: int = 500) -> list[dict[str, Any]]:
        rows = self._db.execute(
            "SELECT sequence, payload FROM events WHERE project_id=? AND sequence>? "
            "ORDER BY sequence LIMIT ?", (project_id, after, limit),
        ).fetchall()
        return self._decorate(project_id, rows)

    def prune(self, project_id: str, keep: int = 1000) -> None:
        """Retention: keep only the newest `keep` events of a project."""
        with self._db:
            self._db.execute(
                "DELETE FROM events WHERE project_id=? AND sequence NOT IN "
                "(SELECT sequence FROM events WHERE project_id=? "
                "ORDER BY sequence DESC LIMIT ?)",
                (project_id, project_id, keep),
            )

    def delete_project(self, project_id: str) -> None:
        with self._db:
            self._db.execute("DELETE FROM events WHERE project_id=?", (project_id,))
