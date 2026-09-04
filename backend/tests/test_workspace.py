"""Tests for the multi-file workspace: path safety, file ops, inline
rendering, seeding, and the multi-file tool behavior.
"""
import pytest

from agent.workspace import (
    InvalidWorkspacePath,
    Workspace,
    normalize_path,
    seed_workspace_from_messages,
)
from agent.tools import AgentToolRuntime
from agent.tools.types import ToolCall


# --- path normalization ------------------------------------------------------


def test_normalize_path_defaults_to_entry() -> None:
    assert normalize_path("") == "index.html"
    assert normalize_path("  ") == "index.html"
    assert normalize_path(".", "index.html") == "index.html"


def test_normalize_path_strips_prefixes() -> None:
    assert normalize_path("./main.js") == "main.js"
    assert normalize_path("assets\\img\\x.js") == "assets/img/x.js"


def test_normalize_path_rejects_traversal_and_absolutes() -> None:
    with pytest.raises(InvalidWorkspacePath):
        normalize_path("../secret.txt")
    with pytest.raises(InvalidWorkspacePath):
        normalize_path("a/../../b.txt")
    with pytest.raises(InvalidWorkspacePath):
        normalize_path("/styles.css")
    with pytest.raises(InvalidWorkspacePath):
        normalize_path("C:/windows/system32")
    with pytest.raises(InvalidWorkspacePath):
        normalize_path("//etc/passwd")


# --- workspace file ops -------------------------------------------------------


def test_workspace_write_read_list() -> None:
    ws = Workspace()
    assert ws.write("index.html", "<html></html>") == "index.html"
    assert ws.write("main.js", "console.log(1)") == "main.js"
    assert ws.read("main.js") == "console.log(1)"
    assert ws.has("main.js")
    assert not ws.has("nope.css")
    assert ws.list_files() == ["index.html", "main.js"]


def test_workspace_legacy_constructor_and_properties() -> None:
    ws = Workspace(path="index.html", content="<main>old</main>")
    assert ws.path == "index.html"
    assert ws.content == "<main>old</main>"
    ws.content = "<main>new</main>"
    assert ws.read("index.html") == "<main>new</main>"
    ws.path = "about.html"
    assert ws.entry_point == "about.html"


def test_workspace_empty_by_default() -> None:
    ws = Workspace()
    assert ws.content == ""
    assert ws.list_files() == []


# --- inline rendering ----------------------------------------------------------


def test_render_inline_inlines_local_scripts_and_styles() -> None:
    ws = Workspace()
    ws.write("index.html", (
        "<html><head>"
        '<link rel="stylesheet" href="styles.css">'
        '<script src="https://cdn.tailwindcss.com"></script>'
        '<script src="main.js"></script>'
        "</head><body></body></html>"
    ))
    ws.write("styles.css", "body { color: red; }")
    ws.write("main.js", "console.log('hi');")
    html = ws.render_inline()
    assert "<style>\nbody { color: red; }\n</style>" in html
    assert "<script>\nconsole.log('hi');\n</script>" in html
    # CDN URLs stay untouched.
    assert '<script src="https://cdn.tailwindcss.com"></script>' in html
    assert 'src="main.js"' not in html


def test_render_inline_leaves_unknown_local_refs_alone() -> None:
    ws = Workspace()
    ws.write("index.html", '<script src="missing.js"></script>')
    assert ws.render_inline() == '<script src="missing.js"></script>'


def test_render_inline_empty_without_entry() -> None:
    ws = Workspace()
    assert ws.render_inline() == ""


# --- seeding -------------------------------------------------------------------


def test_seed_from_assistant_message() -> None:
    ws = Workspace()
    seed_workspace_from_messages(
        ws,
        [
            {"role": "assistant", "content": '<file path="index.html"><html>SEALED</html></file>'},
        ],
    )
    assert "SEALED" in ws.content


def test_seed_keeps_existing_content() -> None:
    ws = Workspace(content="already")
    seed_workspace_from_messages(
        ws,
        [{"role": "assistant", "content": "other"}],
    )
    assert ws.content == "already"


# --- tool behavior ---------------------------------------------------------------


def _runtime(ws: Workspace) -> AgentToolRuntime:
    return AgentToolRuntime(
        file_state=ws,
        should_generate_images=False,
        openai_api_key=None,
        openai_base_url=None,
    )


@pytest.mark.asyncio
async def test_create_file_writes_additional_paths() -> None:
    ws = Workspace()
    runtime = _runtime(ws)
    result = await runtime.execute(
        ToolCall(
            id="1", name="create_file", arguments={"content": "<html>e</html>"}
        )
    )
    assert result.ok is True
    assert ws.list_files() == ["index.html"]

    result = await runtime.execute(
        ToolCall(
            id="2",
            name="create_file",
            arguments={"path": "main.js", "content": "let x = 1;"},
        )
    )
    assert result.ok is True
    assert ws.list_files() == ["index.html", "main.js"]
    # Non-entry writes do not change the previewed document.
    assert result.updated_content is None
    assert ws.read("main.js") == "let x = 1;"


@pytest.mark.asyncio
async def test_create_file_rejects_unsafe_path() -> None:
    ws = Workspace()
    runtime = _runtime(ws)
    result = await runtime.execute(
        ToolCall(
            id="1",
            name="create_file",
            arguments={"path": "../evil.html", "content": "x"},
        )
    )
    assert result.ok is False
    assert ws.list_files() == []


@pytest.mark.asyncio
async def test_edit_file_targets_given_path() -> None:
    ws = Workspace()
    runtime = _runtime(ws)
    await runtime.execute(
        ToolCall(id="1", name="create_file", arguments={"path": "main.js", "content": "let x = 1;"})
    )
    result = await runtime.execute(
        ToolCall(
            id="2",
            name="edit_file",
            arguments={"path": "main.js", "old_text": "let x = 1;", "new_text": "let x = 2;"},
        )
    )
    assert result.ok is True
    assert ws.read("main.js") == "let x = 2;"
    assert result.summary["path"] == "main.js"


@pytest.mark.asyncio
async def test_edit_file_missing_path_fails_cleanly() -> None:
    ws = Workspace(content="<html></html>")
    runtime = _runtime(ws)
    result = await runtime.execute(
        ToolCall(
            id="1",
            name="edit_file",
            arguments={"path": "nope.js", "old_text": "a", "new_text": "b"},
        )
    )
    assert result.ok is False
    assert "not found" in str(result.result["error"])


@pytest.mark.asyncio
async def test_read_file_and_list_files() -> None:
    ws = Workspace()
    runtime = _runtime(ws)
    await runtime.execute(
        ToolCall(id="1", name="create_file", arguments={"content": "<html>entry</html>"})
    )
    await runtime.execute(
        ToolCall(id="2", name="create_file", arguments={"path": "styles.css", "content": "h1{}"})
    )
    read = await runtime.execute(
        ToolCall(id="3", name="read_file", arguments={"path": "styles.css"})
    )
    assert read.ok is True
    assert read.result["content"] == "h1{}"

    listing = await runtime.execute(ToolCall(id="4", name="list_files", arguments={}))
    assert listing.ok is True
    paths = [entry["path"] for entry in listing.result["files"]]
    assert paths == ["index.html", "styles.css"]

    missing = await runtime.execute(
        ToolCall(id="5", name="read_file", arguments={"path": "ghost.js"})
    )
    assert missing.ok is False
    assert missing.result["files"] == ["index.html", "styles.css"]
