"""Compatibility module: the workspace now lives in agent.workspace.

``AgentFileState`` is kept as an alias so existing imports
(``from agent.state import AgentFileState``) keep working during the
migration; new code should import ``Workspace``.
"""
from agent.workspace import (
    ENTRY_POINT,
    InvalidWorkspacePath,
    Workspace,
    ensure_str,
    normalize_path,
    seed_workspace_from_messages,
)

# Legacy names. Workspace(path=..., content=...) preserves the old
# constructor contract.
AgentFileState = Workspace
seed_file_state_from_messages = seed_workspace_from_messages

__all__ = [
    "ENTRY_POINT",
    "AgentFileState",
    "InvalidWorkspacePath",
    "Workspace",
    "ensure_str",
    "normalize_path",
    "seed_file_state_from_messages",
    "seed_workspace_from_messages",
]
