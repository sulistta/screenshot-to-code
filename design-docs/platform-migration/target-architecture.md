# Target Architecture

The product evolves from "screenshot-to-code" into an agentic studio for
creating sophisticated web experiences. This document defines the target
architecture and the concepts that replace the one-shot generation model.

Naming: the runtime package is `backend/agent/runtime/`; the durable project
layer is `backend/projects/`; the conversational UX surface is the **Studio**.
The existing single-shot flow keeps working unchanged throughout the migration.

## Core concepts

```
Project (durable, on disk)
├── meta: id, name, objective/brief, created/updated
├── workspace/            ← the real files the agent writes
│   └── index.html, styles.css, main.js, assets/...
├── PROJECT.md            ← project memory the agent maintains
├── sessions/<id>/        ← conversation transcripts (user ↔ agent)
└── runs/<run_id>/        ← per-run event logs (reuse AgentRunRecorder)
```

- **Project** — the durable unit. Owns the workspace (multi-file), the brief,
  the conversation history, and project memory. Lives on disk under
  `DATA_DIR/projects/<project_id>/`; survives restarts.
- **Session** — one conversation thread within a project. The transcript is
  user/assistant messages, not raw provider messages.
- **Run** — one agent execution triggered by a user message (or by the
  orchestrator). A run has a status, an append-only event log, and produces
  workspace changes + a reply.
- **Workspace** — a multi-file virtual project directory. The preview renders
  the workspace over HTTP (real ES modules, CDNs, multi-file assets), replacing
  the single-`srcdoc` assumption.
- **Run status machine** — `RUNNING / WAITING_FOR_USER / COMPLETED / FAILED /
  CANCELLED / STUCK`. Waiting-for-user is a first-class state, not an exception.

## Agent runtime (`backend/agent/runtime/`)

Extracted from `engine.py` into composable pieces; `AgentEngine` remains as a
compatibility facade.

- `events.py` — typed, versioned run events (the WS protocol formalized):
  assistant/thinking deltas, tool start/result, set_code, status, question,
  phase. The event log is append-only; the WS, the recorder, and (later)
  recovery all consume the same stream.
- `statuses.py` — the run status enum above.
- `loop.py` — `AgentRuntime`: the tool-calling loop (stream turn → execute
  tools → append results → repeat) with:
  - budget ceiling (existing) and max steps (existing);
  - **stuck detection** — same tool + near-identical args × 3 → inject a nudge;
    × 5 → fail the run as STUCK (Gemini-CLI-style loop detection);
  - **question handling** — an `ask_user` tool call parks the run in
    `WAITING_FOR_USER` and awaits an answer through a `UserInteraction` port;
  - cancellation by status transition (cooperative checks between steps).
- `interaction.py` — `UserInteraction` port + `AsyncQuestionGate`
  (asyncio.Future-based). WS transport answers questions; tests use fakes.

## Tools v2

Keep every existing tool. Add, in `backend/agent/tools/`:

- `ask_user(question, options?, context?)` — mid-run clarification. The tool
  result IS the user's answer. Allowed only for run modes that support it
  (single-agent runs; disabled for best-of-N variant batches).
- `list_files` / `read_file` — workspace awareness for multi-file projects.
- `run_command` — shell in the project workspace dir: timeout, output cap,
  cwd pinned inside the workspace, no secrets in env, no interactive TTY.
  Used for build tooling / npm-less verification; documented as trusted-user
  feature (OSS local), not a sandbox.
- `research` — fetch a public URL, return readable text (title + main text,
  size-capped) so the agent can consult real docs/references instead of
  guessing. (Search-engine integration deliberately deferred.)
- Browser interaction upgrades to `screenshot_preview` (kept name for
  continuity): viewport actions (click/type/scroll/hover), console errors,
  navigation — the perception loop for interactive experiences.

File tools (`create_file`/`edit_file`) gain multi-file semantics over the
workspace while remaining fully backward-compatible with single-file runs
(`path` defaults to the entry point).

## Orchestrator & swarm

The default is a **single primary agent** per run. The optional multi-agent
model is dynamic, not a fixed roster:

- The primary agent may call `spawn_agent(role, brief, scope)` — a subagent
  with its own provider session, its own context, a restricted tool set, and a
  **file-scope** (subdirectory or explicit file list) it owns. It returns a
  summary + artifact references, never full payloads.
- Concurrency safety is structural: scoped file ownership first, plus an
  in-process per-path lock map (OpenHands-style) for shared resources. Git
  worktrees are out of scope for single-page workspaces.
- A run parameter selects `single | swarm | auto`; `auto` (default) leaves the
  decision to the orchestrator. Subagent count is bounded; depth 1 (no
  sub-subagents) initially.

## Model/provider layer

Unchanged: `ProviderSession` + adapters (OpenAI chat/responses, Anthropic,
Gemini, custom OpenAI-compatible). Provider choice per run comes from user
settings/model selection, not from hardcoded model mixes (the eval-derived
mixes remain as defaults for the variant flow).

## Prompt evolution (`backend/prompts/`)

- New studio system prompt: creative direction (concept, visual language,
  composition, motion intent, anti-slop rules), engineering standards
  (cleanup of listeners/GL resources, accessibility, responsive), and the
  ask-user policy (ask when a decision materially changes the result; never
  interrogate).
- Planning is prompt-driven: for complex briefs the agent writes
  `PLAN.md`/`PROJECT.md` artifacts in the workspace (real files, visible to
  the user) instead of a hardcoded planning phase. Planning depth scales with
  the brief, enforced by prompt guidance, not workflow code.
- Input generalization: image/video inputs become **references** with the same
  standing as text; `create/text.py` becomes the primary builder and image/
  video builders become reference-injection helpers.

## Transport & protocol

- Existing `/generate-code` WS stays byte-compatible for the variant flow.
- New project flow: HTTP for project CRUD + `POST /projects/{id}/messages`
  (returns run id), WS `/ws/projects/{id}` for streaming run events and
  receiving user replies to `ask_user`. Event names start from the typed
  runtime events (superset of the current protocol).

## Frontend evolution

- The Studio view: project list → project view with a conversation sidebar
  (chat + question cards + run status) and the existing preview pane
  (workspace-served URL with device toggles).
- The commit/variant graph, history, select-and-edit, and best-of-N stay —
  variants remain the "explore N directions" tool.
- Current App.tsx logic is progressively extracted into the studio surface
  rather than rewritten wholesale.

## Non-goals (explicit)

- No vector database, no LangChain/heavy frameworks, no microservices, no
  Docker-runtime sandbox, no generic IDE. File+SQLite+JSONL persistence is
  sufficient for the foreseeable horizon.
- No always-on swarm; no fixed agent roster.
- The hosted SaaS (`hosted` branch) integration is out of scope here.
