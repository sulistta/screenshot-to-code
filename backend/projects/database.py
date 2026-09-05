"""Transactional metadata documents with a verified, idempotent legacy import."""
import hashlib
import json
import shutil
from pathlib import Path
from typing import Any

from sqlalchemy import Column, MetaData, String, Table, Text, create_engine, event, select
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.engine import Engine


metadata = MetaData()
documents = Table(
    "documents", metadata,
    Column("path", String, primary_key=True),
    Column("payload", Text, nullable=False),
)
migrations = Table(
    "studio_migrations", metadata,
    Column("name", String, primary_key=True),
    Column("manifest", Text, nullable=False),
)


class ProjectDatabase:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.engine: Engine = create_engine(
            f"sqlite:///{root / '.studio.sqlite3'}",
            connect_args={"timeout": 10},
        )

        @event.listens_for(self.engine, "connect")
        def configure(dbapi_connection: Any, connection_record: Any) -> None:
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA synchronous=FULL")
            cursor.close()

        metadata.create_all(self.engine)
        self.import_legacy()

    def import_legacy(self) -> None:
        with self.engine.begin() as connection:
            if connection.execute(select(migrations.c.name).where(
                migrations.c.name == "legacy-json-v1"
            )).first():
                return
            paths: list[Path] = []
            for directory in self.root.iterdir():
                if not directory.is_dir() or directory.is_symlink() or directory.name.startswith("."):
                    continue
                if not (directory / "project.json").exists():
                    continue
                paths.append(directory / "project.json")
                paths.extend(directory.glob("sessions/*.json"))
                paths.extend(directory.glob("runs/*.json"))
            backup = self.root / ".migration-backup-v1"
            manifest: dict[str, str] = {}
            for path in paths:
                relative = path.relative_to(self.root).as_posix()
                raw = path.read_bytes()
                value = json.loads(raw)
                target = backup / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                if not target.exists():
                    shutil.copy2(path, target)
                digest = hashlib.sha256(raw).hexdigest()
                if hashlib.sha256(target.read_bytes()).hexdigest() != digest:
                    raise ValueError(f"Legacy backup differs: {relative}")
                manifest[relative] = digest
                connection.execute(insert(documents).values(
                    path=relative, payload=json.dumps(value)
                ).on_conflict_do_nothing(index_elements=[documents.c.path]))
            connection.execute(insert(migrations).values(
                name="legacy-json-v1", manifest=json.dumps(manifest)
            ))

    def get(self, path: Path) -> Any:
        key = path.relative_to(self.root).as_posix()
        with self.engine.connect() as connection:
            value = connection.execute(select(documents.c.payload).where(
                documents.c.path == key
            )).scalar_one_or_none()
        if value is not None:
            return json.loads(value)
        return json.loads(path.read_text(encoding="utf-8"))

    def put(self, path: Path, value: object) -> None:
        key = path.relative_to(self.root).as_posix()
        payload = json.dumps(value, ensure_ascii=False)
        with self.engine.begin() as connection:
            connection.execute(insert(documents).values(path=key, payload=payload)
                .on_conflict_do_update(index_elements=[documents.c.path], set_={"payload": payload}))

    def delete_project(self, project_id: str) -> None:
        with self.engine.begin() as connection:
            connection.execute(documents.delete().where(documents.c.path.startswith(project_id + "/")))

    def list_prefix(self, prefix: str) -> list[tuple[str, Any]]:
        """Documents whose path starts with prefix, as (relative path, value)."""
        with self.engine.connect() as connection:
            rows = connection.execute(
                select(documents.c.path, documents.c.payload).where(
                    documents.c.path.startswith(prefix)
                ).order_by(documents.c.path)
            ).fetchall()
        return [(str(path), json.loads(payload)) for path, payload in rows]
