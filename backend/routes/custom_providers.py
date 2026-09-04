"""Connectivity checks for user-registered OpenAI-compatible providers.

The settings UI validates a provider before saving. The backend performs
the request so the browser does not have to deal with CORS on arbitrary
provider URLs: it lists the model catalog when the provider implements
/models and sends a minimal generation call against the configured model.
"""

from typing import List, Literal, Optional

import openai
from fastapi import APIRouter, HTTPException
from openai import AsyncOpenAI
from pydantic import BaseModel

from config import IS_PROD

router = APIRouter()

PROBE_TIMEOUT_SECONDS = 20.0
PROBE_PROMPT = "Reply with the single word: OK."


class CustomProviderTestRequest(BaseModel):
    baseUrl: str
    apiKey: Optional[str] = None
    modelId: Optional[str] = None
    protocol: Literal["chat_completions", "responses"] = "chat_completions"
    headers: Optional[dict[str, str]] = None


class CustomProviderTestResult(BaseModel):
    ok: bool
    error: Optional[str] = None
    detail: Optional[str] = None
    models: List[str] = []


def _summarize_error(exc: Exception) -> str:
    if isinstance(exc, openai.APIStatusError):
        return f"HTTP {exc.status_code}: {getattr(exc, 'message', None) or str(exc)}"
    if isinstance(exc, openai.APIConnectionError):
        cause = str(exc.__cause__) if exc.__cause__ else str(exc)
        return f"Could not reach the provider: {cause}"
    return str(exc) or exc.__class__.__name__


async def _discover_models(client: AsyncOpenAI) -> List[str]:
    """/models is optional for compatible providers; failures are non-fatal."""
    try:
        page = await client.models.list()
        return sorted({model.id for model in page.data if model.id})
    except Exception:
        return []


@router.post(
    "/api/custom-providers/test",
    response_model=CustomProviderTestResult,
)
async def test_custom_provider(
    request: CustomProviderTestRequest,
) -> CustomProviderTestResult:
    if IS_PROD:
        raise HTTPException(status_code=404, detail="Not available")

    base_url = request.baseUrl.strip().rstrip("/")
    if not base_url.startswith(("http://", "https://")):
        return CustomProviderTestResult(
            ok=False,
            error="Base URL must start with http:// or https://.",
        )

    client = AsyncOpenAI(
        api_key=request.apiKey or "not-needed",
        base_url=base_url,
        default_headers=request.headers or None,
        timeout=PROBE_TIMEOUT_SECONDS,
        max_retries=0,
    )
    try:
        models = await _discover_models(client)
        model_id = (request.modelId or "").strip() or (models[0] if models else "")
        if not model_id:
            return CustomProviderTestResult(
                ok=False,
                error=(
                    "The provider did not report any models. Add a Model ID "
                    "manually and test again."
                ),
                models=models,
            )

        if request.protocol == "responses":
            await client.responses.create(
                model=model_id,
                input=[{"role": "user", "content": PROBE_PROMPT}],
                max_output_tokens=16,
            )
            detail = f"POST {base_url}/responses · model {model_id}"
        else:
            try:
                await client.chat.completions.create(
                    model=model_id,
                    messages=[{"role": "user", "content": PROBE_PROMPT}],
                    max_tokens=1,
                )
            except openai.BadRequestError:
                # Reasoning models reject max_tokens; retry without a cap.
                await client.chat.completions.create(
                    model=model_id,
                    messages=[{"role": "user", "content": PROBE_PROMPT}],
                )
            detail = f"POST {base_url}/chat/completions · model {model_id}"

        return CustomProviderTestResult(ok=True, detail=detail, models=models)
    except Exception as exc:
        return CustomProviderTestResult(
            ok=False,
            error=_summarize_error(exc),
            models=[],
        )
    finally:
        await client.close()
