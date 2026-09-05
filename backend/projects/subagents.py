"""Scoped subagents for orchestrator runs.

A subagent gets a brief (role, objective, file scope, guidance) and works on
a COPY of its scoped files in an isolated Workspace. Nothing it writes can
touch files outside its scope; when it finishes, the scoped files are merged
back into the parent workspace. Scope ownership is structural (per-file
locks held for the whole delegation) rather than prompt-enforced.

Subagents run depth-1 (they cannot spawn further agents) and cannot ask the
user questions; blockers go back to the orchestrator in the summary.

Identity & observability: every specialist carries a stable agent id and a
short human name, emits explicit lifecycle events
(queued → working → verifying → terminal), spends against the run's shared
budget, and honours the run's cancellation.
"""
import asyncio
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Optional

from openai.types.chat import ChatCompletionMessageParam

from agent.budget import SharedBudget
from agent.providers.factory import create_provider_session
from agent.runtime.events import AgentIdentity, AgentLifecycleEvent, RunEvent
from agent.runtime.interaction import UserInteraction
from agent.runtime.loop import AgentRuntime, RuntimeConfig
from agent.runtime.statuses import RunStatus
from agent.workspace import Workspace
from fs_logging.agent_runs import AgentRunRecorder
from llm import Llm

SubagentEmitter = Callable[[Dict[str, Any]], Awaitable[None]]


@dataclass
class SubagentBrief:
    role: str
    objective: str
    file_paths: List[str]
    guidance: str = ""
    parent_context: str = ""


def _empty_files() -> List[str]:
    return []


@dataclass
class SubagentResult:
    ok: bool
    summary: str
    agent_id: str = ""
    name: str = ""
    status: RunStatus = RunStatus.COMPLETED
    files: List[str] = field(default_factory=_empty_files)
    error: Optional[str] = None


SUBAGENT_SYSTEM_PROMPT = """
You are a specialist subagent working inside a larger build. An orchestrator
delegated one self-contained unit of work to you.

- Work ONLY on the files in your scope. They are already in your workspace.
- You cannot see the rest of the project; rely on the brief and your files.
- You cannot ask the user questions. If something is genuinely blocking,
  say so clearly in your final summary instead of guessing silently.
- Implement, then verify your own work (read back what you wrote; use
  screenshot_preview when your scope affects rendered output).
- Finish with a concise summary for the orchestrator: what you did, key
  decisions, anything deferred or blocked. No code in the summary.
"""


def build_subagent_messages(
    brief: SubagentBrief,
    request_settings: Dict[str, Any],
) -> List[ChatCompletionMessageParam]:
    stack = str(request_settings.get("generatedCodeConfig", "html_tailwind"))
    scope = ", ".join(brief.file_paths) or "(none)"
    parts = [
        f"# Your role\n{brief.role}",
        f"# Objective\n{brief.objective}",
        f"# Files you own\n{scope}",
    ]
    if brief.parent_context:
        parts.append(f"# Project context\n{brief.parent_context}")
    if brief.guidance:
        parts.append(f"# Guidance from the orchestrator\n{brief.guidance}")
    return [
        {"role": "system", "content": SUBAGENT_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": (
                f"Complete your unit of work for the {stack} project.\n\n"
                + "\n\n".join(parts)
            ),
        },
    ]


class SubagentLocks:
    """One write-lock per file path, shared by coordinator and specialists."""

    def __init__(self) -> None:
        self._locks: Dict[str, asyncio.Lock] = {}

    def lock_for(self, path: str) -> asyncio.Lock:
        lock = self._locks.get(path)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[path] = lock
        return lock

    def locks_for(self, paths: List[str]) -> List[asyncio.Lock]:
        return [self.lock_for(path) for path in paths]


async def _acquire_all(locks: List[asyncio.Lock]) -> None:
    for lock in locks:
        await lock.acquire()


def _release_all(locks: List[asyncio.Lock]) -> None:
    for lock in locks:
        if lock.locked():
            lock.release()


@dataclass
class SubagentContext:
    """Everything a specialist needs beyond its brief."""

    budget: Optional[SharedBudget] = None
    locks: Optional[SubagentLocks] = None
    cancel_scope: Optional[asyncio.Event] = None  # set => cancel pending agents


