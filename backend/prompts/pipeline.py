from custom_types import InputMode
from prompts.create import build_create_prompt_from_input
from prompts.plan import derive_prompt_construction_plan
from prompts.prompt_types import PromptHistoryMessage, Stack, UserTurnInput
from prompts.message_builder import Prompt
from prompts.update import (
    build_update_prompt_from_file_snapshot,
    build_update_prompt_from_history,
)

# The studio (durable project) flow swaps in its own system prompt; builders
# hardcode prompts.system_prompt.SYSTEM_PROMPT, so overriding is done by
# patching the module attribute the builders read.
import prompts.system_prompt as system_prompt  # noqa: F401


async def build_prompt_messages(
    stack: Stack,
    input_mode: InputMode,
    generation_type: str,
    prompt: UserTurnInput,
    history: list[PromptHistoryMessage],
    file_state: dict[str, str] | None = None,
    image_generation_enabled: bool = True,
    design_system: str | None = None,
    system_prompt_override: str | None = None,
) -> Prompt:
    original_system_prompt = system_prompt.SYSTEM_PROMPT
    if system_prompt_override:
        system_prompt.SYSTEM_PROMPT = system_prompt_override
    try:
        return await _build_with_plan(
            stack=stack,
            input_mode=input_mode,
            generation_type=generation_type,
            prompt=prompt,
            history=history,
            file_state=file_state,
            image_generation_enabled=image_generation_enabled,
            design_system=design_system,
        )
    finally:
        system_prompt.SYSTEM_PROMPT = original_system_prompt


async def _build_with_plan(
    stack: Stack,
    input_mode: InputMode,
    generation_type: str,
    prompt: UserTurnInput,
    history: list[PromptHistoryMessage],
    file_state: dict[str, str] | None,
    image_generation_enabled: bool,
    design_system: str | None,
) -> Prompt:
    plan = derive_prompt_construction_plan(
        stack=stack,
        input_mode=input_mode,
        generation_type=generation_type,
        history=history,
        file_state=file_state,
    )

    strategy = plan["construction_strategy"]
    if strategy == "update_from_history":
        return build_update_prompt_from_history(
            stack=stack,
            history=history,
            image_generation_enabled=image_generation_enabled,
            design_system=design_system,
        )
    if strategy == "update_from_file_snapshot":
        assert file_state is not None
        return build_update_prompt_from_file_snapshot(
            stack=stack,
            prompt=prompt,
            file_state=file_state,
            image_generation_enabled=image_generation_enabled,
            design_system=design_system,
        )
    return build_create_prompt_from_input(
        input_mode,
        stack,
        prompt,
        image_generation_enabled,
        design_system,
    )
