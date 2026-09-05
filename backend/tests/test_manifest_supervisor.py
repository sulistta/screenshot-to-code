"""Manifest detection and the service supervisor's lifecycle conducts."""
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest
from agent.workspace import Workspace
from projects.manifest import (
    ProjectManifest,
    ServiceSpec,
    detect_manifest,
    manifest_is_runnable,
)
from projects.store import ProjectStore


# --- manifest detection --------------------------------------------------------------


def test_static_html_is_the_default_template() -> None:
    workspace = Workspace()
    workspace.write("index.html", "<html>hi</html>")
    workspace.write("styles.css", "body{}")
    manifest = detect_manifest(workspace)
    assert manifest.template == "static-html"
    assert manifest.entry == "index.html"
    assert not manifest_is_runnable(manifest)


def test_nextjs_workspace_is_detected() -> None:
    workspace = Workspace()
    workspace.write("package.json", '{"dependencies": {"next": "15.0.0"}}')
    manifest = detect_manifest(workspace)
    assert manifest.template == "nextjs"
    assert manifest.services[0].port == 3000
    assert manifest_is_runnable(manifest)


def test_vite_workspace_is_detected() -> None:
    workspace = Workspace()
    workspace.write(
        "package.json",
        '{"dependencies": {"react": "19", "vite": "6"}, "scripts": {"dev": "vite"}}',
    )
    manifest = detect_manifest(workspace)
    assert manifest.template == "react-vite-fastapi"
    assert manifest_is_runnable(manifest)


def test_manifest_round_trip() -> None:
    manifest = ProjectManifest(
        template="nextjs",
        entry="app",
        services=[ServiceSpec(name="web", command=["pnpm", "dev"], port=3000)],
        required_env=["DATABASE_URL"],
        data_paths=[".next"],
    )
    restored = ProjectManifest.from_json(manifest.to_json())
    assert restored == manifest


# --- supervisor ------------------------------------------------------------------------


class FakeStore:
    """Supervisor's minimal store surface."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.workspace = Workspace()

    def workspace_file(self, project_id: str, relative: str) -> Path:
        return self.root / project_id / relative


@pytest.mark.asyncio
async def test_supervisor_rejects_static_projects(tmp_path: Path) -> None:
    from projects.supervisor import ServiceSupervisor

    supervisor = ServiceSupervisor(FakeStore(tmp_path))  # type: ignore[arg-type]
    status = await supervisor.start("p1", detect_manifest(Workspace()))
    assert status["state"] == "stopped"
    assert "no runnable services" in str(status.get("error", ""))


@pytest.mark.asyncio
async def test_supervisor_reports_missing_required_env(tmp_path: Path) -> None:
    from projects.supervisor import ServiceSupervisor

    store = FakeStore(tmp_path)
    store.workspace.write(
        "package.json", '{"dependencies": {"next": "15"}}'
    )
    store.root.mkdir(exist_ok=True)
    (store.root / "p1").mkdir(exist_ok=True)
    (store.root / "p1" / "package.json").write_text(
        '{"dependencies": {"next": "15"}}'
    )
    supervisor = ServiceSupervisor(store)  # type: ignore[arg-type]
    manifest = detect_manifest(store.workspace)
    manifest.required_env = ["STRIPE_KEY"]
    status = await supervisor.start("p1", manifest)
    assert status["state"] == "crashed"
    assert "STRIPE_KEY" in str(status.get("error", ""))
    # The crashed runtime must not linger as a running project.
    assert not supervisor.is_running("p1")


@pytest.mark.asyncio
async def test_supervisor_runs_and_probes_a_service(tmp_path: Path) -> None:
    from projects.supervisor import ServiceSupervisor

    # A real HTTP service: python http.server over a tiny directory.
    (tmp_path / "p1").mkdir()
    (tmp_path / "p1" / "index.html").write_text("<html>ok</html>")
    store = FakeStore(tmp_path)

    supervisor = ServiceSupervisor(store)  # type: ignore[arg-type]
    manifest = ProjectManifest(
        template="react-vite-fastapi",
        entry="app",
        services=[ServiceSpec(
            name="web",
            command=["python3", "-m", "http.server", "{port}",
                     "--bind", "127.0.0.1"],
            port=None,
            health_path="/",
        )],
    )
    status = await supervisor.start("p1", manifest)
    try:
        assert status["state"] == "running", status
        assert supervisor.is_running("p1")
        services = status["services"]
        assert isinstance(services, list) and len(services) == 1
        assert services[0]["port"] > 0
    finally:
        await supervisor.stop("p1")
    assert not supervisor.is_running("p1")


@pytest.mark.asyncio
async def test_supervisor_detects_service_crash(tmp_path: Path) -> None:
    from projects.supervisor import ServiceSupervisor

    (tmp_path / "p1").mkdir()
    store = FakeStore(tmp_path)
    supervisor = ServiceSupervisor(store)  # type: ignore[arg-type]
    manifest = ProjectManifest(
        template="react-vite-fastapi",
        entry="app",
        services=[ServiceSpec(name="web", command=["false"])],
    )
    status = await supervisor.start("p1", manifest)
    assert status["state"] == "crashed"
    assert "exited during startup" in str(status.get("error", ""))