async def run_subagent(
    brief: SubagentBrief,
    parent_workspace: Workspace,
    model: Llm,
    request_settings: Dict[str, Any],
    keys: Dict[str, Optional[str]],
    recorder: Optional[AgentRunRecorder] = None,
    emit: Optional[SubagentEmitter] = None,
    interaction: Optional[UserInteraction] = None,
    custom_model_id: Optional[str] = None,
    identity: Optional[AgentIdentity] = None,
    context: Optional[SubagentContext] = None,
) -> SubagentResult:
    """Run one scoped subagent to completion and merge its files back."""
    from agent.tools import AgentToolRuntime

    context = context or SubagentContext()
    agent_id = identity.agent_id if identity else "subagent"
    agent_name = identity.name if identity else (brief.role or "Specialist")
    parent_agent_id = identity.parent_agent_id if identity else None

    def event_identity() -> AgentIdentity:
        return AgentIdentity(
            agent_id=agent_id, name=agent_name, role=brief.role,
            parent_agent_id=parent_agent_id,
        )

    async def lifecycle(status: str, **extra: Any) -> None:
        if emit is None:
            return
        await emit(_lifecycle_wire(AgentLifecycleEvent(
            status=status,
            objective=brief.objective,
            file_paths=list(brief.file_paths),
            agent=event_identity(),
            **extra,
        )))

    if not brief.file_paths:
        await lifecycle("failed", error="spawn_agent requires a non-empty file_paths scope.")
        return SubagentResult(
            ok=False,
            summary="",
            agent_id=agent_id,
            name=agent_name,
            error="spawn_agent requires a non-empty file_paths scope.",
            status=RunStatus.FAILED,
        )

    await lifecycle("queued")
    if context.cancel_scope is not None and context.cancel_scope.is_set():
        await lifecycle("cancelled")
        return SubagentResult(
            ok=False, summary="", agent_id=agent_id, name=agent_name,
            status=RunStatus.CANCELLED, error="Run cancelled",
        )

    # The subagent works on an isolated copy of its scoped files, with the
    # scope enforced on every write — the model cannot step outside its
    # brief even by accident. The scope's per-file locks are held for the
    # whole delegation, so neither the coordinator nor another specialist
    # touches these files mid-run.
    sub_workspace = Workspace(write_scope=brief.file_paths)
    for path in brief.file_paths:
        if parent_workspace.has(path):
            sub_workspace.write(path, parent_workspace.read(path))

    locks = context.locks.locks_for(brief.file_paths) if context.locks else []
    await _acquire_all(locks)
    try:
        messages = build_subagent_messages(brief, request_settings)
        from agent.providers.custom import resolve_active_custom_provider

        session = create_provider_session(
            model=model,
            prompt_messages=messages,
            should_generate_images=bool(
                request_settings.get("isImageGenerationEnabled", True)
            ),
            openai_api_key=keys.get("openai_api_key"),
            openai_base_url=keys.get("openai_base_url"),
            anthropic_api_key=keys.get("anthropic_api_key"),
            gemini_api_key=keys.get("gemini_api_key"),
            replicate_api_key=keys.get("replicate_api_key"),
            custom_provider=resolve_active_custom_provider(
                request_settings.get("customProviders"),
                request_settings.get("activeCustomProviderId"),
            ),
            custom_model_id=custom_model_id,
            recorder=recorder,
            # Subagents never ask the user questions and never spawn agents.
            ask_user_enabled=False,
        )
        if context.budget is not None:
            context.budget.register(session)
        try:
            await lifecycle("working")

            reply_buffer: List[str] = []

            async def collecting(event: RunEvent) -> None:
                if event.type == "assistant_delta":
                    text = getattr(event, "text", "")
                    if text:
                        reply_buffer.append(text)
                if emit is not None:
                    payload = _runtime_event_wire(event, agent_id, agent_name, brief.role)
                    if payload is not None:
                        await emit(payload)

            runtime = AgentRuntime(
                session=session,
                tool_runtime=AgentToolRuntime(
                    file_state=sub_workspace,
                    should_generate_images=bool(
                        request_settings.get("isImageGenerationEnabled", True)
                    ),
                    openai_api_key=keys.get("openai_api_key"),
                    openai_base_url=keys.get("openai_base_url"),
                    gemini_api_key=keys.get("gemini_api_key"),
                    replicate_api_key=keys.get("replicate_api_key"),
                ),
                emit=collecting,
                recorder=recorder,
                interaction=interaction,
                config=RuntimeConfig(
                    shared_budget=context.budget,
                    # The final message is a chat summary for the orchestrator,
                    # never a document; nothing is created without a tool call.
                    finalize_from_text=False,
                ),
                file_state=sub_workspace,
            )

            await runtime.run(model, messages)
            summary = "".join(reply_buffer).strip() or "Subagent finished without a summary."

            # Merge the scoped files plus any NEW files the subagent created
            # (a designer adding hero.css is legitimate work product). Files
            # the subagent never touched keep the parent's copies untouched —
            # the scope guarantee is one-directional, never destructive.
            await lifecycle("verifying")
            merged: List[str] = []
            for path in sub_workspace.list_files():
                parent_workspace.write(path, sub_workspace.read(path))
                merged.append(path)
            await lifecycle("completed", summary=summary)
            return SubagentResult(
                ok=True, summary=summary, agent_id=agent_id, name=agent_name,
                files=merged, status=RunStatus.COMPLETED,
            )
        except asyncio.CancelledError:
            await lifecycle("cancelled")
            raise
        except Exception as exc:
            await lifecycle("failed", error=f"{exc.__class__.__name__}: {exc}")
            return SubagentResult(
                ok=False,
                summary="",
                agent_id=agent_id,
                name=agent_name,
                files=[],
                error=f"{exc.__class__.__name__}: {exc}",
                status=RunStatus.FAILED,
            )
        finally:
            await session.close()
    finally:
        _release_all(locks)


