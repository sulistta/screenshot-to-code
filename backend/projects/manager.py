"""Project run manager: turns a user message into an agent run.

Responsibilities:
- one active run per project (concurrent requests are rejected, not queued);
- load the persisted workspace before the run, save it after (success,
  failure, or cancel — files written so far remain);
- route ask_user questions to the transport and answers back;
- append the user message and the assistant reply to the transcript;
- forward typed runtime events to any connected transport sink.

The manager deliberately knows nothing about WebSockets: a sink is any
async callable receiving RunEvent. The project WS route attaches itself as
a sink; when no transport is attached, runs still work and persist.
"""
import asyncio
import os
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from openai.types.chat import ChatCompletionMessageParam

from agent.providers.custom import resolve_active_custom_provider
from agent.providers.factory import create_provider_session
from agent.runtime.errors import EmptyOutputError
from agent.runtime.interaction import QuestionGate
from agent.runtime.loop import AgentRuntime, RuntimeConfig
from agent.runtime.statuses import RunStatus
from agent.workspace import Workspace
from config import GENERATION_MAX_COST_USD
from fs_logging.agent_runs import AgentRunRecorder
from llm import ANTHROPIC_MODELS, GEMINI_MODELS, OPENAI_MODELS, Llm
from projects.store import ProjectStore, TranscriptMessage

RunEventSink = Callable[[Any], Any]  # async callable(RunEvent)


@dataclass
class RunRequest:
    text: str
    images: List[str] = field(default_factory=lambda: [])
    settings: Dict[str, Any] = field(default_factory=lambda: {})


class RunAlreadyActive(Exception):
    pass


@dataclass
class ActiveRun:
    run_id: str
    task: "asyncio.Task[None]"
    gate: QuestionGate
    status: RunStatus


