"""Project manifest: what a generated project is and how it runs.

The manifest replaces the implicit `index.html` entry-point contract. Every
project declares (or is detected to have) a template, its services, run
commands, ports, health checks and environment variables. Preview policy,
the supervisor and export all read the manifest instead of guessing from
file names.

Storage: `<project>/.studio/manifest.json` inside the project's metadata
directory — part of project state, never exported as application code.
"""
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, cast

from agent.workspace import Workspace


def _empty_commands() -> List[str]:
    return []


def _empty_env() -> Dict[str, str]:
    return {}


def _empty_services() -> List["ServiceSpec"]:
    return []


def _empty_names() -> List[str]:
    return []


@dataclass
class ServiceSpec:
    """One runnable service of the project (static preview counts as one)."""

    name: str
    # install | dev | start | check
    command: List[str] = field(default_factory=_empty_commands)
    port: Optional[int] = None
    # URL path (on the service port) probed until the service is healthy.
    health_path: str = "/"
    # Environment variables the service needs; values come from project env.
    env: Dict[str, str] = field(default_factory=_empty_env)


@dataclass
class ProjectManifest:
    template: str  # "static-html" | "react-vite-fastapi" | "nextjs"
    entry: str  # preview entry: a file (static) or service name (runnable)
    services: List[ServiceSpec] = field(default_factory=_empty_services)
    # Required environment variable NAMES the app expects (never values).
    required_env: List[str] = field(default_factory=_empty_names)
    # Relative paths kept OUT of code snapshots (uploads, databases).
    data_paths: List[str] = field(default_factory=_empty_names)

    def to_json(self) -> Dict[str, object]:
        return {
            "template": self.template,
            "entry": self.entry,
            "services": [
                {
                    "name": spec.name,
                    "command": list(spec.command),
                    "port": spec.port,
                    "health_path": spec.health_path,
                    "env": dict(spec.env),
                }
                for spec in self.services
            ],
            "required_env": list(self.required_env),
            "data_paths": list(self.data_paths),
        }

    @classmethod
    def from_json(cls, data: Dict[str, object]) -> "ProjectManifest":
        raw_services = data.get("services")
        services: List[ServiceSpec] = []
        if isinstance(raw_services, list):
            for raw in cast(List[object], raw_services):
                if not isinstance(raw, dict):
                    continue
                item = cast(Dict[str, object], raw)
                raw_command = item.get("command")
                command = (
                    [str(part) for part in cast(List[object], raw_command)]
                    if isinstance(raw_command, list) else []
                )
                raw_env = item.get("env")
                env: Dict[str, str] = {}
                if isinstance(raw_env, dict):
                    for key, value in cast(Dict[object, object], raw_env).items():
                        env[str(key)] = str(value)
                port_value = item.get("port")
                services.append(ServiceSpec(
                    name=str(item.get("name", "app")),
                    command=command,
                    port=int(str(port_value)) if port_value not in (None, "") else None,
                    health_path=str(item.get("health_path", "/")),
                    env=env,
                ))
        raw_required = data.get("required_env")
        required = (
            [str(value) for value in cast(List[object], raw_required)]
            if isinstance(raw_required, list) else []
        )
        raw_paths = data.get("data_paths")
        data_paths = (
            [str(value) for value in cast(List[object], raw_paths)]
            if isinstance(raw_paths, list) else []
        )
        return cls(
            template=str(data.get("template", "static-html")),
            entry=str(data.get("entry", "index.html")),
            services=services,
            required_env=required,
            data_paths=data_paths,
        )

    def service(self, name: str) -> Optional[ServiceSpec]:
        for spec in self.services:
            if spec.name == name:
                return spec
        return None


def detect_manifest(workspace: Workspace) -> ProjectManifest:
    """Infer a manifest from the workspace files.

    Detection is conservative: the static template stays the default when
    there is an index.html and nothing else; package.json / requirements
    markers promote the workspace to a runnable template.
    """
    files = set(workspace.files.keys())
    package_json = workspace.files.get("package.json")
    if package_json:
        try:
            parsed = json.loads(package_json)
        except ValueError:
            parsed = {}
        pkg = cast(Dict[str, object], parsed) if isinstance(parsed, dict) else {}
        raw_dependencies = pkg.get("dependencies", {})
        raw_scripts = pkg.get("scripts", {})
        dependencies = (
            cast(Dict[str, object], raw_dependencies)
            if isinstance(raw_dependencies, dict) else {}
        )
        scripts = (
            cast(Dict[str, object], raw_scripts)
            if isinstance(raw_scripts, dict) else {}
        )
        if "next" in dependencies:
            return ProjectManifest(
                template="nextjs",
                entry="app",
                services=[ServiceSpec(
                    name="web",
                    command=["pnpm", "dev"],
                    port=3000,
                    health_path="/",
                )],
                data_paths=[".next", "node_modules", "data/uploads"],
            )
        if "vite" in str(dependencies) or "vite" in str(scripts.get("dev", "")):
            return ProjectManifest(
                template="react-vite-fastapi",
                entry="app",
                services=[ServiceSpec(
                    name="web", command=["pnpm", "dev"], port=5173,
                    health_path="/",
                )],
                data_paths=["node_modules", "data/uploads"],
            )
    if "index.html" in files or any(path.endswith(".html") for path in files):
        return ProjectManifest(template="static-html", entry="index.html")
    return ProjectManifest(template="static-html", entry="index.html")


def manifest_is_runnable(manifest: ProjectManifest) -> bool:
    return manifest.template != "static-html" and bool(manifest.services)
