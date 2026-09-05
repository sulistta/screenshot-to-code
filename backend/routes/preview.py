"""Preview gateway for runnable projects.

A single origin (`/api/projects/{id}/app/...`) proxies to each project's
running services, so the studio UI can frame a live full-stack app without
knowing its ports. The control-plane API stays on separate paths, and the
gateway never forwards project metadata or provider keys.
"""
from typing import Any, Dict, List, Optional, cast

import httpx
from fastapi import APIRouter, HTTPException, Request, Response

from projects.manifest import ProjectManifest, detect_manifest
from projects.store import ProjectNotFoundError
from projects.supervisor import ServiceSupervisor
from routes.projects import get_manager

router = APIRouter()

_HOP_BY_HOP = {
    "connection", "keep-alive", "transfer-encoding", "upgrade",
    "proxy-authenticate", "proxy-authorization", "te", "trailer",
}

supervisor = ServiceSupervisor(get_manager().store)


def _manifest_of(project_id: str) -> ProjectManifest:
    manager = get_manager()
    try:
        workspace = manager.store.load_workspace(project_id)
    except ProjectNotFoundError:
        raise HTTPException(404, "Project not found")
    return detect_manifest(workspace)


@router.get("/api/projects/{project_id}/services")
async def services_status(project_id: str) -> Dict[str, Any]:
    get_manager().store.get(project_id)
    return supervisor.status(project_id)


@router.post("/api/projects/{project_id}/services/start")
async def services_start(project_id: str) -> Dict[str, Any]:
    manager = get_manager()
    if manager.active_run_id(project_id):
        raise HTTPException(409, "A run is active; wait for it to finish")
    return await supervisor.start(project_id, _manifest_of(project_id))


@router.post("/api/projects/{project_id}/services/stop")
async def services_stop(project_id: str) -> Dict[str, Any]:
    get_manager().store.get(project_id)
    await supervisor.stop(project_id)
    return {"state": "stopped"}


@router.api_route(
    "/api/projects/{project_id}/app/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"]
)
async def app_proxy(project_id: str, path: str, request: Request) -> Response:
    """Forward to the project's first healthy service on its own origin."""
    status = supervisor.status(project_id)
    services: object = status.get("services") or []
    service_list = cast(List[object], services) if isinstance(services, list) else []
    if not service_list or status.get("state") != "running":
        raise HTTPException(409, "Project services are not running")
    first: object = service_list[0]
    raw_port = cast(object, first.get("port")) if isinstance(first, dict) else None
    if not isinstance(raw_port, int):
        raise HTTPException(409, "Project services have no port")
    target = f"http://127.0.0.1:{raw_port}/{path}"
    if request.url.query:
        target = f"{target}?{request.url.query}"

    forward_headers = {
        key: value for key, value in request.headers.items()
        if key.lower() not in _HOP_BY_HOP and key.lower() != "host"
    }
    body = await request.body()
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            upstream = await client.request(
                request.method, target, headers=forward_headers, content=body,
                follow_redirects=False,
            )
    except httpx.HTTPError:
        raise HTTPException(502, "The project service did not respond")
    response_headers = {
        key: value for key, value in upstream.headers.items()
        if key.lower() not in _HOP_BY_HOP
    }
    return Response(
        content=upstream.content, status_code=upstream.status_code,
        headers=response_headers,
    )
