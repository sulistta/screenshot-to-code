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
import logging
import os
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, cast

from openai.types.chat import ChatCompletionMessageParam

from agent.budget import SharedBudget
from agent.providers.custom import resolve_active_custom_provider
from agent.providers.factory import create_provider_session
from agent.runtime.errors import EmptyOutputError
from agent.runtime.events import AgentIdentity
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
from projects.agents import (
    AgentRun,
    AgentTeam,
    AgentRunStore,
    coordinator_agent,
    now_iso as timestamp_now,
)
from projects.store import ProjectStore, TranscriptMessage
from projects.event_store import EventJournal

RunEventSink = Callable[[Any], Any]  # async callable(RunEvent)
logger = logging.getLogger(__name__)


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
    started: bool = False
    cancelling: bool = False
    team: AgentTeam = field(default_factory=AgentTeam)
    budget: Optional[SharedBudget] = None
    locks: Any = None
    cancel_scope: asyncio.Event = field(default_factory=asyncio.Event)


class ProjectRunManager:
    def __init__(self, store: ProjectStore) -> None:
        self.store = store
        self._active: Dict[str, ActiveRun] = {}
        self._sinks: Dict[str, List[RunEventSink]] = {}
        self.journal = EventJournal(store.root / ".events.sqlite3")
        self.agent_runs = AgentRunStore(store)
        self._recover_interrupted_runs()

    def _recover_interrupted_runs(self) -> None:
        """A process restart cannot resume provider sessions; finish them explicitly."""
        for project in self.store.list():
            for agent in self.agent_runs.list_running(project.id):
                agent.status = "cancelled"
                agent.finished_at = agent.started_at
                agent.error = "Run interrupted by a Studio restart."
                self.agent_runs.save(project.id, agent)
                self.journal.append(project.id, {"type": "agent_status",
                    "agentId": agent.agent_id, "name": agent.name, "role": agent.role,
                    "parentAgentId": agent.parent_agent_id, "status": "cancelled",
                    "objective": agent.objective, "filePaths": agent.file_paths,
                    "summary": "", "error": agent.error})
            for record in self.store.list_run_records(project.id):
                if record.get("status") not in {"running", "waiting_for_user"}:
                    continue
                run_id = record["run_id"]
                message = "Run interrupted by a Studio restart. Saved files are preserved; send a message to continue."
                self.store.finish_run_record(project.id, run_id, "failed", error=message)
                self.store.append_transcript_message(project.id, TranscriptMessage(
                    role="assistant", text=message, run_id=run_id))
                self.journal.append(project.id, {"type": "run_status", "runId": run_id,
                    "status": "failed", "message": message, "error": message,
                    "filesChanged": [], "iterationId": None})

    # --- transports -----------------------------------------------------------
    def attach_sink(self, project_id: str, sink: RunEventSink, replay: bool = True) -> None:
        self._sinks.setdefault(project_id, []).append(sink)
        if not replay:
            return
        # Replay from the durable journal, not memory: a transport attaching
        # after a backend restart still receives the run history.
        for event in self.journal.read(project_id, limit=500):
            self._put(sink, event)

    def detach_sink(self, project_id: str, sink: RunEventSink) -> None:
        sinks = self._sinks.get(project_id)
        if sinks and sink in sinks:
            sinks.remove(sink)

    def _put(self, sink: RunEventSink, event: Dict[str, Any]) -> None:
        result = sink(event)
        if asyncio.iscoroutine(result):
            asyncio.create_task(result)

    async def _broadcast(self, project_id: str, event: Dict[str, Any]) -> None:
        event = self.journal.append(project_id, event)
        for sink in list(self._sinks.get(project_id, [])):
            try:
                await sink(event)
            except Exception:
                # A disconnected UI must not turn a successful generation into
                # a failed run. The client can reconnect and replay the journal.
                logger.warning("Detached failed project event sink", exc_info=True)
                self.detach_sink(project_id, sink)

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
            TranscriptMessage(
                role="user", text=request.text, images=request.images, run_id=run_id
            ),
        )
        self.store.start_run_record(project_id, run_id, config)
        # One shared spending ceiling for the coordinator and every
        # specialist; individual sessions no longer each get a full budget.
        budget = SharedBudget(GENERATION_MAX_COST_USD)
        coordinator = coordinator_agent(run_id, request.text.strip() or "(image brief)")
        self.agent_runs.save(project_id, coordinator)
        self.journal.append(project_id, {"type": "agent_status",
            "agentId": coordinator.agent_id, "name": coordinator.name,
            "role": coordinator.role, "parentAgentId": None,
            "status": "working", "objective": coordinator.objective,
            "filePaths": [], "summary": "", "error": None})

        task = asyncio.create_task(
            self._run(project_id, meta.id, run_id, request, gate, config, budget)
        )
        self._active[project_id] = ActiveRun(
            run_id=run_id, task=task, gate=gate, status=RunStatus.RUNNING,
            budget=budget,
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
        budget: SharedBudget,
    ) -> None:
        status = RunStatus.FAILED
        assistant_reply = ""
        workspace: Optional[Workspace] = None
        files_before: Dict[str, str] = {}
        error_message: Optional[str] = None
        active = self._active[project_id]
        cancel_event = active.cancel_scope
        try:
            active = self._active[project_id]
            active.started = True
            if active.cancelling:
                raise asyncio.CancelledError()
            await self._broadcast(project_id, {
                "type": "run_status", "runId": run_id,
                "status": "running", "config": config,
            })
            await self._broadcast(project_id, {
                "type": "user_message", "runId": run_id,
                "text": request.text, "images": request.images,
            })
            workspace = self.store.load_workspace(project_id)
            files_before = dict(workspace.files)
            prompt_messages = await build_run_prompts(
                workspace,
                request,
                history=self.store.read_transcript(project_id)[:-1],
            )

            settings = request.settings
            model = _model_from_value(config["primary_model"])
            subagent_model = (
                _model_from_value(config["subagent_model"])
                if config["subagent_model"]
                else model
            )
            primary_custom_id = custom_model_id_of(config["primary_model"])
            subagent_custom_id = custom_model_id_of(config["subagent_model"])
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
                orchestrator=True,
                custom_model_id=primary_custom_id,
            )
            # The coordinator spends from the same pool as its specialists.
            budget.register(session)
            assistant_reply_buffer: List[str] = []

            async def emitting(event: Any) -> None:
                if event.type == "assistant_delta" and event.text:
                    assistant_reply_buffer.append(event.text)
                await self._broadcast(project_id, _event_to_wire(event, run_id))

            try:
                from projects.subagents import (
                    SubagentBrief,
                    SubagentContext,
                    SubagentLocks,
                    run_subagent,
                    run_subagents_parallel,
                )

                active = self._active[project_id]
                locks = active.locks if active.locks is not None else SubagentLocks()
                if active.locks is None:
                    active.locks = locks
                sub_context = SubagentContext(
                    budget=budget, locks=locks, cancel_scope=cancel_event
                )

                def identity_for(brief: SubagentBrief) -> Any:
                    agent_id = active.team.new_agent_id()
                    name = active.team.specialist_name(brief.role)
                    agent = AgentRun(
                        agent_id=agent_id, run_id=run_id, name=name,
                        role=brief.role, parent_agent_id="coordinator",
                        objective=brief.objective, status="queued",
                        file_paths=list(brief.file_paths),
                    )
                    self.agent_runs.save(project_id, agent)
                    return AgentIdentity(
                        agent_id=agent_id, name=name, role=brief.role,
                        parent_agent_id="coordinator",
                    )

                async def persist_agent(agent_id: str, **updates: Any) -> None:
                    record = self.agent_runs.get(project_id, run_id, agent_id)
                    if record is None:
                        return
                    for key, value in updates.items():
                        setattr(record, key, value)
                    self.agent_runs.save(project_id, record)

                async def team_emit(event: Dict[str, Any]) -> None:
                    await self._broadcast(project_id, event)
                    event_type = event.get("type")
                    agent_id = event.get("agentId")
                    if not isinstance(agent_id, str) or not agent_id:
                        return
                    if event_type == "agent_status":
                        status = str(event.get("status", ""))
                        updates: Dict[str, Any] = {"status": status}
                        if event.get("summary"):
                            updates["summary"] = str(event["summary"])
                        if event.get("error"):
                            updates["error"] = str(event["error"])
                        if status in {"completed", "failed", "cancelled"}:
                            updates["finished_at"] = timestamp_now()
                        await persist_agent(agent_id, **updates)

                async def subagent_runner(args: Dict[str, Any]) -> Any:
                    from agent.tools.types import ToolExecutionResult

                    raw: List[Any] = list(args["agents"]) if isinstance(args.get("agents"), list) else [args]
                    briefs: List[SubagentBrief] = []
                    for item in raw:
                        if not isinstance(item, dict):
                            continue
                        candidate_paths = cast(List[object], item.get("file_paths")) if isinstance(item.get("file_paths"), list) else []
                        paths = [path for path in candidate_paths if isinstance(path, str)] if isinstance(candidate_paths, list) else []
                        briefs.append(SubagentBrief(role=str(item.get("role", "specialist")), objective=str(item.get("objective", "")), file_paths=paths, guidance=str(item.get("guidance", "") or ""), parent_context=str(item.get("context", "") or "")))
                    if len(briefs) > 1:
                        outcomes = await run_subagents_parallel(
                            briefs, workspace, subagent_model, settings, engine_keys,
                            emit=team_emit, custom_model_id=subagent_custom_id,
                            identity_of=identity_for, context=sub_context,
                        )
                    else:
                        brief = briefs[0]
                        outcome = await run_subagent(
                            brief, workspace, subagent_model, settings, engine_keys,
                            custom_model_id=subagent_custom_id, emit=team_emit,
                            identity=identity_for(brief), context=sub_context,
                        ) if briefs else None
                        outcomes = [outcome] if outcome is not None else []
                    # The merge result is the authoritative file list per agent.
                    for item in outcomes:
                        if item.agent_id and item.agent_id != "team-invalid":
                            await persist_agent(item.agent_id, files=list(item.files))
                    outcome = outcomes[0] if len(outcomes) == 1 else None
                    return ToolExecutionResult(
                        ok=bool(outcomes) and all(item.ok for item in outcomes),
                        result={
                            "summary": outcome.summary if outcome else "Parallel team completed.",
                            "files": [path for item in outcomes for path in item.files],
                            "agents": [
                                {
                                    "agentId": item.agent_id,
                                    "name": item.name or brief.role,
                                    "role": brief.role,
                                    "summary": item.summary,
                                    "files": item.files,
                                    "error": item.error,
                                }
                                for brief, item in zip(briefs, outcomes)
                            ],
                        },
                        summary={
                            "roles": [brief.role for brief in briefs],
                            "ok": bool(outcomes) and all(item.ok for item in outcomes),
                        },
                    )

                runtime = AgentRuntime(
                    session=session,
                    tool_runtime=_build_tool_runtime(
                        workspace,
                        engine_keys,
                        settings,
                        subagent_runner,
                        orchestrator=True,
                    ),
                    emit=emitting,
                    recorder=recorder,
                    interaction=gate,
                    config=RuntimeConfig(shared_budget=budget),
                    file_state=workspace,
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
            # Cascade: any specialist still queued or running under this run
            # terminates with the run.
            active.cancel_scope.set()
            try:
                coordinator = self.agent_runs.get(project_id, run_id, "coordinator")
                if coordinator is not None:
                    coordinator.status = {
                        RunStatus.COMPLETED: "completed",
                        RunStatus.CANCELLED: "cancelled",
                    }.get(status, "failed")
                    coordinator.finished_at = timestamp_now()
                    coordinator.summary = assistant_reply
                    coordinator.error = error_message
                    self.agent_runs.save(project_id, coordinator)
            except Exception:
                logger.exception("Could not persist the coordinator record for %s", run_id)
            files_changed: List[str] = []
            iteration_id: Optional[str] = None
            def persistence_failed(operation: str) -> None:
                nonlocal status, error_message, assistant_reply
                logger.exception("Could not persist %s for run %s", operation, run_id)
                status = RunStatus.FAILED
                error_message = f"Could not save {operation}. Check available disk space and permissions."
                assistant_reply = f"Run failed: {error_message}"

            try:
                if workspace is not None:
                    files_changed = sorted(
                        path
                        for path in workspace.files.keys() | files_before.keys()
                        if workspace.files.get(path) != files_before.get(path)
                    )
                    if status is RunStatus.COMPLETED:
                        # Only a completed run publishes the live workspace.
                        self.store.save_workspace(project_id, workspace)
            except Exception:
                persistence_failed("the workspace")
            # Only completed executions publish their files as the live
            # workspace version AND create an iteration checkpoint. Failed
            # and cancelled runs keep their partial output in a per-run
            # draft instead of replacing the last working files.
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
                    persistence_failed("the version")
            elif workspace is not None and files_changed:
                # Partial output of a failed/cancelled run is a recoverable
                # draft, never the live version.
                try:
                    self.store.save_draft(project_id, run_id, workspace)
                except Exception:
                    persistence_failed("the run draft")
            try:
                self.store.append_transcript_message(
                    project_id,
                    TranscriptMessage(
                        role="assistant",
                        text=assistant_reply or "(no reply)",
                        run_id=run_id,
                    ),
                )
            except Exception:
                persistence_failed("the conversation")
            try:
                self.store.finish_run_record(
                    project_id, run_id, status.value,
                    files_changed=files_changed, iteration_id=iteration_id,
                    error=error_message,
                )
            except Exception:
                persistence_failed("the run record")
            self._active.pop(project_id, None)
            self.journal.prune(project_id)
            await self._broadcast(
                project_id,
                {
                    "type": "run_status",
                    "runId": run_id,
                    "status": status.value,
                    "iterationId": iteration_id,
                    "filesChanged": files_changed,
                    "message": assistant_reply,
                    "error": error_message,
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
        if active is None or active.task.done() or active.cancelling:
            return False
        active.cancelling = True
        # Cascade: specialists observe the scope (queued agents exit; running
        # ones finish at their next await and still persist their records).
        active.cancel_scope.set()
        # Cancelling before the coroutine starts skips its finally block. Let
        # it enter first so the durable run record is always finalized.
        if active.started:
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
    workspace: Workspace,
    keys: Dict[str, Optional[str]],
    settings: Dict[str, Any],
    subagent_runner: Optional[Any] = None,
    orchestrator: bool = False,
) -> Any:
    from agent.tools import AgentToolRuntime

    return AgentToolRuntime(
        file_state=workspace,
        should_generate_images=bool(settings.get("isImageGenerationEnabled", True)),
        orchestrator=orchestrator,
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

    available_by_value = available_models(keys)
    # A user-registered custom provider makes the OpenAI-compatible model
    # selectable regardless of built-in provider keys — including its
    # individual model ids, addressed as "custom:<model-id>".
    custom = active_custom_provider(settings)
    if custom is not None:
        # models are plain model-id strings on the resolved provider.
        available_by_value.append(Llm.OPENAI_COMPATIBLE.value)
        available_by_value.extend(f"custom:{model_id}" for model_id in custom.models)
    if primary:
        if primary not in available_by_value:
            raise ValueError(
                f"Primary model {primary!r} is not available with the "
                "configured provider keys. Check Settings → Providers or "
                "pick another model."
            )
    else:
        # With no built-in keys, an active custom provider is the default.
        if active_custom_provider(settings) is not None:
            primary = Llm.OPENAI_COMPATIBLE.value
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
    }


def active_custom_provider(settings: Dict[str, Any]) -> Any:
    try:
        return resolve_active_custom_provider(
            settings.get("customProviders"),
            settings.get("activeCustomProviderId"),
        )
    except ValueError:
        return None


PROVIDER_LABELS = {
    "openai": "OpenAI",
    "anthropic": "Anthropic",
    "gemini": "Google Gemini",
}


def available_model_entries(keys: Dict[str, Optional[str]]) -> List[Dict[str, str]]:
    """Model entries with provider info for the configuration UI.

    Built-in provider models come first (grouped by provider), then every
    active custom provider's models as `custom:<model-id>`.
    """
    by_provider: Dict[str, List[str]] = {
        "openai": [],
        "anthropic": [],
        "gemini": [],
    }
    for model in Llm:
        if model is Llm.OPENAI_COMPATIBLE:
            # Requires a user-registered custom provider; those models are
            # listed separately with their provider's name.
            continue
        provider = MODEL_PROVIDER.get(model)
        if provider and model.value not in by_provider[provider]:
            if keys.get(f"{provider}_api_key") or {
                "openai": OPENAI_API_KEY,
                "anthropic": ANTHROPIC_API_KEY,
                "gemini": GEMINI_API_KEY,
            }.get(provider):
                by_provider[provider].append(model.value)

    entries: List[Dict[str, str]] = []
    for provider in ("anthropic", "openai", "gemini"):
        for value in by_provider[provider]:
            entries.append(
                {"value": value, "provider": provider, "group": PROVIDER_LABELS[provider]}
            )
    return entries


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
    if value.startswith("custom:"):
        return Llm.OPENAI_COMPATIBLE
    try:
        return Llm(value)
    except ValueError:
        raise ValueError(
            f"Unknown model: {value!r}. Pick a model in Settings → Providers."
        )


def custom_model_id_of(value: str) -> Optional[str]:
    """Model id pinned within the active custom provider, if any."""
    if value.startswith("custom:"):
        return value[len("custom:"):]
    return None


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
) -> List[ChatCompletionMessageParam]:
    """Conversation prompts for a project run.

    Uses the studio system prompt (orchestration + durable project guidance).
    First run (empty workspace) builds a creation prompt from the brief;
    later runs build an update prompt over the current entry file. Prior
    transcript turns are replayed as chat history so the agent keeps
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
        system_prompt_override=STUDIO_SYSTEM_PROMPT,
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
