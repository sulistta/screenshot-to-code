"""Fail-closed Linux sandbox for executing generated (model-written) code.

Two profiles over the same structural boundary (systemd cgroups + bubblewrap):

- Serve (supervisor): dev servers need network and to write caches into the
  project dir. Environment is cleared and rebuilt from an allow-list, the
  filesystem shrinks to a read-only /usr plus the project directory, and the
  process group gets memory/CPU/task limits. Network stays shared with the
  host because dev servers must bind a port and reach registries — the same
  trust level as running `pnpm install` on the generated project, without
  exposing host env, home, or other filesystem paths.
- One-shot (validation): no network, read-only project, tight limits.

Availability is probed by actually executing a trivial command through the
whole chain (systemd user session + bwrap); when anything is missing the
caller falls back to direct execution with a cleared environment.
"""
import asyncio
import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any, Optional

STANDARD_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# Env vars the outer systemd-run client needs to reach the user bus. They are
# stripped again by bwrap --clearenv before project code runs.
BUS_VARS = ("PATH", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS")

_probe_cache: Optional[bool] = None


class SandboxUnavailable(Exception):
    pass


def _which(token: str) -> Optional[str]:
    if not token or token.startswith("-") or "/" in token:
        return None
    return shutil.which(token)


def _toolchain_binds(command: list[str]) -> tuple[list[str], str]:
    """Read-only binds for the directories holding the command's binaries.

    Node toolchains often live under $HOME (nvm, pnpm standalone). Without a
    bind of those directories the sandboxed process cannot even exec its
    interpreter. Returns (bind args, inner PATH).
    """
    bind_dirs: list[str] = []
    for token in command:
        resolved = _which(token)
        if resolved is None:
            continue
        real = Path(resolved).resolve()
        for directory in {str(real.parent), str(Path(resolved).parent)}:
            if directory not in bind_dirs and os.path.isdir(directory):
                bind_dirs.append(directory)
    inner_path = ":".join([*bind_dirs, STANDARD_PATH])
    args: list[str] = []
    for directory in bind_dirs:
        args += ["--ro-bind", directory, directory]
    return args, inner_path


def build_sandbox_command(
    source: Path,
    command: list[str],
    *,
    env: Optional[dict[str, str]] = None,
    network: bool,
    writable: bool,
    memory_max: str = "2G",
    tasks_max: int = 256,
    cpu_quota: Optional[str] = "200%",
    runtime_max_sec: Optional[int] = None,
) -> tuple[str, list[str]]:
    """Build (unit name, argv) running `command` inside the sandbox.

    Raises SandboxUnavailable when bwrap/systemd-run is missing.
    """
    if sys.platform != "linux" or not shutil.which("bwrap") or not shutil.which("systemd-run"):
        raise SandboxUnavailable("Execution sandbox requires Linux, Bubblewrap and systemd-run")
    if source.is_symlink() or not source.is_dir():
        raise ValueError("Invalid project snapshot")
    unit = f"studio-{uuid.uuid4().hex}"

    inner_env: dict[str, str] = {}
    tool_binds, inner_path = _toolchain_binds(command)
    inner_env["PATH"] = inner_path
    inner_env["HOME"] = "/tmp"
    inner_env["TMPDIR"] = "/tmp"
    for key, value in (env or {}).items():
        inner_env[key] = value

    argv = [
        "systemd-run", "--user", "--quiet", "--wait", "--pipe", "--collect", f"--unit={unit}",
        f"--property=MemoryMax={memory_max}", "--property=MemorySwapMax=0",
        f"--property=TasksMax={tasks_max}", "--property=KillMode=control-group",
        "--property=TimeoutStopSec=2",
    ]
    if cpu_quota:
        argv += [f"--property=CPUQuota={cpu_quota}"]
    if runtime_max_sec is not None:
        argv += [f"--property=RuntimeMaxSec={runtime_max_sec}"]
    argv += [
        "bwrap", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
        "--unshare-all",
    ]
    if network:
        argv.append("--share-net")
    argv += [
        "--ro-bind", "/usr", "/usr",
        "--symlink", "usr/bin", "/bin",
        "--symlink", "usr/lib", "/lib",
        "--symlink", "usr/lib64", "/lib64",
        "--proc", "/proc", "--dev", "/dev",
        "--size", "134217728", "--tmpfs", "/tmp",
    ]
    if os.path.isdir("/usr/local"):
        argv += ["--ro-bind", "/usr/local", "/usr/local"]
    if network:
        # Minimal host configuration needed to reach registries.
        for host_path in ("/etc/ssl", "/etc/resolv.conf"):
            if os.path.exists(host_path):
                argv += ["--ro-bind", host_path, host_path]
    mode = "--bind" if writable else "--ro-bind"
    argv += [mode, str(source.resolve()), "/project", "--chdir", "/project"]
    argv += tool_binds
    argv += ["--clearenv"]
    for key, value in inner_env.items():
        argv += ["--setenv", key, value]
    argv += ["--", *command]
    return unit, argv


def outer_env() -> dict[str, str]:
    """Host environment for the systemd-run client (bus access only)."""
    return {key: value for key, value in os.environ.items() if key in BUS_VARS}


def sandbox_available() -> bool:
    """Probe the whole chain once by executing `true` inside the sandbox."""
    global _probe_cache
    if _probe_cache is None:
        _probe_cache = _probe()
    return _probe_cache


def _probe() -> bool:
    if sys.platform != "linux" or not shutil.which("bwrap") or not shutil.which("systemd-run"):
        return False
    try:
        unit, argv = build_sandbox_command(
            Path("/tmp"), ["/usr/bin/true"], network=False, writable=False,
        )
        result = subprocess.run(argv, capture_output=True, timeout=20, env=outer_env())
        return result.returncode == 0
    except (OSError, SandboxUnavailable, subprocess.SubprocessError):
        return False


class NativeSandbox:
    """One-shot sandboxed command runner (validation profile)."""

    def __init__(self) -> None:
        pass

    async def execute(self, source: Path, command: list[str], *, timeout: int = 30) -> dict[str, Any]:
        unit, argv = build_sandbox_command(
            source, command, network=False, writable=False,
            memory_max="512M", tasks_max=64, cpu_quota="100%",
            runtime_max_sec=timeout,
        )
        process = await asyncio.create_subprocess_exec(
            *argv, env=outer_env(),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
        output = bytearray()

        async def collect() -> None:
            assert process.stdout is not None
            while chunk := await process.stdout.read(8192):
                if len(output) < 128_000:
                    output.extend(chunk[:128_000 - len(output)])
            await process.wait()

        async def stop() -> None:
            await _stop_unit(unit)
            if process.returncode is None:
                process.kill()
            await process.wait()

        try:
            await asyncio.wait_for(collect(), timeout=timeout + 5)
        except asyncio.TimeoutError:
            await stop()
            return {"ok": False, "exitCode": None, "output": "Execution exceeded its time limit", "isolated": True}
        except asyncio.CancelledError:
            await stop()
            raise
        result = output.decode(errors="replace")
        if process.returncode and ("bwrap:" in result or "Failed to start" in result):
            raise SandboxUnavailable("Native sandbox could not start: " + result[:500])
        return {"ok": process.returncode == 0, "exitCode": process.returncode,
                "output": result, "isolated": True}

    async def validate(self, source: Path) -> dict[str, Any]:
        script = """
import ast
import json
from pathlib import Path
from html.parser import HTMLParser
errors = []
checked = 0
for path in Path('/project').rglob('*'):
    if not path.is_file() or path.suffix not in {'.py', '.json', '.html'}:
        continue
    try:
        content = path.read_text()
        if path.suffix == '.py': ast.parse(content, filename=str(path))
        elif path.suffix == '.json': json.loads(content)
        else: HTMLParser().feed(content)
        checked += 1
    except (ValueError, SyntaxError, UnicodeError) as error:
        errors.append(str(path.relative_to('/project')) + ': ' + str(error))
print(json.dumps({'checked': checked, 'errors': errors}))
raise SystemExit(1 if errors else 0)
"""
        return await self.execute(source, ["/usr/bin/python3", "-c", script])


async def _stop_unit(unit: str) -> None:
    killer = await asyncio.create_subprocess_exec(
        "systemctl", "--user", "stop", unit, env=outer_env(),
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        await asyncio.wait_for(killer.wait(), timeout=10)
    except asyncio.TimeoutError:
        killer.kill()
