"""Research tool: fetch a public URL so the model can consult real docs,
references, and libraries instead of relying on memory.

Output is size-capped readable text (title + main content), with scripts and
styles stripped. Single outbound GET with a timeout; SSRF-guarded like the
export route; no JS execution.
"""
from typing import Any, Dict, Optional
from urllib.parse import urlparse

import httpx

RESEARCH_MAX_CHARS = 12_000
RESEARCH_TIMEOUT_S = 20.0
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "screenshot-to-code-research/1.0 Safari/537.36"
)


def is_public_http_url(url: str) -> bool:
    """Reject non-http(s) schemes and private/loopback/reserved targets."""
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    if parsed.scheme not in ("http", "https"):
        return False
    host = parsed.hostname or ""
    if not host:
        return False
    lowered = host.lower()
    if lowered in ("localhost", "0.0.0.0") or lowered.endswith(".local"):
        return False
    # Literal IPs: reject loopback/private/reserved ranges.
    parts = lowered.split(".")
    if len(parts) == 4 and all(p.isdigit() for p in parts):
        octets = [int(p) for p in parts]
        if (
            octets[0] in (10, 127)
            or (octets[0] == 172 and 16 <= octets[1] <= 31)
            or (octets[0] == 192 and octets[1] == 168)
            or (octets[0] == 169 and octets[1] == 254)
            or octets[0] >= 224
        ):
            return False
    return True


def _extract_text(html: str) -> tuple[Optional[str], str]:
    """Naive title + text extraction without external dependencies."""
    import re

    title: Optional[str] = None
    title_match = re.search(
        r"<title[^>]*>(?P<content>.*?)</title>", html, re.IGNORECASE | re.DOTALL
    )
    if title_match:
        title = _strip_tags(title_match.group("content")).strip() or None

    # Prefer <main>/<article> when present; fall back to the whole body.
    main_match = re.search(
        r"<(main|article)[^>]*>(?P<content>.*?)</\1>",
        html,
        re.IGNORECASE | re.DOTALL,
    )
    source = main_match.group("content") if main_match else html
    # Remove script/style/template noise first.
    source = re.sub(
        r"<(script|style|noscript|template)[^>]*>.*?</\1>",
        "",
        source,
        flags=re.IGNORECASE | re.DOTALL,
    )
    # Block-level tags become paragraph breaks.
    source = re.sub(r"</(p|div|section|li|h[1-6]|tr)>", "\n", source, flags=re.I)
    source = re.sub(r"<(br|hr)\s*/?>", "\n", source, flags=re.I)
    text = _strip_tags(source)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return title, text.strip()


def _strip_tags(html: str) -> str:
    import re

    return re.sub(r"<[^>]+>", "", html)


async def fetch_research(url: str) -> Dict[str, Any]:
    """Fetch and extract readable content from a public URL."""
    if not is_public_http_url(url):
        return {
            "ok": False,
            "error": (
                "Only public http(s) URLs can be fetched (no localhost or "
                "private addresses)."
            ),
        }
    try:
        async with httpx.AsyncClient(
            follow_redirects=True, timeout=RESEARCH_TIMEOUT_S
        ) as client:
            response = await client.get(url, headers={"User-Agent": USER_AGENT})
    except httpx.HTTPError as exc:
        return {"ok": False, "error": f"Fetch failed: {exc.__class__.__name__}"}
    if response.status_code != 200:
        return {
            "ok": False,
            "error": f"HTTP {response.status_code} fetching the page.",
        }
    content_type = str(response.headers.get("content-type", ""))
    if "text/html" not in content_type and "text/plain" not in content_type:
        return {
            "ok": False,
            "error": f"Unsupported content type: {content_type or 'unknown'}",
        }
    title, text = _extract_text(response.text)
    truncated = len(text) > RESEARCH_MAX_CHARS
    return {
        "ok": True,
        "url": str(response.url),
        "title": title,
        "content": text[:RESEARCH_MAX_CHARS],
        "truncated": truncated,
    }
