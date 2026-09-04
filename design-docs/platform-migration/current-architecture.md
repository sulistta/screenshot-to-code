# Current Architecture (audit baseline, 2026-09)

This document describes the repository as it stands today, after the upstream
`abi/screenshot-to-code` evolution (agent loop, variants, evals) plus local work
(custom OpenAI-compatible providers). It is the reference for what is kept,
transformed, or removed during the platform migration.

## The product today

A single-shot generation product: the user provides input (screenshot(s), video,
or text) plus optional edit history; the backend runs N parallel agent variants
that each produce one single-file HTML app; the user picks a variant, then
iterates by chatting (ai_edit commits) or selecting elements in the preview.

There is no persistent project, no mid-run user interaction, no multi-file
workspace, and no planning: each WebSocket connection carries exactly one
generation request from params to completion.

## Backend map

### Entry point and transport
- `backend/main.py` — FastAPI app; mounts all routers; probes Playwright at startup.
- `backend/routes/generate_code.py` — the whole generation flow as a middleware
  pipeline (`WebSocketSetup → ParameterExtraction → StatusBroadcast →
  PromptCreation → CodeGeneration → PostProcessing`) over one WS endpoint
  (`/generate-code`). Message protocol (outgoing):
  `chunk` (dead), `status`, `setCode`, `error`, `variantComplete`,
  `variantError`, `variantCount`, `variantModels`, `thinking`, `assistant`,
  `toolStart`, `toolResult`. The frontend receives params once, then only sends
  nothing (no mid-run reads). Close codes: 4332 app error, 4333 user cancel.
- `backend/ws/constants.py` — the app-error close code.

### Agent core (good, keep)
- `backend/agent/engine.py` — `AgentEngine`: the real tool-calling loop
  (`_run_with_session`, max 30 steps): stream a turn → execute tool calls →
  append results → repeat. Handles streamed code previews, budget ceiling
  (`GENERATION_MAX_COST_USD`), empty-output detection (`EmptyOutputError`),
  run recording, and client-disconnect-safe finalization.
- `backend/agent/runner.py` — `Agent`, a thin alias over `AgentEngine`.
- `backend/agent/state.py` — `AgentFileState` (single file: `path` + `content`)
  and seeding from prior conversation messages.
- `backend/agent/providers/` — `ProviderSession` protocol (`stream_turn`,
  `append_tool_results`, `total_cost_usd`, `close`) with adapters for OpenAI
  (chat + responses), Anthropic, Gemini, and user-registered OpenAI-compatible
  endpoints (`custom.py`). This layer is clean, provider-agnostic, and is kept
  as the model interface.

### Tools (keep, generalize)
- `backend/agent/tools/definitions.py` — canonical tool schemas:
  `create_file`, `edit_file`, `generate_images`, `remove_backgrounds`,
  `edit_images`, `extract_assets`, `screenshot_preview`, `save_assets`,
  `retrieve_option`.
- `backend/agent/tools/runtime.py` — `AgentToolRuntime` dispatches to
  implementations; file tools operate on the single `AgentFileState`.
- `backend/agent/tools/screenshot_preview.py` — renders current HTML in
  headless Chromium (desktop + mobile full-page) and returns screenshots as
  multimodal parts. This is the existing generate → render → see → fix loop.
- `backend/agent/tools/extract_assets.py` — Gemini-based cropping of visual
  assets out of input screenshots (screenshot-coupled by nature).
- `backend/preview_screenshot/` — Playwright backend behind a
  `ScreenshotBackend` protocol; shared browser, page-per-capture.

### Prompts
- `backend/prompts/` — pipeline (`pipeline.py` → `plan.py` strategies:
  create_from_input / update_from_history / update_from_file_snapshot),
  `system_prompt.py` (single-file HTML agent; stack snippets; screenshot
  replication language), `create/image.py` (screenshot-coupled),
  `create/text.py` (generic), `create/video.py`, `update/*` (generic),
  `design_system.py`, `policies.py` (all reusable).

