from typing import Any, Dict, List

from agent.tools.types import CanonicalToolDefinition
from image_generation.replicate import P_IMAGE_EDIT_ASPECT_RATIOS
from uploaded_assets.tools import SAVE_ASSETS_TOOL_DEFINITION


def _create_schema() -> Dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": (
                    "Workspace-relative path. Use index.html for the entry "
                    "page; additional files (styles.css, main.js, about.html) "
                    "are referenced from HTML with relative URLs."
                ),
            },
            "content": {
                "type": "string",
                "description": "Full content of the file.",
            },
        },
        "required": ["content"],
    }


def _edit_schema() -> Dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": (
                    "Workspace-relative path of the file to edit. Defaults to "
                    "the entry page (index.html)."
                ),
            },
            "old_text": {
                "type": "string",
                "description": "Exact text to replace. Must match the file contents.",
            },
            "new_text": {
                "type": "string",
                "description": "Replacement text.",
            },
            "count": {
                "type": "integer",
                "description": "How many occurrences to replace. Use -1 for all.",
            },
            "edits": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "old_text": {"type": "string"},
                        "new_text": {"type": "string"},
                        "count": {"type": "integer"},
                    },
                    "required": ["old_text", "new_text"],
                },
            },
        },
    }


def _read_file_schema() -> Dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Workspace-relative path of the file to read.",
            }
        },
        "required": ["path"],
    }


def _list_files_schema() -> Dict[str, Any]:
    return {
        "type": "object",
        "properties": {},
    }


def _research_schema() -> Dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "The public http(s) URL of the documentation, article, or reference page to read.",
            }
        },
        "required": ["url"],
    }


def _spawn_agent_schema() -> Dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "role": {
                "type": "string",
                "description": "Short specialist title, e.g. 'motion designer', 'WebGL engineer', 'accessibility reviewer'.",
            },
            "objective": {
                "type": "string",
                "description": (
                    "One self-contained unit of work: exactly what to build "
                    "or change, with acceptance criteria. Include everything "
                    "the subagent needs — it cannot see this conversation."
                ),
            },
            "file_paths": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Workspace-relative paths the subagent may create or "
                    "modify. Keep scopes disjoint between concurrent "
                    "subagents."
                ),
                "minItems": 1,
            },
            "context": {
                "type": "string",
                "description": "Project context the subagent needs: design language, conventions, integration points.",
            },
            "guidance": {
                "type": "string",
                "description": "Optional specific instructions: approach, pitfalls, style constraints.",
            },
        },
        "required": ["role", "objective", "file_paths"],
    }


def _spawn_agents_schema() -> Dict[str, Any]:
    brief = _spawn_agent_schema()
    return {
        "type": "object",
        "properties": {
            "agents": {
                "type": "array", "minItems": 1, "maxItems": 4,
                "items": brief,
                "description": "A dynamically chosen group of independent specialists. Their file_paths must be disjoint.",
            }
        },
        "required": ["agents"],
    }


def _image_schema() -> Dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "prompts": {
                "type": "array",
                "items": {
                    "type": "string",
                    "description": "Prompt describing a single image to generate.",
                },
            }
        },
        "required": ["prompts"],
    }


def _remove_backgrounds_schema() -> Dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "image_urls": {
                "type": "array",
                "items": {
                    "type": "string",
                    "description": "URL of an image to remove the background from.",
                },
            },
        },
        "required": ["image_urls"],
    }


def _edit_images_schema() -> Dict[str, Any]:
    edit_properties: Dict[str, Any] = {
        "prompt": {
            "type": "string",
            "description": (
                "Clear instruction for this independent edit. Refer to inputs as "
                "image 1, image 2, and so on when multiple images are provided."
            ),
        },
        "image_urls": {
            "type": "array",
            "items": {
                "type": "string",
                "description": "URL of a source or reference image.",
            },
            "description": (
                "Ordered image URLs for this edit: put the main image first, "
                "followed by any reference images."
            ),
        },
        "aspect_ratio": {
            "type": "string",
            "enum": list(P_IMAGE_EDIT_ASPECT_RATIOS),
            "default": "match_input_image",
            "description": (
                "Optional aspect ratio for this edited image. Use match_input_image "
                "to match its main image."
            ),
        },
    }
    return {
        "type": "object",
        "properties": {
            "edits": {
                "type": "array",
                "minItems": 1,
                "items": {
                    "type": "object",
                    "properties": edit_properties,
                    "required": ["prompt", "image_urls"],
                },
                "description": (
                    "Independent image edits to run in parallel. Results are returned "
                    "in this same order."
                ),
            },
        },
        "required": ["edits"],
    }


