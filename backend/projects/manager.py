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
from config import (
    ANTHROPIC_API_KEY,
    GENERATION_MAX_COST_USD,
    GEMINI_API_KEY,
    OPENAI_API_KEY,
)
from fs_logging.agent_runs import AgentRunRecorder
from llm import ANTHROPIC_MODELS, GEMINI_MODELS, MODEL_PROVIDER, OPENAI_MODELS, Llm
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
        # Resolve the effective model configuration NOW: this snapshot is the
        # execution's permanent record. Later settings changes never rewrite
        # it, and an unavailable explicit model fails loudly instead of
        # silently falling back.
        keys = extract_engine_keys(request.settings)
        config = resolve_execution_config(meta, request.settings, keys)
        run_id = uuid.uuid4().hex[:12]
        gate = QuestionGate()

        self.store.append_transcript_message(
            project_id,
            TranscriptMessage(role="user", text=request.text, images=request.images),
        )
        self.store.start_run_record(project_id, run_id, config)

        task = asyncio.create_task(
            self._run(project_id, meta.id, run_id, request, gate, config)
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
        config: Dict[str, str],
    ) -> None:
        status = RunStatus.FAILED
        assistant_reply = ""
        workspace: Optional[Workspace] = None
        files_before: set[str] = set()
        error_message: Optional[str] = None
        try:
            workspace = self.store.load_workspace(project_id)
            files_before = set(workspace.files)
            prompt_messages = await build_run_prompts(
                workspace,
                request,
                history=self.store.read_transcript(project_id)[:-1],
                execution_mode=config["execution_mode"],
            )

            settings = request.settings
            model = _model_from_value(config["primary_model"])
            subagent_model = (
                _model_from_value(config["subagent_model"])
                if config["subagent_model"]
                else model
            )
            engine_keys = extract_engine_keys(settings)
            # SINGLE prohibits delegation structurally: the tool is not
            # advertised and no runner exists to service it.
            delegation_allowed = config["execution_mode"] in ("auto", "swarm")

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
                spawn_agent_enabled=delegation_allowed,
            )
            assistant_reply_buffer: List[str] = []

            async def emitting(event: Any) -> None:
                if event.type == "assistant_delta" and event.text:
                    assistant_reply_buffer.append(event.text)
                await self._broadcast(project_id, _event_to_wire(event, run_id))

            try:
                from projects.subagents import SubagentBrief, run_subagent

                async def subagent_runner(args: Dict[str, Any]) -> Any:
                    from agent.tools.types import ToolExecutionResult

                    brief = SubagentBrief(
                        role=str(args.get("role", "specialist")),
                        objective=str(args.get("objective", "")),
                        file_paths=[
                            path
                            for path in list(args.get("file_paths") or [])
                            if isinstance(path, str)
                        ],
                        guidance=str(args.get("guidance", "") or ""),
                        parent_context=str(args.get("context", "") or ""),
                    )
                    outcome = await run_subagent(
                        brief,
                        workspace,
                        subagent_model,
                        settings,
                        engine_keys,
                    )
                    return ToolExecutionResult(
                        ok=outcome.ok,
                        result={
                            "summary": outcome.summary,
                            "files": outcome.files,
                            **({"error": outcome.error} if outcome.error else {}),
                        },
                        summary={
                            "role": brief.role,
                            "ok": outcome.ok,
                            "files": outcome.files,
                            "summary": outcome.summary[:300],
                        },
                    )

                runtime = AgentRuntime(
                    session=session,
                    tool_runtime=_build_tool_runtime(
                        workspace,
                        engine_keys,
                        settings,
                        subagent_runner if delegation_allowed else None,
                    ),
                    emit=emitting,
                    recorder=recorder,
                    interaction=gate,
                    config=RuntimeConfig(budget_usd=GENERATION_MAX_COST_USD),
                    file_state=workspace,
                )
                await self._broadcast(
                    project_id,
                    {
                        "type": "run_status",
                        "runId": run_id,
                        "status": "running",
                        "config": config,
                    },
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
        except ValueError as exc:
            status = RunStatus.FAILED
            error_message = str(exc)
            assistant_reply = f"Run failed: {error_message}"
        except Exception as exc:
            status = RunStatus.FAILED
            error_message = categorize_error(exc)
            assistant_reply = f"Run failed: {error_message}"
        finally:
            # Persist whatever the workspace looks like now — partial work
            # from a cancelled run still counts.
            files_changed: List[str] = []
            iteration_id: Optional[str] = None
            try:
                if workspace is not None:
                    self.store.save_workspace(project_id, workspace)
                    files_changed = sorted(
                        path
                        for path in set(workspace.files) ^ files_before
                        if path in workspace.files
                    )
            except Exception:
                pass
            # Only completed executions become iterations: a checkpoint is a
            # meaningful, validated state, not every intermediate write.
            if status is RunStatus.COMPLETED and workspace is not None:
                try:
                    record = self.store.save_iteration(
                        project_id,
                        run_id,
                        workspace,
                        label=iteration_label(
                            len(self.store.list_iterations(project_id)),
                            bool(files_before),
                        ),
                        summary=assistant_reply,
                    )
                    iteration_id = record["id"]
                except Exception:
                    pass
            try:
                self.store.finish_run_record(
                    project_id,
                    run_id,
                    status.value,
                    files_changed=files_changed,
                    iteration_id=iteration_id,
                    error=error_message,
                )
                self.store.append_transcript_message(
                    project_id,
                    TranscriptMessage(
                        role="assistant",
                        text=assistant_reply or "(no reply)",
                        run_id=run_id,
                    ),
                )
            except Exception:
                pass
            self._active.pop(project_id, None)
            await self._broadcast(
                project_id,
                {
                    "type": "run_status",
                    "runId": run_id,
                    "status": status.value,
                    "iterationId": iteration_id,
                    "filesChanged": files_changed,
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


def _mode_directive(execution_mode: str) -> str:
    if execution_mode == "single":
        return (
            "\n\n# Execution mode: SINGLE\n"
            "- You work alone in this run: no subagents are available. Do the "
            "work yourself, even when it is large; sequence it yourself.\n"
        )
    if execution_mode == "swarm":
        return (
            "\n\n# Execution mode: SWARM\n"
            "- Delegation is encouraged for substantial builds: decompose the "
            "work into 2-4 scoped specialists (via spawn_agent) where the "
            "parts are genuinely separable. Still avoid ceremony: a small "
            "task may not need any subagent.\n"
        )
    return (
        "\n\n# Execution mode: AUTO\n"
        "- You decide whether delegation adds value. Spawn a subagent only "
        "for a genuinely separable unit of work; most tasks need none.\n"
    )


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
    workspace: Workspace,
    keys: Dict[str, Optional[str]],
    settings: Dict[str, Any],
    subagent_runner: Optional[Any] = None,
) -> Any:
    from agent.tools import AgentToolRuntime

    return AgentToolRuntime(
        file_state=workspace,
        should_generate_images=bool(settings.get("isImageGenerationEnabled", True)),
        openai_api_key=keys["openai_api_key"],
        openai_base_url=keys["openai_base_url"],
        gemini_api_key=keys["gemini_api_key"],
        replicate_api_key=keys["replicate_api_key"],
        subagent_runner=subagent_runner,
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


def resolve_execution_config(
    meta: Any,
    settings: Dict[str, Any],
    keys: Dict[str, Optional[str]],
) -> Dict[str, str]:
    """Resolve the effective execution configuration and validate it.

    Precedence: run settings > project defaults. An explicit model that no
    available key supports is a hard error — never a silent fallback.
    """
    primary = str(settings.get("primaryModel") or meta.primary_model or "").strip()
    subagent = str(
        settings.get("subagentModel") or meta.subagent_model or ""
    ).strip()
    mode = str(
        settings.get("executionMode") or meta.execution_mode or "auto"
    ).strip()
    if mode not in ("auto", "single", "swarm"):
        raise ValueError(f"Invalid execution mode: {mode}")

    available_by_value = available_models(keys)
    if primary:
        if primary not in available_by_value:
            raise ValueError(
                f"Primary model {primary!r} is not available with the "
                "configured provider keys. Check Settings → Providers or "
                "pick another model."
            )
    else:
        primary = default_model_value(keys)
    if subagent and subagent not in available_by_value:
        raise ValueError(
            f"Subagent model {subagent!r} is not available with the "
            "configured provider keys. Check Settings → Providers or "
            "pick another model."
        )

    return {
        "primary_model": primary,
        # Empty subagent model: subagents use the primary model.
        "subagent_model": subagent,
        "execution_mode": mode,
    }


def available_models(keys: Dict[str, Optional[str]]) -> List[str]:
    """Model values usable with the currently configured provider keys."""
    by_provider = {
        "openai": bool(keys.get("openai_api_key")) or bool(OPENAI_API_KEY),
        "anthropic": bool(keys.get("anthropic_api_key")) or bool(ANTHROPIC_API_KEY),
        "gemini": bool(keys.get("gemini_api_key")) or bool(GEMINI_API_KEY),
    }
    values: List[str] = []
    for model in Llm:
        provider = MODEL_PROVIDER.get(model)
        if provider and by_provider.get(provider):
            values.append(model.value)
    return values


def default_model_value(keys: Dict[str, Optional[str]]) -> str:
    """Best default primary model given available keys."""
    keys = {
        **keys,
        "openai_api_key": keys.get("openai_api_key") or OPENAI_API_KEY,
        "anthropic_api_key": keys.get("anthropic_api_key") or ANTHROPIC_API_KEY,
        "gemini_api_key": keys.get("gemini_api_key") or GEMINI_API_KEY,
    }
    from routes.model_choice_sets import ALL_KEYS_MODELS_DEFAULT

    for model in ALL_KEYS_MODELS_DEFAULT:
        if model in OPENAI_MODELS and keys["openai_api_key"]:
            return model.value
        if model in ANTHROPIC_MODELS and keys["anthropic_api_key"]:
            return model.value
        if model in GEMINI_MODELS and keys["gemini_api_key"]:
            return model.value
    raise ValueError(
        "No model API key available. Add OPENAI_API_KEY, ANTHROPIC_API_KEY, "
        "or GEMINI_API_KEY to the backend environment."
    )


def _model_from_value(value: str) -> Llm:
    """Parse a model value; unknown values are a hard error, not a fallback."""
    try:
        return Llm(value)
    except ValueError:
        raise ValueError(
            f"Unknown model: {value!r}. Pick a model in Settings → Providers."
        )


def categorize_error(exc: Exception) -> str:
    """Map provider/runtime exceptions to a user-actionable category line."""
    name = exc.__class__.__name__
    text = str(exc)
    module = getattr(exc.__class__, "__module__", "")
    if "AuthenticationError" in name:
        return (
            "Authentication failed: the provider rejected the API key. "
            "Check the key in Settings → Providers."
        )
    if "RateLimit" in name or "quota" in text.lower():
        return (
            "Provider rate limit or quota reached. Wait a moment or check "
            "your provider plan and billing."
        )
    if "NotFound" in name and "openai" in module:
        return (
            "The provider does not know this model. Pick another model in "
            "the run configuration."
        )
    if "APIConnection" in name or "Connect" in name or "Timeout" in name:
        return (
            "Could not reach the model provider (network error or timeout). "
            "Check your connection and retry."
        )
    if "Budget" in name:
        return "This run exceeded its spending limit and was stopped."
    if "Stuck" in name:
        return "The agent repeated the same step without progress and was stopped."
    return f"Unexpected error ({name}): {text}"


def iteration_label(index: int, has_prior_work: bool) -> str:
    if index == 0 or not has_prior_work:
        return "Initial implementation"
    return f"Revision {index}"


async def build_run_prompts(
    workspace: Workspace,
    request: RunRequest,
    history: Optional[List[TranscriptMessage]] = None,
    execution_mode: str = "auto",
) -> List[ChatCompletionMessageParam]:
    """Conversation prompts for a project run.

    Uses the studio system prompt (creative direction + durable project
    guidance). First run (empty workspace) builds a creation prompt from the
    brief; later runs build an update prompt over the current entry file.
    Prior transcript turns are replayed as chat history so the agent keeps
    conversational context across runs.
    """
    from prompts.pipeline import build_prompt_messages
    from prompts.prompt_types import (
        PromptHistoryMessage,
        UserTurnInput,
    )
    from prompts.studio_system_prompt import STUDIO_SYSTEM_PROMPT

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

    chat_history: List[PromptHistoryMessage] = [
        {"role": message.role, "text": message.text, "images": [], "videos": []}
        for message in (history or [])
        if message.role in ("user", "assistant") and message.text
    ]

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
        system_prompt_override=STUDIO_SYSTEM_PROMPT + _mode_directive(execution_mode),
    )
    if not chat_history:
        return list(messages)

    # The pipeline's history strategies replace the current turn; the studio
    # flow needs transcript context AND the new message AND the file
    # snapshot, so splice transcript turns in after the system prompt.
    transcript: List[ChatCompletionMessageParam] = [
        {"role": message["role"], "content": message["text"]}  # type: ignore[typeddict-item]
        for message in chat_history
    ]
    return [messages[0], *transcript, *messages[1:]]  # type: ignore[list-item]
