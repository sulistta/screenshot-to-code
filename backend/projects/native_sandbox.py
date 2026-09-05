"""Fail-closed, networkless Linux execution with systemd cgroup limits.

Only a read-only project snapshot and system runtimes enter the namespace.
All writes go to a bounded tmpfs. No provider environment, home directory,
control socket, project metadata or host network is exposed.
"""
import asyncio
import os
import shutil
import sys
import uuid
from pathlib import Path
from typing import Any


class SandboxUnavailable(ValueError):
    pass


class NativeSandbox:
    async def execute(self, source: Path, command: list[str], *, timeout: int = 30) -> dict[str, Any]:
        if sys.platform != "linux" or not shutil.which("bwrap") or not shutil.which("systemd-run"):
            raise SandboxUnavailable("Execution requires Linux, Bubblewrap and a systemd user session")
        if source.is_symlink() or not source.is_dir():
            raise ValueError("Invalid project snapshot")
        if any(path.is_symlink() for path in source.rglob("*")):
            raise ValueError("Symbolic links are not allowed in executable snapshots")
        unit = f"studio-{uuid.uuid4().hex}"
        arguments = [
            "systemd-run", "--user", "--quiet", "--wait", "--pipe", "--collect", f"--unit={unit}",
            "--property=MemoryMax=512M", "--property=MemorySwapMax=0", "--property=TasksMax=64",
            "--property=CPUQuota=100%", f"--property=RuntimeMaxSec={timeout}",
            "--property=LimitFSIZE=16777216", "--property=LimitNOFILE=128",
            "--property=KillMode=control-group", "--property=TimeoutStopSec=2",
            "bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
            "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin",
            "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
            "--proc", "/proc", "--dev", "/dev", "--size", "134217728", "--tmpfs", "/tmp",
            "--ro-bind", str(source.resolve()), "/project", "--chdir", "/project",
            "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/tmp",
            "--setenv", "TMPDIR", "/tmp", "--setenv", "PYTHONDONTWRITEBYTECODE", "1",
            "--", *command,
        ]
        # The user bus is needed only by systemd-run. Bubblewrap clears it
        # together with all host variables before executing project code.
        environment = {key: value for key, value in os.environ.items()
                       if key in {"PATH", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"}}
        process = await asyncio.create_subprocess_exec(*arguments, env=environment,
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        output = bytearray()

        async def collect() -> None:
            assert process.stdout is not None
            while chunk := await process.stdout.read(8192):
                if len(output) < 128_000:
                    output.extend(chunk[:128_000 - len(output)])
            await process.wait()

        async def stop() -> None:
            killer = await asyncio.create_subprocess_exec("systemctl", "--user", "stop", unit,
                env=environment, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
            await killer.wait()
            if process.returncode is None:
                process.kill()
            await process.wait()

        try:
            await asyncio.wait_for(collect(), timeout=timeout + 5)
        except asyncio.TimeoutError:
            await stop()
            return {"ok": False, "exitCode": None, "output": "Validation exceeded its time limit", "isolated": True}
        except asyncio.CancelledError:
            await stop()
            raise
        result = output.decode(errors="replace")
        if process.returncode and ("bwrap:" in result or "Failed to connect to bus" in result or "Failed to start" in result):
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