def _extract_assets_schema() -> Dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "asset_descriptions": {
                "type": "array",
                "items": {
                    "type": "string",
                    "description": (
                        "Identify exactly one visual-asset occurrence. Include its "
                        "distinctive appearance (colors, shape, content, or visible "
                        "wordmark), precise location, nearby UI/context, and the "
                        "1-based screenshot number when multiple screenshots are "
                        "available. For repeated lookalikes, use a separate item for "
                        "each wanted instance and distinguish it (for example, "
                        "leftmost vs. rightmost); do not give only a generic category."
                    ),
                },
            },
        },
        "required": ["asset_descriptions"],
    }


def _screenshot_preview_schema() -> Dict[str, Any]:
    return {
        "type": "object",
        "properties": {},
    }


def _retrieve_option_schema() -> Dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "option_number": {
                "type": "integer",
                "description": "1-based option number to retrieve (Option 1, Option 2, etc.).",
            }
        },
        "required": ["option_number"],
    }


def _ask_user_schema() -> Dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "question": {
                "type": "string",
                "description": (
                    "A specific, decision-focused question. Ask about choices "
                    "that materially change the result and cannot be inferred "
                    "from the brief or references."
                ),
            },
            "options": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Exactly 4 concrete, distinct answer options. The user can also write a custom answer."
                ),
                "minItems": 4,
                "maxItems": 4,
            },
        },
        "required": ["question"],
    }


