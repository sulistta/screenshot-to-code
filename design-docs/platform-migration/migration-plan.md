# Migration Plan

Progressive migration: after every phase the full test suite passes and the
existing product works. Phases are ordered by foundation-first value; each has
explicit validation criteria. Committed phase by phase.

## Phase 0 — Baseline (done)

- Deep audit (see current-architecture.md), OSS research (research-notes.md).
- Baseline: 287 backend tests pass; frontend jest 42 pass; lint has known
  pre-existing errors; pyright scoped baseline recorded (agent/ + generate_code
  route: 8 errors / 25 warnings).
- Custom-provider WIP committed (`4928756`).

## Phase 1 — Runtime core (agent/runtime/)

**Build**: `agent/runtime/` package — typed events, run status enum,
`AgentRuntime` loop extracted from `AgentEngine` (budget, max steps, stuck
detection), `UserInteraction` port + `ask_user` tool with
`AsyncQuestionGate`. `AgentEngine` becomes a facade over the runtime so the
existing WS flow is untouched.

**Validation**: new unit tests for runtime (loop tool sequencing, budget,
stuck detection, ask_user gate with fakes); full pytest + pyright green;
existing generation E2E unchanged.

## Phase 2 — Workspace (multi-file)

**Build**: `agent/workspace.py` (`Workspace`: path→content map, entry point,
write/read/list with path safety); file tools gain multi-file semantics;
workspace served over HTTP (`/workspace/{run_id}/{path}`) so previews support
ES modules and relative assets; `screenshot_preview` renders the entry point
through the same serving path; `list_files`/`read_file` tools.

**Validation**: workspace unit tests (path traversal, seeding); tool runtime
tests for multi-file create/edit; E2E: a multi-file generation renders in the
preview; existing single-file flow unchanged (regression test on
`test_agent_engine.py`).

## Phase 3 — Projects & sessions (durable state)

**Build**: `backend/projects/` — project store on disk
(meta + workspace + PROJECT.md + sessions + run links); routes
`routes/projects.py` (CRUD, message posting, run trigger); WS
`/ws/projects/{id}` streaming runtime events and receiving answers; run
lifecycle management (one active run per project; cancel; status).

**Validation**: store round-trip tests; route tests with faked runtime;
WS test answering an `ask_user` question end-to-end (fake provider session).

## Phase 4 — Studio prompts & research tool

**Build**: studio system prompt (creative direction, anti-slop, engineering
standards, ask-user policy); reference-style input handling (text primary,
image/video as references); `research` tool (fetch public URL → capped
readable text); project memory guidance (PROJECT.md).

**Validation**: prompt-builder tests; research tool tests (httpx fake);
smoke E2E of a text-brief creation run with the new prompt.

## Phase 5 — Studio frontend

**Build**: project list + project view (conversation sidebar with question
cards, run status, agent timeline; workspace preview pane with device
toggles, refresh; link to versions). WS client for the project socket.
Preserve variants flow as-is in the existing surface.

**Validation**: pnpm lint (no new errors in changed files), jest for new
stores/components, manual E2E via dev servers.

## Phase 6 — Subagents (swarm, optional)

**Build**: `spawn_agent` tool — scoped subagents (own provider session,
restricted tools, file scope), summary + artifact references returned;
per-path lock map; `single|swarm|auto` run parameter (auto default).

**Validation**: unit tests with fake provider sessions (scope enforcement,
lock behavior); concurrency smoke test.

## Phase 7 — Cleanup

Remove dead code (`chunk` protocol member, `video/` package, debug writer,
`CodePreview`, `GenerateFromText`, `ImportCodeSection`, `webm recorder`
decision), consolidate duplicated logic, re-run everything.

## Invariants during migration

- Existing WS protocol and variant flow keep working (back-compat facade).
- No API keys or settings formats break (custom providers registry intact).
- Backend tests + pyright (scoped) + frontend lint after every phase.
- The app must run and generate end-to-end at every phase boundary.
