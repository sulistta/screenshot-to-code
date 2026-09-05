# Load environment variables first
from dotenv import load_dotenv

load_dotenv()


from fastapi import FastAPI
from contextlib import asynccontextmanager
from typing import AsyncIterator
from fastapi.middleware.cors import CORSMiddleware
from config import IS_DEBUG_ENABLED
from routes import (
    capabilities,
    home,
    evals,
    export,
    design_systems,
    prompt_reports,
    agent_runs,
    eval_sets,
    custom_providers,
    projects,
    studio,
)
from uploaded_assets import configure_uploaded_asset_routes
from studio_security import BrowserOriginBoundary, allowed_origins

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    debug_status = "ENABLED" if IS_DEBUG_ENABLED else "DISABLED"
    print(f"Backend startup complete. Debug mode is {debug_status}.")
    # Detect (and warm up) headless Chromium so the screenshot_preview tool is
    # only offered when it can actually run. Logs the outcome.
    from preview_screenshot import probe_screenshot_preview

    await probe_screenshot_preview()
    yield
    manager = projects._manager
    if manager is not None:
        import asyncio
        tasks = [active.task for active in manager._active.values()]
        for project_id in list(manager._active):
            manager.cancel(project_id)
        await asyncio.gather(*tasks, return_exceptions=True)


app = FastAPI(lifespan=lifespan, openapi_url="/api/v1/openapi.json", docs_url=None, redoc_url=None)
configure_uploaded_asset_routes(app)

# Configure CORS settings
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins(),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(BrowserOriginBoundary)

# Add routes
app.include_router(home.router)
app.include_router(capabilities.router)
app.include_router(evals.router)
app.include_router(export.router)
app.include_router(design_systems.router)
app.include_router(prompt_reports.router)
app.include_router(agent_runs.router)
app.include_router(eval_sets.router)
app.include_router(custom_providers.router)
app.include_router(projects.router)
app.include_router(studio.router)
