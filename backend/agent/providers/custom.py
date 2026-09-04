"""User-registered OpenAI-compatible providers.

A custom provider lets generation run against any endpoint speaking the
OpenAI API instead of the built-in integrations. Providers are managed in
the settings UI and sent with every generation request; the request only
ever names the provider it wants to use, so credential ownership stays
with the provider entry.
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional, cast

CUSTOM_PROVIDER_PROTOCOLS: tuple[str, ...] = ("chat_completions", "responses")
CustomProviderProtocol = Literal["chat_completions", "responses"]


@dataclass(frozen=True)
class CustomProvider:
    id: str
    name: str
    base_url: str
    api_key: Optional[str]
    protocol: CustomProviderProtocol
    # Model IDs cycled across variants; each variant renders with
    # models[variant_index % len(models)].
    models: List[str]
    headers: Dict[str, str] = field(default_factory=lambda: dict[str, str]())


def _clean_headers(raw: Any) -> Dict[str, str]:
    headers: Dict[str, str] = {}
    if not isinstance(raw, dict):
        return headers
    for key, value in cast(Dict[Any, Any], raw).items():
        name = str(key).strip()
        text = "" if value is None else str(value).strip()
        if name and text:
            headers[name] = text
    return headers


def parse_custom_provider(raw: Any, fallback_id: str) -> CustomProvider:
    """Validate one provider entry sent by the client. Raises ValueError."""
    if not isinstance(raw, dict):
        raise ValueError("A custom provider entry must be an object.")
    entry_dict = cast(Dict[Any, Any], raw)

    name = str(entry_dict.get("name") or "").strip() or "Custom provider"
    base_url = str(entry_dict.get("baseUrl") or "").strip()
    protocol = str(entry_dict.get("protocol") or "chat_completions")
    api_key_raw = entry_dict.get("apiKey")
    api_key = str(api_key_raw) if api_key_raw else None

    models: List[str] = []
    raw_models = cast(Any, entry_dict.get("models"))
    if isinstance(raw_models, list):
        for entry in cast(List[Any], raw_models):
            if isinstance(entry, dict):
                model_id = str(entry.get("id") or "").strip()
            elif isinstance(entry, str):
                model_id = entry.strip()
            else:
                model_id = ""
            if model_id and model_id not in models:
                models.append(model_id)

    if not base_url.startswith(("http://", "https://")):
        raise ValueError(
            f"Custom provider '{name}' needs a Base URL starting with http:// or https://."
        )
    if protocol not in CUSTOM_PROVIDER_PROTOCOLS:
        raise ValueError(
            f"Custom provider '{name}' uses unsupported protocol '{protocol}'. "
            "Supported protocols: chat_completions, responses."
        )
    if not models:
        raise ValueError(f"Custom provider '{name}' needs at least one model.")

    return CustomProvider(
        id=str(raw.get("id") or fallback_id).strip(),
        name=name,
        base_url=base_url.rstrip("/"),
        api_key=api_key,
        protocol=cast(CustomProviderProtocol, protocol),
        models=models,
        headers=_clean_headers(raw.get("headers")),
    )


def resolve_active_custom_provider(
    raw_providers: Any,
    active_provider_id: Any,
) -> Optional[CustomProvider]:
    """Pick the provider the request should generate with, if any.

    Returns None when no provider was selected (the caller falls back to
    the built-in integrations). Raises ValueError when a provider *was*
    selected but cannot be used, so the user sees why generation failed
    instead of silently switching to built-in keys.
    """
    if not isinstance(raw_providers, list):
        return None
    selected_id = str(active_provider_id or "").strip()
    if not selected_id:
        return None

    raw: Any
    for index, raw in enumerate(cast(List[Any], raw_providers)):
        if not isinstance(raw, dict):
            continue
        if str(raw.get("id") or "").strip() != selected_id:
            continue
        try:
            provider = parse_custom_provider(raw, f"provider-{index}")
        except ValueError as exc:
            raise ValueError(str(exc)) from exc
        if raw.get("enabled") is False:
            raise ValueError(
                f"Custom provider '{provider.name}' is disabled in Settings."
            )
        return provider

    raise ValueError(
        "The selected custom provider is no longer available. Reopen Settings and pick a provider."
    )
