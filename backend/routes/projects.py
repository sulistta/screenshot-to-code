"""HTTP + WS routes for durable projects.

HTTP covers CRUD and triggering runs; the WS streams run events to the
studio UI and carries user answers to mid-run ask_user questions.
"""
import asyncio
import json
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import RedirectResponse

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
from projects.preview_policy import PREVIEW_HEADERS, is_private_path

router = APIRouter()

# One manager per process; the store is disk-backed so restarts are safe.
_manager: Optional[ProjectRunManager] = None


def get_manager() -> ProjectRunManager:
    global _manager
    if _manager is None:
        _manager = ProjectRunManager(default_store())
    return _manager


def _meta_json(meta: Any) -> Dict[str, Any]:
    try:
        options = get_manager().store.database.get(get_manager().store.root / meta.id / "options.json")
    except FileNotFoundError:
        options = {}
    return {
        "id": meta.id,
        "name": meta.name,
        "brief": meta.brief,
        "createdAt": meta.created_at,
        "updatedAt": meta.updated_at,
        "primaryModel": meta.primary_model,
        "subagentModel": meta.subagent_model,
        "executionMode": meta.execution_mode,
        "favorite": bool(options.get("favorite", False)),
        "archived": bool(options.get("archived", False)),
        "trashed": bool(options.get("trashed", False)),
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
            primary_model=body.get("primaryModel"),
            subagent_model=body.get("subagentModel"),
            execution_mode=body.get("executionMode"),
        )
    except ProjectNotFoundError:
        raise HTTPException(status_code=404, detail="Project not found")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"project": _meta_json(meta)}


@router.delete("/api/projects/{project_id}", status_code=204)
async def delete_project(project_id: str) -> None:
    if get_manager().active_run_id(project_id) is not None:
        raise HTTPException(status_code=409, detail="Stop the active run before deleting this project")
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


@router.get("/api/projects/{project_id}/runs")
async def list_runs(project_id: str) -> Dict[str, Any]:
    try:
        records = get_manager().store.list_run_records(project_id)
    except ProjectNotFoundError:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"runs": records}


@router.get("/api/projects/{project_id}/iterations")
async def list_iterations(project_id: str) -> Dict[str, Any]:
    try:
        records = get_manager().store.list_iterations(project_id)
    except ProjectNotFoundError:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"iterations": records}


@router.get("/api/projects/{project_id}/iterations/{iteration_id}/files/{path:path}")
async def serve_iteration_file(
    project_id: str, iteration_id: str, path: str
) -> Any:
    """Serve a file from a historical iteration snapshot."""
    from fastapi.responses import FileResponse

    try:
        file_path = get_manager().store.iteration_file(
            project_id, iteration_id, path or "index.html"
        )
    except (ProjectNotFoundError, InvalidProjectPath):
        raise HTTPException(status_code=404, detail="File not found")
    if not file_path.is_file() or is_private_path(path):
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(file_path, headers=PREVIEW_HEADERS)


@router.get("/api/projects/{project_id}/iterations/{iteration_id}")
async def serve_iteration_entry(project_id: str, iteration_id: str) -> Any:
    from fastapi.responses import FileResponse

    try:
        file_path = get_manager().store.iteration_file(
            project_id, iteration_id, "index.html"
        )
    except (ProjectNotFoundError, InvalidProjectPath):
        raise HTTPException(status_code=404, detail="Iteration not found")
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="Iteration has no entry file")
    return RedirectResponse(
        url=f"/api/projects/{project_id}/iterations/{iteration_id}/files/index.html",
        status_code=307,
    )


@router.get("/api/models")
async def available_models_route() -> Dict[str, Any]:
    """Models selectable in run configuration, grouped-ready.

    Each entry carries the provider so the UI can group them; custom
    providers contribute their individual model ids.
    """
    from projects.manager import available_model_entries
    from projects.manager import extract_engine_keys

    keys = extract_engine_keys({})
    return {"models": available_model_entries(keys)}


@router.get("/workspace/{project_id}/{path:path}")
async def serve_workspace_file(project_id: str, path: str, inspect: bool = False) -> Any:
    """Serve live workspace files so the preview runs a real multi-file site."""
    from fastapi.responses import FileResponse

    manager = get_manager()
    try:
        file_path = manager.store.workspace_file(project_id, path or "index.html")
    except (ProjectNotFoundError, InvalidProjectPath):
        raise HTTPException(status_code=404, detail="File not found")
    if not file_path.is_file() or is_private_path(path):
        raise HTTPException(status_code=404, detail="File not found")
    if inspect and file_path.suffix.lower() in {".html", ".htm"}:
        from fastapi.responses import HTMLResponse
        from projects.inspector import with_inspector
        return HTMLResponse(with_inspector(file_path.read_text(encoding="utf-8")), headers=PREVIEW_HEADERS)
    return FileResponse(file_path, headers=PREVIEW_HEADERS)


@router.get("/workspace/{project_id}")
async def serve_workspace_entry(project_id: str) -> Any:
    try:
        get_manager().store.get(project_id)
        entry = "index.html"
        file_path = get_manager().store.workspace_file(project_id, entry)
        if not file_path.is_file():
            raise HTTPException(status_code=404, detail="Workspace is empty")
    except (ProjectNotFoundError, InvalidProjectPath):
        raise HTTPException(status_code=404, detail="Project not found")
    return RedirectResponse(url=f"/workspace/{project_id}/index.html", status_code=307)


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
    queue: "asyncio.Queue[Dict[str, Any]]" = asyncio.Queue(maxsize=512)
    overflow = asyncio.Event()

    async def sink(event: Dict[str, Any]) -> None:
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            overflow.set()

    try:
        after = max(0, int(websocket.query_params.get("after", "0")))
    except ValueError:
        await websocket.close(code=1008)
        return
    if websocket.query_params.get("streamId") != manager.journal.stream_id:
        after = 0
    manager.attach_sink(project_id, sink, replay=False)

    async def reader() -> None:
        while True:
            raw = await websocket.receive_text()
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(message, dict):
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
    overflow_task = asyncio.create_task(overflow.wait())
    try:
        # Subscribe before replay: events produced while sending history are
        # queued, then duplicates are removed by the cursor below.
        while True:
            batch = manager.journal.read(project_id, after)
            if not batch:
                break
            for event in batch:
                await websocket.send_json(event)
                after = int(event["sequence"])
            if overflow.is_set():
                await websocket.close(code=1013, reason="Reconnect to resume events")
                return
        while True:
            done, _ = await asyncio.wait(
                {reader_task, queue_get, overflow_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if queue_get in done:
                event = queue_get.result()
                if int(event["sequence"]) > after:
                    await websocket.send_json(event)
                    after = int(event["sequence"])
                queue_get = asyncio.create_task(queue.get())
            if overflow_task in done:
                await websocket.close(code=1013, reason="Reconnect to resume events")
                break
            if reader_task in done:
                # Reader ends only on disconnect (exception); stop sending.
                break
    except (WebSocketDisconnect, RuntimeError):
        pass  # client went away mid-send
    finally:
        manager.detach_sink(project_id, sink)
        for task in (reader_task, queue_get, overflow_task):
            task.cancel()
        await asyncio.gather(reader_task, queue_get, overflow_task, return_exceptions=True)