def _lifecycle_wire(event: AgentLifecycleEvent) -> Dict[str, Any]:
    agent = event.agent if event.agent is not None else AgentIdentity()
    return {
        "type": "agent_status",
        "agentId": agent.agent_id,
        "name": agent.name,
        "role": agent.role,
        "parentAgentId": agent.parent_agent_id,
        "status": event.status,
        "objective": event.objective,
        "filePaths": event.file_paths,
        "summary": event.summary,
        "error": event.error,
    }


def _runtime_event_wire(
    event: RunEvent, agent_id: str, agent_name: str, role: str
) -> Optional[Dict[str, Any]]:
    """Subagent runtime events as wire payloads attributed to the agent.

    Internal chat deltas are dropped: a specialist's own reasoning is not a
    progress signal; its tool actions and summaries are.
    """
    if event.type in ("assistant_delta", "thinking_delta", "set_code", "question"):
        return None
    payload: Dict[str, Any] = {
        "type": event.type,
        "agentId": agent_id,
        "name": agent_name,
        "role": role,
    }
    if event.type in ("tool_start", "tool_result"):
        payload["eventId"] = getattr(event, "event_id", "")
        payload["tool"] = getattr(event, "name", "")
    if event.type == "tool_start":
        payload["input"] = getattr(event, "input", {})
    if event.type == "tool_result":
        payload["output"] = getattr(event, "output", {})
        payload["ok"] = getattr(event, "ok", True)
    if event.type == "status":
        payload["message"] = getattr(event, "message", "")
    return payload


async def run_subagents_parallel(
    briefs: List[SubagentBrief],
    parent_workspace: Workspace,
    model: Llm,
    request_settings: Dict[str, Any],
    keys: Dict[str, Optional[str]],
    max_concurrency: int = 3,
    emit: Optional[SubagentEmitter] = None,
    custom_model_id: Optional[str] = None,
    identity_of: Optional[Callable[[SubagentBrief], AgentIdentity]] = None,
    context: Optional[SubagentContext] = None,
) -> List[SubagentResult]:
    """Run independent scoped subagents concurrently.

    Scopes are expected to be disjoint (the orchestrator's responsibility);
    overlapping scopes serialize on the shared per-file locks instead of
    corrupting each other, but disjoint briefs remain the supported shape.
    """
    context = context or SubagentContext()
    seen: set[str] = set()
    for brief in briefs:
        overlap = seen.intersection(brief.file_paths)
        if overlap:
            if emit is not None:
                await emit(_lifecycle_wire(AgentLifecycleEvent(
                    status="failed",
                    objective="Run a group of specialists in parallel.",
                    file_paths=sorted(overlap),
                    agent=AgentIdentity(
                        agent_id="team-invalid", name="Team", role="team",
                        parent_agent_id=None,
                    ),
                    error=f"Overlapping team file scope: {', '.join(sorted(overlap))}",
                )))
            overlap_id = "team-invalid"
            overlap_error = f"Overlapping team file scope: {', '.join(sorted(overlap))}"
            return [SubagentResult(ok=False, summary="", agent_id=overlap_id, name="Team",
                error=overlap_error, status=RunStatus.FAILED)]
        seen.update(brief.file_paths)
    semaphore = asyncio.Semaphore(max_concurrency)

    async def guarded(brief: SubagentBrief) -> SubagentResult:
        identity = identity_of(brief) if identity_of else None
        async with semaphore:
            return await run_subagent(
                brief, parent_workspace, model, request_settings, keys, emit=emit,
                custom_model_id=custom_model_id, identity=identity, context=context,
            )

    return list(await asyncio.gather(*(guarded(brief) for brief in briefs)))
