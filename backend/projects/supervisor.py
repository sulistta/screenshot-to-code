"""Service supervisor: install, start, watch, restart and stop runnable projects.

One supervisor instance per Studio process manages per-project process
groups. Processes run through the native sandbox when available; the
supervisor tracks state (installing/running/stopped/crashed), streams
recent logs, probes health endpoints and tears everything down on project
stop, edit-lock conflicts or shutdown. Install runs without model secrets;
run commands receive only the variables the manifest declares.
"""
import asyncio
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx

from projects.manifest import ProjectManifest, ServiceSpec, manifest_is_runnable
from projects.store import ProjectStore

MAX_LOG_LINES = 400
INSTALL_TIMEOUT = 600
START_TIMEOUT = 90


def _empty_logs() -> List[str]:
    return []


@dataclass
class ServiceProcess:
    spec: ServiceSpec
    port: int
    process: asyncio.subprocess.Process
    started_at: float
    logs: List[str] = field(default_factory=_empty_logs)
    crashes: int = 0

    def log(self, line: str) -> None:
        self.logs.append(line.rstrip())
        if len(self.logs) > MAX_LOG_LINES:
            del self.logs[: len(self.logs) - MAX_LOG_LINES]


def _empty_services_map() -> Dict[str, "ServiceProcess"]:
    return {}


@dataclass
class ProjectRuntime:
    state: str  # "installing" | "running" | "stopped" | "crashed"
    services: Dict[str, ServiceProcess] = field(default_factory=_empty_services_map)
    error: Optional[str] = None


def _runtime_status(runtime: ProjectRuntime) -> Dict[str, object]:
    return {
        "state": runtime.state,
        "error": runtime.error,
        "services": [
            {
                "name": process.spec.name,
                "port": process.port,
                "crashes": process.crashes,
                "logs": list(process.logs[-40:]),
            }
            for process in runtime.services.values()
        ],
    }


