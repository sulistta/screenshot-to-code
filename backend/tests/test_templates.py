"""Templates are complete, importable, and detected by the manifest."""
from pathlib import Path

import pytest
from agent.workspace import Workspace
from projects.manifest import detect_manifest, manifest_is_runnable
from projects.templates import REACT_FASTAPI_TEMPLATE, NEXTJS_TEMPLATE, template_files


@pytest.mark.parametrize("template_name", ["react-vite-fastapi", "nextjs"])
def test_template_files_detected_as_runnable(template_name: str) -> None:
    workspace = Workspace()
    for path, content in template_files(template_name).items():
        workspace.write(path, content)
    manifest = detect_manifest(workspace)
    assert manifest.template == template_name
    assert manifest_is_runnable(manifest)
    # data directories stay out of code snapshots
    assert any("node_modules" in p or ".next" in p for p in manifest.data_paths)


def test_react_template_python_is_valid() -> None:
    import ast

    source = REACT_FASTAPI_TEMPLATE["api/main.py"]
    ast.parse(source)  # raises on syntax errors


def test_templates_reject_unknown_names() -> None:
    with pytest.raises(ValueError):
        template_files("angular")


def test_nextjs_template_is_json_valid() -> None:
    import json

    pkg = json.loads(NEXTJS_TEMPLATE["package.json"])
    assert "next" in pkg["dependencies"]
