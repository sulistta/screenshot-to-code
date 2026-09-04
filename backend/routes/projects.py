"""HTTP + WS routes for durable projects.

HTTP covers CRUD and triggering runs; the WS streams run events to the
studio UI and carries user answers to mid-run ask_user questions.
"""
import asyncio
import json
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from agent.workspace import InvalidWorkspacePath
from projects.manager import (
    ProjectRunManager,
    RunAlreadyActive,
    RunRequest,
)
from projects.store import (
    InvalidProjectPath,
    ProjectNotFoundError,
    default_store,
)
from ws.constants import APP_ERROR_WEB_SOCKET_CODE

router = APIRouter()

# One manager per process; the store is disk-backed so restarts are safe.
_manager: Optional[ProjectRunManager] = None


def get_manager() -> ProjectRunManager:
    global _manager
    if _manager is None:
        _manager = ProjectRunManager(default_store())
    return _manager


def _meta_json(meta: Any) -> Dict[str, Any]:
    return {
        "id": meta.id,
        "name": meta.name,
        "brief": meta.brief,
        "createdAt": meta.created_at,
        "updatedAt": meta.updated_at,
    }


@router.get("/api/projects")
async def list_projects() -> Dict[str, Any]:
    return {"projects": [_meta_json(m) for m in get_manager().store.list()]}


@router.post("/api/projects", status_code=201)
async def create_project(body: Dict[str, Any]) -> Dict[str, Any]:
    meta = get_manager().store.create(
        name=str(body.get("name", "")),
        brief=str(body.get("brief", "")),
    )
    return {"project": _meta_json(meta)}


@router.get("/api/projects/{project_id}")
async def get_project(project_id: str) -> Dict[str, Any]:
    try:
        meta = get_manager().store.get(project_id)
    except ProjectNotFoundError:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"project": _meta_json(meta)}


@router.patch("/api/projects/{project_id}")
async def update_project(project_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    try:
        meta = get_manager().store.update(
            project_id,
            name=body.get("name"),
            brief=body.get("brief"),
        )
    except ProjectNotFoundError:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"project": _meta_json(meta)}


@router.delete("/api/projects/{project_id}", status_code=204)
async def delete_project(project_id: str) -> None:
    try:
        get_manager().store.delete(project_id)
    except ProjectNotFoundError:
        raise HTTPException(status_code=404, detail="Project not found")


@router.get("/api/projects/{project_id}/transcript")
async def get_transcript(project_id: str) -> Dict[str, Any]:
    try:
        messages = get_manager().store.read_transcript(project_id)
    except ProjectNotFoundError:
        raise HTTPException(status_code=404, detail="Project not found")
    return {
        "messages": [
            {
                "role": m.role,
                "text": m.text,
                "createdAt": m.created_at,
                "runId": m.run_id,
                "images": m.images,
            }
            for m in messages
        ]
    }


@router.post("/api/projects/{project_id}/runs", status_code=202)
async def start_run(project_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    try:
        run_id = await get_manager().start_run(
            project_id,
            RunRequest(
                text=str(body.get("text", "")),
                images=list(body.get("images", []) or []),
                settings=dict(body.get("settings", {}) or {}),
            ),
        )
    except ProjectNotFoundError:
        raise HTTPException(status_code=404, detail="Project not found")
    except RunAlreadyActive:
        raise HTTPException(status_code=409, detail="A run is already active")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"runId": run_id}


@router.post("/api/projects/{project_id}/answer")
async def answer_question(project_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    delivered = get_manager().answer(
        project_id,
        str(body.get("answer", "")),
        body.get("questionId"),
    )
    if not delivered:
        raise HTTPException(status_code=409, detail="No question pending")
    return {"ok": True}


@router.post("/api/projects/{project_id}/cancel")
async def cancel_run(project_id: str) -> Dict[str, Any]:
    cancelled = get_manager().cancel(project_id)
    if not cancelled:
        raise HTTPException(status_code=409, detail="No active run")
    return {"ok": True}


@router.get("/workspace/{project_id}/{path:path}")
async def serve_workspace_file(project_id: str, path: str) -> Any:
    """Serve live workspace files so the preview runs a real multi-file site."""
    from fastapi.responses import FileResponse

    manager = get_manager()
    try:
        file_path = manager.store.workspace_file(project_id, path)
    except (ProjectNotFoundError, InvalidProjectPath):
        raise HTTPException(status_code=404, detail="File not found")
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(file_path)


@router.get("/workspace/{project_id}")
async def serve_workspace_entry(project_id: str) -> Any:
    try:
        meta = get_manager().store.get(project_id)
        entry = "index.html"
        file_path = get_manager().store.workspace_file(project_id, entry)
        if not file_path.is_file():
            raise HTTPException(status_code=404, detail="Workspace is empty")
    except (ProjectNotFoundError, InvalidProjectPath):
        raise HTTPException(status_code=404, detail="Project not found")
    from fastapi.responses import FileResponse

    return FileResponse(file_path)


@router.websocket("/ws/projects/{project_id}")
async def project_socket(websocket: WebSocket, project_id: str) -> None:
    """Stream run events; receive user answers to mid-run questions.

    One persistent reader task consumes client messages for the socket's
    lifetime (repeatedly cancelling a pending receive corrupts ASGI state);
    the send loop awaits queued events and exits when the reader ends.
    """
    manager = get_manager()
    try:
        manager.store.get(project_id)
    except ProjectNotFoundError:
        await websocket.close(code=APP_ERROR_WEB_SOCKET_CODE)
        return

    await websocket.accept()
    queue: "asyncio.Queue[Dict[str, Any]]" = asyncio.Queue()

    async def sink(event: Dict[str, Any]) -> None:
        await queue.put(event)

    manager.attach_sink(project_id, sink)

    async def reader() -> None:
        while True:
            raw = await websocket.receive_text()
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if message.get("type") == "answer":
                manager.answer(
                    project_id,
                    str(message.get("answer", "")),
                    message.get("questionId"),
                )
            elif message.get("type") == "cancel":
                manager.cancel(project_id)

    reader_task = asyncio.create_task(reader())
    queue_get = asyncio.create_task(queue.get())
    try:
        while True:
            done, _ = await asyncio.wait(
                {reader_task, queue_get},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if queue_get in done:
                await websocket.send_json(queue_get.result())
                queue_get = asyncio.create_task(queue.get())
            if reader_task in done:
                # Reader ends only on disconnect (exception); stop sending.
                break
    except (WebSocketDisconnect, RuntimeError):
        pass  # client went away mid-send
    finally:
        manager.detach_sink(project_id, sink)
        for task in (reader_task, queue_get):
            task.cancel()
