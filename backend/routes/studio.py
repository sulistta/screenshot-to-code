"""Typed v1 Studio API. Legacy routes remain available during migration."""
from typing import Any

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from projects.service import ProjectService, RevisionConflict
from projects.store import ProjectNotFoundError
from routes.projects import get_manager

router = APIRouter(prefix="/api/v1/projects")


class FileEdit(BaseModel):
    path: str = Field(min_length=1, max_length=500)
    content: str = Field(max_length=5_000_000)
    revision: str


class RestoreRequest(BaseModel):
    revision: str


class ProjectOptions(BaseModel):
    favorite: bool = False
    archived: bool = False
    trashed: bool = False


def service(project_id: str, writing: bool = False) -> ProjectService:
    manager = get_manager()
    try:
        manager.store.get(project_id)
    except ProjectNotFoundError:
        raise HTTPException(404, "Project not found")
    if writing and manager.active_run_id(project_id):
        raise HTTPException(409, "Wait for the active run or stop it before editing files")
    return ProjectService(manager.store)


@router.get("/{project_id}/files")
async def files(project_id: str) -> dict[str, Any]:
    return service(project_id).files(project_id)


@router.put("/{project_id}/files")
async def edit_file(project_id: str, body: FileEdit) -> dict[str, Any]:
    try:
        return service(project_id, True).write_file(project_id, body.path, body.content, body.revision)
    except RevisionConflict as exc:
        raise HTTPException(409, str(exc))
    except ValueError as exc:
        raise HTTPException(422, str(exc))


@router.get("/{project_id}/revisions/{iteration_id}/diff")
async def diff(project_id: str, iteration_id: str) -> dict[str, Any]:
    try:
        return service(project_id).diff(project_id, iteration_id)
    except (ValueError, FileNotFoundError):
        raise HTTPException(404, "Version not found")


@router.post("/{project_id}/revisions/{iteration_id}/restore")
async def restore(project_id: str, iteration_id: str, body: RestoreRequest) -> dict[str, Any]:
    try:
        return service(project_id, True).restore(project_id, iteration_id, body.revision)
    except RevisionConflict as exc:
        raise HTTPException(409, str(exc))
    except (ValueError, FileNotFoundError):
        raise HTTPException(404, "Version not found")


@router.get("/{project_id}/export")
async def export(project_id: str) -> Response:
    return Response(service(project_id).export(project_id), media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="{project_id}.zip"'})


@router.get("/{project_id}/options", response_model=ProjectOptions)
async def options(project_id: str) -> ProjectOptions:
    svc = service(project_id)
    path = svc.store.root / project_id / "options.json"
    try:
        return ProjectOptions.model_validate(svc.store.database.get(path))
    except FileNotFoundError:
        return ProjectOptions()


@router.put("/{project_id}/options", response_model=ProjectOptions)
async def update_options(project_id: str, body: ProjectOptions) -> ProjectOptions:
    svc = service(project_id, True)
    svc.store.database.put(svc.store.root / project_id / "options.json", body.model_dump())
    return body


@router.post("/{project_id}/duplicate")
async def duplicate(project_id: str) -> dict[str, Any]:
    svc = service(project_id)
    meta = svc.store.get(project_id)
    new = svc.store.create(f"{meta.name} copy", meta.brief)
    workspace = svc.store.load_workspace(project_id)
    svc.store.save_workspace(new.id, workspace, binary_source=svc.store.workspace_file(project_id, "index.html").parent)
    try:
        options = svc.store.database.get(svc.store.root / project_id / "options.json")
        options.update(favorite=False, archived=False, trashed=False)
        svc.store.database.put(svc.store.root / new.id / "options.json", options)
    except FileNotFoundError:
        pass
    return {"id": new.id}


@router.post("/{project_id}/import")
async def import_archive(project_id: str, file: UploadFile) -> dict[str, Any]:
    from projects.portability import import_zip
    svc = service(project_id, True)
    content = await file.read(25_000_001)
    if len(content) > 25_000_000:
        raise HTTPException(413, "Archive must be under 25 MB")
    try:
        import_zip(svc.store, project_id, content)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    return svc.files(project_id)


class GitCheckpoint(BaseModel):
    message: str = Field(min_length=1, max_length=200)


@router.post("/{project_id}/git")
async def git_checkpoint(project_id: str, body: GitCheckpoint) -> dict[str, str]:
    from projects.portability import checkpoint
    svc = service(project_id, True)
    try:
        return {"commit": await checkpoint(svc, project_id, body.message)}
    except (ValueError, OSError) as exc:
        raise HTTPException(422, str(exc))