def canonical_tool_definitions(
    image_generation_enabled: bool = True,
    image_editing_enabled: bool = True,
    asset_extraction_enabled: bool = True,
    screenshot_enabled: bool = True,
    ask_user_enabled: bool = False,
    spawn_agent_enabled: bool = False,
    orchestrator: bool = False,
) -> List[CanonicalToolDefinition]:
    """Build the toolset for a run.

    ``orchestrator=True`` selects the coordinator's toolset: no workspace
    writing or image tools — the coordinator plans, delegates, verifies and
    communicates. Specialists (and every non-orchestrator run) get the full
    implementation toolset.
    """
    spawn_agent_enabled = spawn_agent_enabled or orchestrator
    tools: List[CanonicalToolDefinition] = []
    if not orchestrator:
        tools.extend(
            [
                CanonicalToolDefinition(
                    name="create_file",
                    description=(
                        "Create or fully rewrite a file in the workspace. The entry "
                        "page is index.html; create additional files (styles.css, "
                        "main.js, other pages) as needed and reference them from HTML "
                        "with relative URLs. Returns a success message and file "
                        "metadata."
                    ),
                    parameters=_create_schema(),
                ),
                CanonicalToolDefinition(
                    name="edit_file",
                    description=(
                        "Edit a workspace file using exact string replacements. Do not "
                        "regenerate entire files. Returns a success message plus edit "
                        "details, including a unified diff and first changed line."
                    ),
                    parameters=_edit_schema(),
                ),
            ]
        )
    tools.extend(
        [
            CanonicalToolDefinition(
                name="read_file",
                description=(
                    "Read the full content of a workspace file. Use before editing "
                    "a file you did not just write, and to inspect sibling files."
                ),
                parameters=_read_file_schema(),
            ),
            CanonicalToolDefinition(
                name="list_files",
                description=(
                    "List every file in the workspace with its size. Use to "
                    "understand project structure before editing."
                ),
                parameters=_list_files_schema(),
            ),
        ]
    )
    if image_generation_enabled and not orchestrator:
        tools.append(
            CanonicalToolDefinition(
                name="generate_images",
                description=(
                    "Generate image URLs from prompts using an image generation model. Prompt in detail, and when prompting for people, include details about their appearance such as their ethnicity, hair color, features, etc." +
                    "You can pass multiple prompts at once."
                ),
                parameters=_image_schema(),
            )
        )
    tools.extend(
        [
            CanonicalToolDefinition(
                name="remove_backgrounds",
                description=(
                    "Remove the backgrounds from one or more images in one batch. Returns "
                    "URLs to the processed images with transparent backgrounds in input "
                    "order."
                ),
                parameters=_remove_backgrounds_schema(),
            ),
        ]
    )
    if image_editing_enabled:
        tools.append(
            CanonicalToolDefinition(
                name="edit_images",
                description=(
                    "Edit or upscale one or more images by running independent edits in "
                    "one batch. Each edit has its own prompt, ordered main/reference "
                    "image URLs, and optional aspect ratio. Results are returned in edit "
                    "order."
                ),
                parameters=_edit_images_schema(),
            )
        )
    if asset_extraction_enabled:
        tools.append(
            CanonicalToolDefinition(
                name="extract_assets",
                description=(
                    "Extract one or more tightly cropped visual assets from the input "
                    "screenshots or reference images using Gemini. Describe exactly "
                    "one occurrence per list item with distinctive appearance, precise "
                    "location, nearby context, and the 1-based screenshot number; "
                    "distinguish repeated lookalikes instead of naming a generic asset. "
                    "Returns each asset in request order with a permanent, embeddable "
                    "public_url and an attached crop preview; genuinely absent or "
                    "unisolatable items are unresolved. These assets are already saved "
                    "— do NOT call save_assets on them (save_assets is only for "
                    "user-uploaded images)."
                ),
                parameters=_extract_assets_schema(),
            )
        )
    if screenshot_enabled:
        tools.append(
            CanonicalToolDefinition(
                name="screenshot_preview",
                description=(
                    "Render the current HTML file in a headless browser and return "
                    "full-page desktop and mobile screenshots so you can visually "
                    "verify your work. Use after creating or substantially editing "
                    "the file to check layout, spacing, and fidelity to the "
                    "requested design. Screenshots are returned as attached images."
                ),
                parameters=_screenshot_preview_schema(),
            )
        )
    if ask_user_enabled:
        tools.append(
            CanonicalToolDefinition(
                name="ask_user",
                description=(
                    "Ask the user a clarifying question mid-run. Use it when a "
                    "decision materially changes the result and cannot be "
                    "reasonably inferred from the brief, references, or "
                    "context. Ask at most 1-2 questions per run, early, and "
                    "never about things you can decide yourself. Your run "
                    "pauses until the user answers. You MUST generate exactly four distinct options for every question; the UI also accepts free text."
                ),
                parameters=_ask_user_schema(),
            )
        )
    tools.append(
        CanonicalToolDefinition(
            name="research",
            description=(
                "Fetch a public web page (docs, API references, articles, "
                "libraries) and return its readable text. Use it when a "
                "technique, API, or compatibility detail matters and you are "
                "not certain — do not guess. Returns title + main text, "
                "truncated."
            ),
            parameters=_research_schema(),
        )
    )
    if spawn_agent_enabled:
        tools.append(
            CanonicalToolDefinition(
                name="spawn_agent",
                description=(
                    "Delegate one self-contained unit of work to a specialist "
                    "subagent that runs with its own context and full "
                    "implementation tools. The subagent sees only the files "
                    "you scope to it plus your brief, and returns a summary "
                    "when done. Scopes of concurrent subagents must not "
                    "overlap."
                ),
                parameters=_spawn_agent_schema(),
            )
        )
        tools.append(
            CanonicalToolDefinition(
                name="spawn_agents",
                description=(
                    "Delegate a dynamically selected set of 2-4 independent work units. "
                    "Use when parallel work helps; choose roles and count from the task, never a fixed roster. "
                    "Every specialist must own a disjoint file scope."
                ),
                parameters=_spawn_agents_schema(),
            )
        )
    tools.extend(
        [
            SAVE_ASSETS_TOOL_DEFINITION,
            CanonicalToolDefinition(
                name="retrieve_option",
                description=(
                    "Retrieve the full HTML for a specific option (variant) so you can "
                    "reference it."
                ),
                parameters=_retrieve_option_schema(),
            ),
        ]
    )
    if orchestrator:
        # Coordinators do not write code, produce or edit assets: remove the
        # implementation tools that survived the generic blocks above.
        excluded = {
            "save_assets", "retrieve_option", "remove_backgrounds",
            "edit_images", "extract_assets", "screenshot_preview",
        }
        tools = [tool for tool in tools if tool.name not in excluded]
    return tools
