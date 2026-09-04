"""Mid-run user interaction: the ask_user tool parks the loop on a gate until
the transport answers it.

The runtime depends only on the UserInteraction port, so tests can drive
questions with fakes and future transports (WS, HTTP polling) plug in without
touching the loop.
"""
import asyncio
import uuid
from dataclasses import dataclass
from typing import Callable, Optional, Protocol


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
        question_id: Optional[str] = None,
    ) -> str:
        """Ask the user and block until an answer arrives."""
        ...


class QuestionGate:
    """UserInteraction backed by futures, answered by an external transport.

    One gate per run. When a question is asked, the optional ``on_question``
    callback fires (transports use it to push the question to the UI);
    ``deliver`` resolves the parked ask. ``cancel`` unblocks a parked run
    with the given exception (used when the run is torn down).
    """

    def __init__(
        self, on_question: Optional[Callable[[UserQuestion], None]] = None
    ) -> None:
        self._pending: dict[str, asyncio.Future[str]] = {}
        self._cancelled: Optional[Exception] = None
        self._on_question = on_question

    async def ask(
        self,
        question: str,
        options: Optional[list[str]] = None,
        context: Optional[str] = None,
        question_id: Optional[str] = None,
    ) -> str:
        if self._cancelled is not None:
            raise self._cancelled
        # Callers pass their own event id so UI answers can address the
        # pending future without a second id mapping.
        id_value = question_id or uuid.uuid4().hex
        future: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        self._pending[id_value] = future
        user_question = UserQuestion(
            question=question,
            options=options,
            context=context,
            id=id_value,
        )
        if self._on_question is not None:
            self._on_question(user_question)
        try:
            return await future
        finally:
            self._pending.pop(id_value, None)

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
