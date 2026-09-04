"""Terminal failure modes of an agent run."""


class EmptyOutputError(Exception):
    """Raised when a run finishes without producing any HTML.

    Some models (observed: gemini-3.6-flash) occasionally run asset tools
    and then stop without calling create_file. Treating that as success
    poisons evals: the run looks green, diff mode skips it forever, and
    the output file is empty. Raising makes it a normal, retryable failure.
    """

    def __init__(self) -> None:
        super().__init__("Generation finished without producing any output.")


class BudgetExceededError(Exception):
    """Raised when a single generation exceeds the spend ceiling.

    The message is shown verbatim to end users (variantError), so it must
    not contain cost figures; the exact spend is in the run record.
    """

    def __init__(self) -> None:
        super().__init__(
            "Generation stopped: this variant exceeded its resource limit."
        )


class MaxStepsExceededError(Exception):
    """Raised when the loop exhausts its tool-turn budget without finishing."""

    def __init__(self) -> None:
        super().__init__("Agent exceeded max tool turns")


class StuckLoopError(Exception):
    """Raised when the model repeats an identical tool call past the limit.

    A repeating signature means the model is not making progress and each
    retry costs money; failing the run beats burning the budget.
    """

    def __init__(self, tool_name: str, repeats: int) -> None:
        self.tool_name = tool_name
        self.repeats = repeats
        super().__init__(
            f"Agent stuck: {tool_name!r} called with identical arguments "
            f"{repeats} times."
        )