### Support layers (keep as-is)
- `costs/` — pricing + token usage (leaf, decoupled).
- `fs_logging/` — `AgentRunRecorder`: per-run `events.jsonl`, `run.json`,
  final HTML, assets; SQLite index (`runs`, `llm_calls`, eval sessions).
  Runs are inspectable at `/agent-runs` in the frontend.
- `uploaded_assets/` — content-addressed asset store (temp → promoted), the
  `save_assets` tool, and prompt decorations for asset IDs.
- `image_generation/` — Replicate image gen/edit/background-removal.
- `routes/design_systems.py` (persisted JSON store), `routes/export.py`
  (asset-inlining ZIP export with SSRF guard), `routes/screenshot.py`
  (ScreenshotOne URL capture — input feature only), `routes/custom_providers.py`
  (provider connection testing), `routes/model_choice_sets.py` (eval-derived
  model mixes per key availability), evals (`routes/evals.py`,
  `routes/eval_sets.py`, `evals/` — judged model comparison infrastructure).

### Persistence reality
Nothing user-facing survives a process restart: no project store, no session
store. Only logs (`run_logs/`), eval data, design systems JSON, and promoted
local assets persist. The commit/variant graph lives entirely in the browser.

## Frontend map

- `src/App.tsx` (~1000 lines) orchestrates everything; state in two zustand
  stores:
  - `store/project-store.ts` — the generation graph: commits
    (`ai_create`/`ai_edit`/`code_create`), per-commit `variants[]` (each with
    `code`, per-variant conversation `history`, `agentEvents` timeline,
    `status`), asset registry (`assetsById`), execution consoles. This is an
    in-memory git-graph of AI generations; not persisted.
  - `store/app-store.ts` — app shell state (INITIAL/CODING/CODE_READY, select-
    and-edit mode).
- `src/generateCode.ts` — WS client; one connection per generation; resolves
  asset IDs into data URLs at send time.
- `components/preview/PreviewComponent.tsx` — sandboxed iframe, `srcdoc`
  updated via throttled `setCode`; desktop/mobile viewports; select-and-edit
  via capture-phase click interception + hover overlays.
- `components/agent/AgentActivity.tsx` — per-variant timeline of
  thinking/assistant/tool events.
- `components/history/` — version history with branching.
- Settings with custom provider registry (`components/settings/`,
  `lib/providers.ts`); evals pages under `components/evals/`.
- Styling: Tailwind 3 + shadcn/radix; CodeMirror 6 editor (read-only today).

## Strengths worth preserving

1. The provider session abstraction — small protocol, four adapters, streaming
   + cost accounting. This is the model layer for the new platform.
2. The tool-calling loop with budget ceiling, empty-output retry semantics,
   and disconnect-safe run recording.
3. The visual feedback loop (`screenshot_preview` as a multimodal tool result).
4. The variant system — parallel generation with per-variant state isolation;
   the natural seed for later multi-agent work.
5. The commit/variant graph on the frontend — versioning UX already exists.
6. Run recording (events.jsonl + SQLite) — observability and eval reuse.
7. Design systems, export, asset store — real product features, generic.

## Coupling to "screenshot" and one-shot generation

- `AgentFileState` is one HTML file; preview/export/protocol (`setCode`)
  all assume a single document.
- The WS endpoint is one request → one generation → close; no session can
  outlive a socket, and the socket never reads after params, so the agent
  cannot ask the user anything mid-run.
- Prompt construction is organized around input modes (image/video/text) that
  all funnel into "reproduce this" style prompts; there is no brief → concept →
  plan → build ladder.
- No planning artifacts, no project memory, no task decomposition.
- `variantModels`/model mixes are keyed by which API keys are present.
- `extract_assets` and `routes/screenshot.py` exist solely for screenshot input.
