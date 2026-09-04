"""Route tests for the projects API: CRUD, run triggering with a fake
provider session, workspace file serving, and the WS question round-trip.
"""
import asyncio
from typing import Any, List, Optional

import pytest
from fastapi.testclient import TestClient

from agent.providers.base import ProviderTurn
from agent.tools.types import ToolCall
from main import app
from projects.store import ProjectStore


@pytest.fixture()
def client(tmp_path, monkeypatch):
    store = ProjectStore(tmp_path / "projects")
    monkeypatch.setattr(
        "routes.projects.default_store", lambda: store
    )
    # Reset the per-process manager so each test gets its own store.
    monkeypatch.setattr("routes.projects._manager", None)
    with TestClient(app) as test_client:
        # Re-fetch the manager built lazily with our store.
        test_client.store = store  # type: ignore[attr-defined]
        yield test_client
    monkeypatch.setattr("routes.projects._manager", None)


def test_project_crud(client: TestClient) -> None:
    created = client.post(
        "/api/projects",
        json={"name": "Kettle & Co", "brief": "A tiny tea shop site"},
    )
    assert created.status_code == 201
    project = created.json()["project"]
    assert project["name"] == "Kettle & Co"

    listing = client.get("/api/projects").json()["projects"]
    assert [p["id"] for p in listing] == [project["id"]]

    fetched = client.get(f"/api/projects/{project['id']}").json()["project"]
    assert fetched["brief"] == "A tiny tea shop site"

    updated = client.patch(
        f"/api/projects/{project['id']}", json={"brief": "A cozy tea shop"}
    ).json()["project"]
    assert updated["brief"] == "A cozy tea shop"

    assert client.delete(f"/api/projects/{project['id']}").status_code == 204
    assert client.get(f"/api/projects/{project['id']}").status_code == 404


def test_start_run_requires_existing_project(client: TestClient) -> None:
    response = client.post("/api/projects/doesnotexist/runs", json={"text": "x"})
    assert response.status_code == 404


def test_workspace_file_serving_traversal_guard(client: TestClient) -> None:
    project = client.post(
        "/api/projects", json={"name": "p", "brief": ""}
    ).json()["project"]
    store: ProjectStore = client.store  # type: ignore[attr-defined]
    workspace = store.load_workspace(project["id"])
    workspace.write("index.html", "<html>entry</html>")
    workspace.write("assets/main.js", "init();")
    store.save_workspace(project["id"], workspace)

    entry = client.get(f"/workspace/{project['id']}/index.html")
    assert entry.status_code == 200
    assert "<html>entry</html>" in entry.text

    script = client.get(f"/workspace/{project['id']}/assets/main.js")
    assert script.status_code == 200
    assert "init();" in script.text

    # Entry by default.
    root = client.get(f"/workspace/{project['id']}")
    assert root.status_code == 200

    traversal = client.get(f"/workspace/{project['id']}/../{project['id']}/project.json")
    assert traversal.status_code == 404


def test_ws_question_round_trip(tmp_path, monkeypatch) -> None:
    """Full WS round trip over a real uvicorn server: run -> question ->
    answer -> completion, with event replay for late-attaching transports."""
    import json as _json
    import shutil as _shutil
    import threading
    import time as _time

    import httpx
    import uvicorn
    import websockets

    data_dir = tmp_path / "data"
    monkeypatch.setenv("SCREENSHOT_TO_CODE_DATA_DIR", str(data_dir))
    monkeypatch.setattr("routes.projects._manager", None)

    class ScriptedSession:
        """Asks once, then finishes (turn 2+ are clean final turns)."""

        def __init__(self, **kwargs: Any) -> None:
            self.closed = False
            self.turn = 0

        async def stream_turn(self, on_event: Any) -> ProviderTurn:
            self.turn += 1
            if self.turn == 1:
                return ProviderTurn(
                    assistant_text="",
                    tool_calls=[
                        ToolCall(
                            id="q1",
                            name="ask_user",
                            arguments={"question": "Dark or light theme?"},
                        )
                    ],
                )
            return ProviderTurn(assistant_text="Done!", tool_calls=[])

        async def append_tool_results(
            self, turn: ProviderTurn, executed: List[Any]
        ) -> None:
            return None

        def total_cost_usd(self) -> Optional[float]:
            return None

        async def close(self) -> None:
            self.closed = True

    monkeypatch.setattr(
        "projects.manager.create_provider_session",
        lambda **kwargs: ScriptedSession(),
    )

    config = uvicorn.Config(app, host="127.0.0.1", port=7023, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(100):
        if server.started:
            break
        _time.sleep(0.1)

    async def scenario() -> str:
        base = "http://127.0.0.1:7023"
        async with httpx.AsyncClient(base_url=base) as http:
            created = await http.post(
                "/api/projects", json={"name": "p", "brief": ""}
            )
            project = created.json()["project"]

            async with websockets.connect(
                f"ws://127.0.0.1:7023/ws/projects/{project['id']}"
            ) as ws:
                run_response = await http.post(
                    f"/api/projects/{project['id']}/runs",
                    json={"text": "build a dark-themed page", "settings": {"openAiApiKey": "k"}},
                )
                assert run_response.status_code == 202

                async def recv() -> Any:
                    return _json.loads(await asyncio.wait_for(ws.recv(), 10))

                # Drain until the question (replay includes prior events).
                question = None
                for _ in range(100):
                    event = await recv()
                    if event.get("type") == "question":
                        question = event
                        break
                    if event.get("type") == "run_status" and event.get(
                        "status"
                    ) in ("completed", "failed", "cancelled"):
                        raise AssertionError(f"ended before question: {event}")
                assert question is not None
                assert question["question"] == "Dark or light theme?"

                await ws.send(
                    _json.dumps(
                        {
                            "type": "answer",
                            "answer": "dark",
                            "questionId": question["questionId"],
                        }
                    )
                )

                status = None
                for _ in range(100):
                    event = await recv()
                    if event.get("type") == "run_status":
                        status = event["status"]
                        if status in ("completed", "failed", "cancelled"):
                            break
                return status or "none"

    try:
        final_status = asyncio.run(scenario())
    finally:
        server.should_exit = True
        thread.join(timeout=5)
        monkeypatch.setattr("routes.projects._manager", None)
        _shutil.rmtree(data_dir, ignore_errors=True)

    assert final_status == "completed"
