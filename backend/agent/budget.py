"""Run spending ceilings shared by the coordinator and its subagents.

A run spends from one pool: the coordinator session and every subagent
session register here, and the runtime checks the pool total before each
additional provider turn. Without a shared budget each subagent received
its own full ceiling, multiplying the run's worst-case cost.
"""
from typing import Any, List, Optional


class SharedBudget:
    def __init__(self, limit_usd: Optional[float]) -> None:
        self.limit_usd = limit_usd
        self._sessions: List[Any] = []

    def register(self, session: Any) -> None:
        """Start counting a provider session against the shared pool."""
        self._sessions.append(session)

    def spent_usd(self) -> Optional[float]:
        """Total spend across registered sessions; None when unpriced."""
        if self.limit_usd is None:
            return None
        total = 0.0
        priced = False
        for session in self._sessions:
            cost = session.total_cost_usd()
            if cost is None:
                continue
            priced = True
            total += cost
        return total if priced else None
