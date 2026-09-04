from enum import Enum


class RunStatus(str, Enum):
    """Lifecycle states of a single agent run.

    WAITING_FOR_USER is a first-class state: an ask_user tool call parks the
    run until the user answers, instead of blocking invisibly.
    """

    RUNNING = "running"
    WAITING_FOR_USER = "waiting_for_user"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    STUCK = "stuck"