class ServiceSupervisor:
    """Owns the OS processes of runnable projects."""

    def __init__(self, store: ProjectStore, sandbox: Optional[Any] = None) -> None:
        self.store = store
        self.sandbox = sandbox
        self._runtimes: Dict[str, ProjectRuntime] = {}

    # --- status ---------------------------------------------------------------
    def status(self, project_id: str) -> Dict[str, object]:
        runtime = self._runtimes.get(project_id)
        if runtime is None:
            return {"state": "stopped", "services": []}
        return _runtime_status(runtime)

    def is_running(self, project_id: str) -> bool:
        runtime = self._runtimes.get(project_id)
        return bool(runtime and runtime.state == "running")

    # --- lifecycle --------------------------------------------------------------
    async def start(
        self,
        project_id: str,
        manifest: ProjectManifest,
        env: Optional[Dict[str, str]] = None,
    ) -> Dict[str, object]:
        if self.is_running(project_id):
            return self.status(project_id)
        if not manifest_is_runnable(manifest):
            return {"state": "stopped", "services": [],
                    "error": "Project has no runnable services (static preview only)"}
        runtime = ProjectRuntime(state="installing")
        self._runtimes[project_id] = runtime
        try:
            workspace_dir = self.store.workspace_file(project_id, "index.html").parent
            await self._install(project_id, workspace_dir)
            for spec in manifest.services:
                port = spec.port or await _free_port()
                await self._spawn(project_id, workspace_dir, spec, port, env or {},
                                  manifest.required_env)
            await self._wait_healthy(runtime)
            runtime.state = "running"
            runtime.error = None
        except Exception as exc:
            runtime.state = "crashed"
            runtime.error = f"{exc.__class__.__name__}: {exc}"
            await self._terminate_all(runtime)
        return self.status(project_id)

    async def stop(self, project_id: str) -> None:
        runtime = self._runtimes.pop(project_id, None)
        if runtime is None:
            return
        await self._terminate_all(runtime)

    async def _terminate_all(self, runtime: ProjectRuntime) -> None:
        for process in runtime.services.values():
            await self._terminate(process)

    async def restart(self, project_id: str, manifest: ProjectManifest,
                      env: Optional[Dict[str, str]] = None) -> Dict[str, object]:
        await self.stop(project_id)
        return await self.start(project_id, manifest, env=env)

    # --- internals ---------------------------------------------------------------
    async def _install(self, project_id: str, workspace_dir: Path) -> None:
        """Install dependencies once per start; no model secrets present."""
        commands: List[List[str]] = []
        if (workspace_dir / "pnpm-lock.yaml").exists():
            commands.append(["pnpm", "install", "--frozen-lockfile"])
        elif (workspace_dir / "package-lock.json").exists():
            commands.append(["npm", "ci"])
        elif (workspace_dir / "package.json").exists():
            commands.append(["pnpm", "install"])
        if (workspace_dir / "requirements.txt").exists():
            commands.append(["pip", "install", "-r", "requirements.txt"])
        for command in commands:
            process = await asyncio.create_subprocess_exec(
                *command, cwd=str(workspace_dir),
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            )
            try:
                output, _ = await asyncio.wait_for(
                    process.communicate(), timeout=INSTALL_TIMEOUT
                )
            except asyncio.TimeoutError:
                process.kill()
                raise RuntimeError(
                    f"Installing dependencies timed out ({command[1]})"
                )
            if process.returncode != 0:
                raise RuntimeError(
                    f"Installing dependencies failed ({command[1]}): "
                    + output.decode(errors="replace")[-500:]
                )

    async def _spawn(
        self,
        project_id: str,
        workspace_dir: Path,
        spec: ServiceSpec,
        port: int,
        env: Dict[str, str],
        required_env: List[str],
    ) -> None:
        missing = [name for name in required_env if not env.get(name)]
        if missing:
            raise RuntimeError(
                "Missing required environment variables: " + ", ".join(missing)
            )
        command = [
            piece if piece != "{port}" else str(port) for piece in spec.command
        ]
        process_env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/tmp"}
        process_env.update(env)
        process = await asyncio.create_subprocess_exec(
            *command, cwd=str(workspace_dir), env=process_env,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
        runtime = self._runtimes[project_id]
        service = ServiceProcess(spec=spec, port=port, process=process,
                                 started_at=time.time())
        runtime.services[spec.name] = service
        asyncio.create_task(self._pump(service))
        asyncio.create_task(self._reap(project_id, process))

    async def _pump(self, service: ServiceProcess) -> None:
        assert service.process.stdout is not None
        while chunk := await service.process.stdout.readline():
            service.log(chunk.decode(errors="replace"))

    async def _reap(self, project_id: str, process: asyncio.subprocess.Process) -> None:
        returncode = await process.wait()
        runtime = self._runtimes.get(project_id)
        if runtime is None or runtime.state != "running":
            return
        for service in runtime.services.values():
            if service.process is process:
                service.crashes += 1
                service.log(f"Process exited with code {returncode}")
        runtime.state = "crashed"
        runtime.error = "A service process exited unexpectedly. See its logs."

    async def _wait_healthy(self, runtime: ProjectRuntime) -> None:
        deadline = time.time() + START_TIMEOUT
        async with httpx.AsyncClient() as client:
            while time.time() < deadline:
                healthy = all(
                    await asyncio.gather(*(
                        self._probe(client, process) for process in runtime.services.values()
                    ))
                )
                if healthy:
                    return
                for process in runtime.services.values():
                    if process.process.returncode is not None:
                        raise RuntimeError(
                            f"Service {process.spec.name} exited during startup: "
                            + "\n".join(process.logs[-10:])
                        )
                await asyncio.sleep(0.5)
        raise RuntimeError("Services did not become healthy in time")

    async def _probe(self, client: httpx.AsyncClient, process: ServiceProcess) -> bool:
        try:
            response = await client.get(
                f"http://127.0.0.1:{process.port}{process.spec.health_path}",
                timeout=2.0, follow_redirects=True,
            )
            return response.status_code < 500
        except httpx.HTTPError:
            return False

    async def _terminate(self, process: ServiceProcess) -> None:
        if process.process.returncode is None:
            process.process.terminate()
            try:
                await asyncio.wait_for(process.process.wait(), timeout=5)
            except asyncio.TimeoutError:
                process.process.kill()
                await process.process.wait()


async def _free_port() -> int:
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])
