"""Scoped subagents for orchestrator runs.

A subagent gets a brief (role, objective, file scope, guidance) and works on
a COPY of its scoped files in an isolated Workspace. Nothing it writes can
touch files outside its scope; when it finishes, the scoped files are merged
back into the parent workspace. Scope ownership is structural — no locks,
no shared mutable state (the swarm analog of the variant isolation).

Subagents run depth-1 (they cannot spawn further agents) and cannot ask the
user questions; blockers go back to the orchestrator in the summary.
"""
import asyncio
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Optional

from openai.types.chat import ChatCompletionMessageParam

from agent.providers.factory import create_provider_session
from agent.runtime.events import RunEvent
from agent.runtime.interaction import UserInteraction
from agent.runtime.loop import AgentRuntime, RunEventSink, RuntimeConfig
from agent.runtime.statuses import RunStatus
from agent.workspace import Workspace
from config import GENERATION_MAX_COST_USD
from fs_logging.agent_runs import AgentRunRecorder
from llm import Llm

SubagentEmitter = Callable[[Dict[str, Any]], Awaitable[None]]


SUBAGENT_MAX_STEPS = 15


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
    files: List[str] = field(default_factory=_empty_files)
    error: Optional[str] = None
    status: RunStatus = RunStatus.COMPLETED


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
) -> SubagentResult:
    """Run one scoped subagent to completion and merge its files back."""
    from agent.tools import AgentToolRuntime

    if not brief.file_paths:
        return SubagentResult(
            ok=False,
            summary="",
            error="spawn_agent requires a non-empty file_paths scope.",
            status=RunStatus.FAILED,
        )

    # The subagent works on an isolated copy of its scoped files.
    sub_workspace = Workspace()
    for path in brief.file_paths:
        if parent_workspace.has(path):
            sub_workspace.write(path, parent_workspace.read(path))

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
    try:
        reply_buffer: List[str] = []

        async def collecting(event: RunEvent) -> None:
            if event.type == "assistant_delta":
                text = getattr(event, "text", "")
                if text:
                    reply_buffer.append(text)
            if emit is not None:
                await emit({"agent": brief.role, "event": event})

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
                max_steps=SUBAGENT_MAX_STEPS,
                budget_usd=GENERATION_MAX_COST_USD,
                # The final message is a chat summary for the orchestrator,
                # never a document; nothing is created without a tool call.
                finalize_from_text=False,
            ),
            file_state=sub_workspace,
        )

        await runtime.run(model, messages)
        summary = "".join(reply_buffer).strip() or "Subagent finished without a summary."

        # Merge the scoped files plus any NEW files the subagent created
        # (a designer adding hero.css is legitimate work product). Files the
        # subagent never touched keep the parent's copies untouched — the
        # scope guarantee is one-directional, never destructive.
        merged: List[str] = []
        for path in sub_workspace.list_files():
            parent_workspace.write(path, sub_workspace.read(path))
            merged.append(path)
        return SubagentResult(
            ok=True, summary=summary, files=merged, status=RunStatus.COMPLETED
        )
    except Exception as exc:
        return SubagentResult(
            ok=False,
            summary="",
            files=[],
            error=f"{exc.__class__.__name__}: {exc}",
            status=RunStatus.FAILED,
        )
    finally:
        await session.close()


async def _noop_emit(_event: Any) -> None:
    return None


async def run_subagents_parallel(
    briefs: List[SubagentBrief],
    parent_workspace: Workspace,
    model: Llm,
    request_settings: Dict[str, Any],
    keys: Dict[str, Optional[str]],
    max_concurrency: int = 3,
) -> List[SubagentResult]:
    """Run independent scoped subagents concurrently.

    Scopes are expected to be disjoint (the orchestrator's responsibility);
    each subagent merges its own files, so overlapping scopes would be
    last-writer-wins — avoid overlapping briefs.
    """
    semaphore = asyncio.Semaphore(max_concurrency)

    async def guarded(brief: SubagentBrief) -> SubagentResult:
        async with semaphore:
            return await run_subagent(
                brief, parent_workspace, model, request_settings, keys
            )

    return list(await asyncio.gather(*(guarded(brief) for brief in briefs)))
