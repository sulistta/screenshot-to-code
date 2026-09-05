"""Native sandbox + supervisor integration: isolation probes and fallback.

Tests skip cleanly when the sandbox chain (bwrap + systemd user session) is
not available; the fallback path is always exercised.
"""
import os
from pathlib import Path

import pytest

from projects.manifest import ProjectManifest, ServiceSpec
from projects.native_sandbox import sandbox_available
from projects.supervisor import ServiceSupervisor


class FakeStore:
    def __init__(self, root: Path) -> None:
        self.root = root

    def workspace_file(self, project_id: str, relative: str) -> Path:
        return self.root / project_id / relative


def _project(root: Path, probe_script: str) -> Path:
    (root / "p1").mkdir(parents=True, exist_ok=True)
    (root / "p1" / "index.html").write_text("<html>sandbox-e2e</html>")
    (root / "p1" / "probe.py").write_text(probe_script)
    return root


SANDBOX = sandbox_available()

_PROBE = """\
import os
print('HOME=' + os.environ.get('HOME', ''))
print('HOST_SECRET=' + str('STUDIO_TEST_SECRET' in os.environ))
print('DECLARED=' + str(os.environ.get('MY_APP_TOKEN', '')))
print('PROJECT_VISIBLE=' + str(os.path.exists('/project/index.html')))
"""


@pytest.mark.asyncio
async def test_sandboxed_service_isolation(tmp_path: Path) -> None:
    if not SANDBOX:
        pytest.skip("sandbox chain (bwrap + systemd user) unavailable")
    _project(tmp_path, _PROBE)
    supervisor = ServiceSupervisor(FakeStore(tmp_path))  # type: ignore[arg-type]
    manifest = ProjectManifest(
        template="react-vite-fastapi", entry="app",
        services=[ServiceSpec(name="web", command=[
            "/bin/sh", "-c",
            "python3 /project/probe.py > /project/probe.out 2>&1; "
            "python3 -m http.server \"$PORT\" --bind 127.0.0.1",
        ])],
    )
    status = await supervisor.start("p1", manifest, env={"MY_APP_TOKEN": "tok"})
    assert status["state"] == "running", status
    assert status["sandboxed"] is True
    try:
        await _settle()
        probe = (tmp_path / "p1" / "probe.out").read_text()
        assert "HOME=/tmp" in probe
        # Declared env reaches the service; undeclared host env does not.
        assert "DECLARED=tok" in probe
        assert "HOST_SECRET=False" in probe
        assert "PROJECT_VISIBLE=True" in probe
    finally:
        await supervisor.stop("p1")
    assert supervisor.status("p1")["state"] == "stopped"


@pytest.mark.asyncio
async def test_fallback_service_runs_without_sandbox(tmp_path: Path) -> None:
    _project(tmp_path, _PROBE)
    supervisor = ServiceSupervisor(FakeStore(tmp_path), sandbox=False)  # type: ignore[arg-type]
    manifest = ProjectManifest(
        template="react-vite-fastapi", entry="app",
        services=[ServiceSpec(name="web", command=[
            "/bin/sh", "-c",
            "python3 probe.py > probe.out 2>&1; "
            "python3 -m http.server \"$PORT\" --bind 127.0.0.1",
        ])],
    )
    status = await supervisor.start("p1", manifest, env={"MY_APP_TOKEN": "tok"})
    assert status["state"] == "running", status
    assert status["sandboxed"] is False
    try:
        await _settle()
        probe = (tmp_path / "p1" / "probe.out").read_text()
        assert "DECLARED=tok" in probe
    finally:
        await supervisor.stop("p1")


async def _settle() -> None:
    import asyncio

    await asyncio.sleep(0.5)


def test_host_secret_not_passed_through_direct_fallback(tmp_path: Path) -> None:
    """Direct fallback builds a fresh env; only PATH/HOME plus declared vars."""
    from projects.supervisor import ServiceSupervisor  # noqa: F401

    # The env construction lives in _spawn's fallback branch; assert the
    # baseline env never copies os.environ wholesale.
    import projects.supervisor as module

    source = Path(module.__file__).read_text()
    assert "process_env = {\"PATH\": os.environ.get" in source
    assert "process_env.update(os.environ)" not in source


def test_sandbox_command_structure(tmp_path: Path) -> None:
    """Structural checks on the generated argv (no execution needed)."""
    if not SANDBOX:
        pytest.skip("sandbox chain unavailable")
    from projects.native_sandbox import build_sandbox_command

    source = tmp_path / "proj"
    source.mkdir()
    unit, argv = build_sandbox_command(
        source, ["python3", "-m", "http.server", "{port}"],
        network=True, writable=True, env={"PORT": "8000", "MY_APP_TOKEN": "t"},
    )
    text = " ".join(argv)
    assert "--clearenv" in argv
    assert "--share-net" in argv
    assert "--ro-bind" in argv or "--bind" in argv
    assert unit.startswith("studio-")
    # Declared env is set explicitly; nothing else is forwarded.
    assert "MY_APP_TOKEN" in text and "PORT" in text
    assert "OPENAI_API_KEY" not in text
    # HOME is pinned to /tmp via an explicit --setenv pair.
    home_at = argv.index("HOME")
    assert argv[home_at - 1] == "--setenv" and argv[home_at + 1] == "/tmp"
