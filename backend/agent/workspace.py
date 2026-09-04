"""Multi-file workspace: the agent's project state.

Generalizes the previous single-file ``AgentFileState`` (one index.html) to a
map of path → content with a defined entry point, so the agent can author
real multi-file projects (styles.css, main.js with ES imports, several pages)
without a bundler. Path handling is strict: workspace-relative, normalized,
no traversal.

``render_inline`` produces a single self-contained HTML document by inlining
workspace-local scripts and stylesheets into the entry file. It exists so
transports that can only display one document (the current variant-flow
iframe) still show correct multi-file projects; it never mutates the files.
"""
import re
from typing import Any, Dict, List, Optional, cast

from codegen.utils import extract_html_content
ENTRY_POINT = "index.html"

_SCRIPT_SRC_RE = re.compile(
    r"<script\b[^>]*\bsrc=[\"'](?P<url>[^\"']+)[\"'][^>]*>\s*</script>",
    re.IGNORECASE,
)
_LINK_HREF_RE = re.compile(
    r"<link\b[^>]*\brel=[\"']stylesheet[\"'][^>]*\bhref=[\"'](?P<url>[^\"']+)[\"'][^>]*>",
    re.IGNORECASE,
)


class InvalidWorkspacePath(ValueError):
    pass


def ensure_str(value: object) -> str:
    if value is None:
        return ""
    return str(value)


def normalize_path(raw_path: str, entry_point: str = ENTRY_POINT) -> str:
    """Normalize a workspace-relative path; raise on anything unsafe."""
    if not raw_path or not raw_path.strip():
        return entry_point
    path = raw_path.strip().replace("\\", "/")
    if path.startswith("/"):
        raise InvalidWorkspacePath(f"Absolute paths are not allowed: {raw_path!r}")
    if re.match(r"^[A-Za-z]:", path):
        raise InvalidWorkspacePath(f"Drive-letter paths are not allowed: {raw_path!r}")
    parts: List[str] = []
    for segment in path.split("/"):
        if segment in ("", "."):
            continue
        if segment == "..":
            raise InvalidWorkspacePath(
                f"Path traversal is not allowed: {raw_path!r}"
            )
        parts.append(segment)
    if not parts:
        return entry_point
    return "/".join(parts)


class Workspace:
    """Multi-file project state with a defined entry point.

    Accepts the legacy single-file constructor form ``Workspace(path=...,
    content=...)`` (formerly AgentFileState) so existing call sites keep
    working; ``path``/``content`` properties remain the entry-file view.
    """

    def __init__(
        self,
        path: str = ENTRY_POINT,
        content: str = "",
        entry_point: str = "",
        files: Optional[Dict[str, str]] = None,
        write_scope: Optional[List[str]] = None,
    ) -> None:
        self.entry_point = normalize_path(entry_point or path, ENTRY_POINT)
        self.files: Dict[str, str] = dict(files) if isinstance(files, dict) else {}
        if content:
            self.files.setdefault(self.entry_point, content)
        # When set, writes outside these paths are rejected (subagent scope
        # enforcement is structural, not prompt-enforced).
        self.write_scope: Optional[List[str]] = (
            [normalize_path(p, self.entry_point) for p in write_scope]
            if write_scope
            else None
        )

    def __repr__(self) -> str:
        return (
            f"Workspace(entry_point={self.entry_point!r}, "
            f"files={sorted(self.files)!r})"
        )

    # --- single-file compatibility view (entry point) -----------------------
    @property
    def path(self) -> str:
        return self.entry_point

    @path.setter
    def path(self, value: str) -> None:
        self.entry_point = value or ENTRY_POINT

    @property
    def content(self) -> str:
        return self.files.get(self.entry_point, "")

    @content.setter
    def content(self, value: str) -> None:
        self.files[self.entry_point] = value or ""

    # --- multi-file API -----------------------------------------------------
    def write(self, raw_path: str, content: str) -> str:
        path = normalize_path(raw_path, self.entry_point)
        if self.write_scope is not None and path not in self.write_scope:
            raise InvalidWorkspacePath(
                f"Path {path!r} is outside this agent's file scope."
            )
        self.files[path] = content or ""
        return path

    def read(self, raw_path: str) -> str:
        return self.files.get(normalize_path(raw_path, self.entry_point), "")

    def has(self, raw_path: str) -> bool:
        return normalize_path(raw_path, self.entry_point) in self.files

    def list_files(self) -> List[str]:
        return sorted(self.files)

    # --- single-document rendering ------------------------------------------
    def render_inline(self) -> str:
        """Self-contained entry document with workspace scripts/styles inlined.

        Only workspace-local relative URLs are inlined; CDN/absolute URLs and
        unknown paths are left untouched, so rendering is always safe to show.
        """
        html = self.files.get(self.entry_point, "")
        if not html:
            return ""

        def inline_script(match: "re.Match[str]") -> str:
            url = match.group("url")
            content = self._local_content(url)
            if content is not None:
                return f"<script>\n{content}\n</script>"
            return match.group(0)

        def inline_style(match: "re.Match[str]") -> str:
            url = match.group("url")
            content = self._local_content(url)
            if content is not None:
                return f"<style>\n{content}\n</style>"
            return match.group(0)

        html = _SCRIPT_SRC_RE.sub(inline_script, html)
        html = _LINK_HREF_RE.sub(inline_style, html)
        return html

    def _local_content(self, url: str) -> Optional[str]:
        """Content of a workspace-local file referenced from HTML, if any."""
        if not self._is_local(url):
            return None
        # Root-relative refs ("/main.js") resolve against the workspace root
        # when reading; writes still reject absolute paths.
        lookup = url[1:] if url.startswith("/") else url
        try:
            path = normalize_path(lookup, self.entry_point)
        except InvalidWorkspacePath:
            return None
        return self.files.get(path)

    def _is_local(self, url: str) -> bool:
        return not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", url) and not url.startswith(
            ("//", "data:", "#")
        )


def seed_workspace_from_messages(
    workspace: Workspace,
    prompt_messages: List[Any],
) -> None:
    """Seed the entry file from prior conversation content (update flow).

    Messages are provider-agnostic OpenAI-shaped dicts; typed as Any because
    ChatCompletionMessageParam unions resolve to plain dicts here.
    """
    if workspace.content:
        return

    for message in reversed(prompt_messages):
        if message.get("role") != "assistant":
            continue
        raw_text = _extract_text_content(message)
        if not raw_text:
            continue
        extracted = extract_html_content(raw_text)
        # Only accept content that is actually a document: assistant chat
        # summaries must never become the page (legacy fallback behavior).
        if extracted and "<html" in extracted.lower():
            workspace.content = extracted
            return

    if not prompt_messages:
        return

    system_message = prompt_messages[0]
    if system_message.get("role") != "system":
        return

    system_text = _extract_text_content(system_message)
    marker = "Here is the code of the app:"
    if marker in system_text:
        raw_text = system_text.split(marker, 1)[1].strip()
        extracted = extract_html_content(raw_text)
        if extracted and "<html" in extracted.lower():
            workspace.content = extracted


def _extract_text_content(message: Dict[str, object]) -> str:
    content = message.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        for part in cast(List[object], content):
            if not isinstance(part, dict):
                continue
            if part.get("type") == "text":
                value = cast(object, part.get("text"))
                if isinstance(value, str):
                    return value
    return ""
