"""Restrict generated documents even when opened outside the Studio iframe."""
from pathlib import PurePosixPath

PREVIEW_HEADERS = {
    "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-downloads; frame-ancestors 'self' http://localhost:* http://127.0.0.1:*",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Access-Control-Allow-Origin": "*",
}


def is_private_path(relative: str) -> bool:
    path = PurePosixPath(relative.replace("\\", "/"))
    return any(part in {".git", ".venv", "node_modules", "__pycache__", ".next", "uploads", "data"}
               or part.startswith(".env") and part != ".env.example"
               for part in path.parts) or path.suffix.lower() in {".sqlite", ".sqlite3", ".db", ".pem", ".key"}
