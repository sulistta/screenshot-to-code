"""Mid-run user interaction: the ask_user tool parks the loop on a gate until
the transport answers it.

The runtime depends only on the UserInteraction port, so tests can drive
questions with fakes and future transports (WS, HTTP polling) plug in without
touching the loop.
"""
import asyncio
import uuid
from dataclasses import dataclass
from typing import Optional, Protocol


@dataclass
class UserQuestion:
    question: str
    options: Optional[list[str]] = None
    context: Optional[str] = None
    id: str = ""


@dataclass
class UserAnswer:
    answer: str
    question_id: str = ""


class UserInteraction(Protocol):
    async def ask(
        self,
        question: str,
        options: Optional[list[str]] = None,
        context: Optional[str] = None,
    ) -> str:
        """Ask the user and block until an answer arrives."""
        ...


class QuestionGate:
    """UserInteraction backed by futures, answered by an external transport.

    One gate per run. The transport calls ``deliver`` when the user replies;
    ``cancel`` unblocks a parked run with the given exception (used when the
    socket dies mid-question).
    """

    def __init__(self) -> None:
        self._pending: dict[str, asyncio.Future[str]] = {}
        self._cancelled: Optional[Exception] = None

    async def ask(
        self,
        question: str,
        options: Optional[list[str]] = None,
        context: Optional[str] = None,
    ) -> str:
        if self._cancelled is not None:
            raise self._cancelled
        question_id = uuid.uuid4().hex
        future: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        self._pending[question_id] = future
        self.on_question(
            UserQuestion(
                question=question,
                options=options,
                context=context,
                id=question_id,
            )
        )
        try:
            return await future
        finally:
            self._pending.pop(question_id, None)

    def on_question(self, question: UserQuestion) -> None:
        """Hook for transports to observe new questions (send to UI, persist)."""
        return None

    def deliver(self, answer: str, question_id: Optional[str] = None) -> bool:
        """Answer the oldest pending question (or a specific one).

        Returns False when nothing is pending, so transports can reject
        stale answers instead of silently dropping them.
        """
        if self._cancelled is not None:
            raise self._cancelled
        if not self._pending:
            return False
        if question_id is not None:
            future = self._pending.get(question_id)
            if future is None or future.done():
                return False
        else:
            future = next(iter(self._pending.values()))
            if future.done():
                return False
        future.set_result(answer)
        return True

    def has_pending(self) -> bool:
        return any(not future.done() for future in self._pending.values())

    def cancel(self, reason: Exception) -> None:
        """Unblock parked asks; further asks fail immediately with ``reason``."""
        self._cancelled = reason
        for future in self._pending.values():
            if not future.done():
                future.set_exception(reason)