class ProjectRunManager:
    def __init__(self, store: ProjectStore) -> None:
        self.store = store
        self._active: Dict[str, ActiveRun] = {}
        self._sinks: Dict[str, List[RunEventSink]] = {}
        # Ring buffer of wire events per project: transports that attach
        # mid-run (initial connect, reconnects) replay history instead of
        # missing everything that happened before they subscribed.
        self._event_buffers: Dict[str, List[Dict[str, Any]]] = {}
        self._event_buffer_limit = 500

    # --- transports -----------------------------------------------------------
    def attach_sink(self, project_id: str, sink: RunEventSink) -> None:
        self._sinks.setdefault(project_id, []).append(sink)
        for event in list(self._event_buffers.get(project_id, [])):
            self._put(sink, event)

    def detach_sink(self, project_id: str, sink: RunEventSink) -> None:
        sinks = self._sinks.get(project_id)
        if sinks and sink in sinks:
            sinks.remove(sink)

    def clear_events(self, project_id: str) -> None:
        self._event_buffers.pop(project_id, None)

    def _put(self, sink: RunEventSink, event: Dict[str, Any]) -> None:
        result = sink(event)
        if asyncio.iscoroutine(result):
            asyncio.create_task(result)

    async def _broadcast(self, project_id: str, event: Dict[str, Any]) -> None:
        buffer = self._event_buffers.setdefault(project_id, [])
        buffer.append(event)
        if len(buffer) > self._event_buffer_limit:
            del buffer[: len(buffer) - self._event_buffer_limit]
        for sink in list(self._sinks.get(project_id, [])):
            await sink(event)

    # --- run lifecycle -----------------------------------------------------------
    def active_run_id(self, project_id: str) -> Optional[str]:
        active = self._active.get(project_id)
        if active is None:
            return None
        if active.task.done():
            return None
        return active.run_id

    async def start_run(self, project_id: str, request: RunRequest) -> str:
        if self.active_run_id(project_id) is not None:
            raise RunAlreadyActive(project_id)
        if not request.text.strip() and not request.images:
            raise ValueError("Run needs a message or reference images.")

        meta = self.store.get(project_id)
        run_id = uuid.uuid4().hex[:12]
        gate = QuestionGate()

        self.store.append_transcript_message(
            project_id,
            TranscriptMessage(role="user", text=request.text, images=request.images),
        )

        task = asyncio.create_task(
            self._run(project_id, meta.id, run_id, request, gate)
        )
        self._active[project_id] = ActiveRun(
            run_id=run_id, task=task, gate=gate, status=RunStatus.RUNNING
        )
        return run_id

    async def _run(
        self,
        project_id: str,
        meta_id: str,
        run_id: str,
        request: RunRequest,
        gate: QuestionGate,
    ) -> None:
        status = RunStatus.FAILED
        assistant_reply = ""
        workspace: Optional[Workspace] = None
        try:
            workspace = self.store.load_workspace(project_id)
            prompt_messages = await build_run_prompts(workspace, request)

            settings = request.settings
            model = resolve_model(settings)
            engine_keys = extract_engine_keys(settings)

            recorder = AgentRunRecorder(
                generation_id=f"proj_{project_id}_{run_id}",
                variant_index=0,
                entry_point="project",
                stack=str(settings.get("generatedCodeConfig", "html_tailwind")),
                input_mode="image" if request.images else "text",
                generation_type="update" if workspace.content else "create",
            )

            # The runtime emits the typed question event itself (with the
            # tool event id the gate registers); nothing extra to broadcast.
            gate._on_question = None  # type: ignore[attr-defined]

            session = create_provider_session(
                model=model,
                prompt_messages=prompt_messages,
                should_generate_images=bool(
                    settings.get("isImageGenerationEnabled", True)
                ),
                openai_api_key=engine_keys["openai_api_key"],
                openai_base_url=engine_keys["openai_base_url"],
                anthropic_api_key=engine_keys["anthropic_api_key"],
                gemini_api_key=engine_keys["gemini_api_key"],
                replicate_api_key=engine_keys["replicate_api_key"],
                custom_provider=resolve_active_custom_provider(
                    settings.get("customProviders"),
                    settings.get("activeCustomProviderId"),
                ),
                recorder=recorder,
                ask_user_enabled=True,
            )
            assistant_reply_buffer: List[str] = []

            async def emitting(event: Any) -> None:
                if event.type == "assistant_delta" and event.text:
                    assistant_reply_buffer.append(event.text)
                await self._broadcast(project_id, _event_to_wire(event, run_id))

            try:
                runtime = AgentRuntime(
                    session=session,
                    tool_runtime=_build_tool_runtime(workspace, engine_keys, settings),
                    emit=emitting,
                    recorder=recorder,
                    interaction=gate,
                    config=RuntimeConfig(budget_usd=GENERATION_MAX_COST_USD),
                    file_state=workspace,
                )
                await self._broadcast(
                    project_id,
                    {"type": "run_status", "runId": run_id, "status": "running"},
                )
                result = await runtime.run(model, prompt_messages)
                if not result:
                    raise EmptyOutputError()
                status = RunStatus.COMPLETED
                assistant_reply = "".join(assistant_reply_buffer).strip() or (
                    "Done. The latest version is in the preview."
                )
            finally:
                await session.close()
        except asyncio.CancelledError:
            status = RunStatus.CANCELLED
            assistant_reply = "Run cancelled."
        except Exception as exc:
            status = RunStatus.FAILED
            assistant_reply = f"Run failed: {exc}"
        finally:
            # Persist whatever the workspace looks like now — partial work
            # from a cancelled run still counts.
            try:
                self.store.append_transcript_message(
                    project_id,
                    TranscriptMessage(
                        role="assistant",
                        text=assistant_reply or "(no reply)",
                        run_id=run_id,
                    ),
                )
                if workspace is not None:
                    self.store.save_workspace(project_id, workspace)
            except Exception:
                pass
            self._active.pop(project_id, None)
            await self._broadcast(
                project_id,
                {
                    "type": "run_status",
                    "runId": run_id,
                    "status": status.value,
                },
            )

    def _spawn_broadcast(self, project_id: str, event: Dict[str, Any]) -> None:
        asyncio.create_task(self._broadcast(project_id, event))

    # --- mid-run interaction ------------------------------------------------------
    def answer(self, project_id: str, answer: str, question_id: Optional[str]) -> bool:
        active = self._active.get(project_id)
        if active is None:
            return False
        return active.gate.deliver(answer, question_id)

    def cancel(self, project_id: str) -> bool:
        active = self._active.get(project_id)
        if active is None or active.task.done():
            return False
        active.task.cancel()
        return True


