"""Bounded archive import and local-only Git checkpoints."""
import asyncio
import io
import os
import shutil
import stat
import tempfile
import zipfile
from pathlib import Path

from agent.workspace import Workspace, normalize_path
from projects.preview_policy import is_private_path
from projects.service import ProjectService
from projects.store import ProjectStore


def import_zip(store: ProjectStore, project_id: str, data: bytes) -> None:
    if store.load_workspace(project_id).files:
        raise ValueError("Import into an empty project to preserve existing work")
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise ValueError("Choose a valid ZIP archive") from exc
    with archive, tempfile.TemporaryDirectory(prefix="studio-import-") as temporary:
        root = Path(temporary)
        total = 0
        seen: set[str] = set()
        if len(archive.infolist()) > 2000:
            raise ValueError("Archive contains more than 2,000 entries")
        for item in archive.infolist():
            raw = item.filename.rstrip("/")
            path = normalize_path(raw)
            if path != raw or "\x00" in raw or stat.S_ISLNK(item.external_attr >> 16):
                raise ValueError("Archive contains an unsafe path or symbolic link")
            if path in seen:
                raise ValueError("Archive contains duplicate paths")
            seen.add(path)
            if is_private_path(path):
                continue
            total += item.file_size
            if total > 100_000_000 or item.file_size > 10_000_000:
                raise ValueError("Unpacked archive exceeds the 100 MB / 10 MB per-file limit")
            target = root / path
            if item.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(item))
        # GitHub-style ZIPs wrap the project in a single directory.
        entries = list(root.iterdir())
        source = entries[0] if len(entries) == 1 and entries[0].is_dir() else root
        files: dict[str, str] = {}
        for path in source.rglob("*"):
            if path.is_file():
                try:
                    files[path.relative_to(source).as_posix()] = path.read_text(encoding="utf-8")
                except UnicodeDecodeError:
                    pass
        if not files:
            raise ValueError("Archive contains no source files")
        workspace = Workspace(files=files)
        store.save_workspace(project_id, workspace, binary_source=source)
        store.save_iteration(project_id, "import", workspace, "Imported project", "Imported from ZIP")


async def checkpoint(service: ProjectService, project_id: str, message: str) -> str:
    if not shutil.which("git"):
        raise ValueError("Install Git to create local checkpoints")
    directory = service.store.root / project_id / "repository"
    directory.mkdir(exist_ok=True)
    # Export filters secrets, dependency caches, databases and uploads.
    for path in directory.iterdir():
        if path.name != ".git":
            shutil.rmtree(path) if path.is_dir() else path.unlink()
    with zipfile.ZipFile(io.BytesIO(service.export(project_id))) as archive:
        archive.extractall(directory)
    environment = {"PATH": os.defpath, "HOME": str(directory), "GIT_CONFIG_NOSYSTEM": "1",
                   "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0"}
    async def git(*args: str) -> str:
        process = await asyncio.create_subprocess_exec(
            "git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
            "-c", "user.name=Studio", "-c", "user.email=studio@localhost", *args,
            cwd=directory, env=environment, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            output, error = await asyncio.wait_for(process.communicate(), timeout=20)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            raise ValueError("Git checkpoint timed out")
        if process.returncode:
            raise ValueError(error.decode(errors="replace")[:500])
        return output.decode().strip()
    if not (directory / ".git").exists():
        await git("init", "--initial-branch=main")
    await git("add", "--all")
    await git("commit", "--allow-empty", "-m", message)
    return await git("rev-parse", "HEAD")
