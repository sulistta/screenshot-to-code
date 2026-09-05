"""Browser-origin boundary for the local control API."""
import os
from starlette.types import ASGIApp, Receive, Scope, Send
from starlette.responses import JSONResponse


def allowed_origins() -> list[str]:
    configured = os.environ.get("STUDIO_ALLOWED_ORIGINS", "")
    return configured.split(",") if configured else [
        f"http://{host}:{port}" for host in ("localhost", "127.0.0.1")
        for port in (5173, 5180, 7001)
    ]


class BrowserOriginBoundary:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] in {"http", "websocket"}:
            headers = dict(scope.get("headers", []))
            origin = headers.get(b"origin", b"").decode("latin-1")
            host = headers.get(b"host", b"").decode("latin-1")
            scheme = "https" if scope.get("scheme") in {"https", "wss"} else "http"
            trusted = origin in allowed_origins() or origin == f"{scheme}://{host}"
            control = not scope.get("path", "").startswith(("/workspace/", "/assets/", "/local_assets/"))
            if origin and not trusted and control and (
                scope["type"] == "websocket" or scope.get("method") not in {"GET", "HEAD", "OPTIONS"}
            ):
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 1008})
                else:
                    await JSONResponse({"detail": "Untrusted browser origin"}, status_code=403)(scope, receive, send)
                return
        await self.app(scope, receive, send)