def _event_to_wire(event: Any, run_id: str) -> Dict[str, Any]:
    """Typed RunEvent -> JSON payload for transports."""
    payload: Dict[str, Any] = {"type": event.type, "runId": run_id}
    if event.type in ("assistant_delta", "thinking_delta"):
        payload["text"] = event.text
        payload["eventId"] = event.event_id
    elif event.type == "tool_start":
        payload["eventId"] = event.event_id
        payload["name"] = event.name
        payload["input"] = event.input
    elif event.type == "tool_result":
        payload["eventId"] = event.event_id
        payload["name"] = event.name
        payload["output"] = event.output
        payload["ok"] = event.ok
    elif event.type == "set_code":
        payload["content"] = event.content
        payload["source"] = event.source
    elif event.type == "question":
        payload["questionId"] = event.event_id
        payload["question"] = event.question
        payload["options"] = event.options
    elif event.type == "status":
        payload["message"] = event.message
    return payload


def _build_tool_runtime(
    workspace: Workspace, keys: Dict[str, Optional[str]], settings: Dict[str, Any]
) -> Any:
    from agent.tools import AgentToolRuntime

    return AgentToolRuntime(
        file_state=workspace,
        should_generate_images=bool(settings.get("isImageGenerationEnabled", True)),
        openai_api_key=keys["openai_api_key"],
        openai_base_url=keys["openai_base_url"],
        gemini_api_key=keys["gemini_api_key"],
        replicate_api_key=keys["replicate_api_key"],
    )


def extract_engine_keys(settings: Dict[str, Any]) -> Dict[str, Optional[str]]:
    """Keys from the request settings, falling back to server env (config)."""
    from config import (
        ANTHROPIC_API_KEY,
        GEMINI_API_KEY,
        OPENAI_API_KEY,
        OPENAI_BASE_URL,
        REPLICATE_API_KEY,
    )

    def pick(param: str, env_value: Optional[str]) -> Optional[str]:
        value = settings.get(param)
        return value if value else env_value

    return {
        "openai_api_key": pick("openAiApiKey", OPENAI_API_KEY),
        "openai_base_url": pick("openAiBaseURL", OPENAI_BASE_URL) if not os.environ.get("IS_PROD") else None,
        "anthropic_api_key": pick("anthropicApiKey", ANTHROPIC_API_KEY),
        "gemini_api_key": pick("geminiApiKey", GEMINI_API_KEY),
        "replicate_api_key": pick("replicateApiKey", REPLICATE_API_KEY),
    }


def resolve_model(settings: Dict[str, Any]) -> Llm:
    """Explicit model from settings, else the best available default."""
    raw = settings.get("codeGenerationModel")
    if raw:
        try:
            return Llm(str(raw))
        except ValueError:
            pass
    keys = extract_engine_keys(settings)
    from routes.model_choice_sets import ALL_KEYS_MODELS_DEFAULT

    for model in ALL_KEYS_MODELS_DEFAULT:
        if model in OPENAI_MODELS and keys["openai_api_key"]:
            return model
        if model in ANTHROPIC_MODELS and keys["anthropic_api_key"]:
            return model
        if model in GEMINI_MODELS and keys["gemini_api_key"]:
            return model
    return ALL_KEYS_MODELS_DEFAULT[0]


async def build_run_prompts(
    workspace: Workspace, request: RunRequest
) -> List[ChatCompletionMessageParam]:
    """Conversation prompts for a project run.

    First run (empty workspace) builds a creation prompt from the brief;
    later runs build an update prompt over the current entry file.
    """
    from prompts.pipeline import build_prompt_messages
    from prompts.prompt_types import UserTurnInput

    stack = str(request.settings.get("generatedCodeConfig", "html_tailwind"))
    input_mode = "image" if request.images else "text"
    # TypedDict requires all base keys; image inputs carry no video parts.
    prompt: UserTurnInput = {"text": request.text, "images": [], "videos": []}
    if request.images:
        prompt["images"] = request.images
    file_state: Optional[Dict[str, str]] = None
    if workspace.content:
        file_state = {"path": workspace.entry_point, "content": workspace.content}
        generation_type = "update"
    else:
        generation_type = "create"

    messages = await build_prompt_messages(
        stack=stack,  # type: ignore[arg-type]
        input_mode=input_mode,  # type: ignore[arg-type]
        generation_type=generation_type,  # type: ignore[arg-type]
        prompt=prompt,
        history=[],
        file_state=file_state,
        image_generation_enabled=bool(
            request.settings.get("isImageGenerationEnabled", True)
        ),
        design_system=request.settings.get("designSystem"),
    )
    return list(messages)
