# Visual Studio roadmap

## Agreed direction

Local visual studio, English UI, light/dark/system themes. Explicit Reproduce
and Create modes. Static HTML plus React/FastAPI and Next.js full-stack templates
in the same full-stack release. Linux first; no Docker. Native sandbox required
for executing generated applications. SQLite by default; configured PostgreSQL.
CRUD, login, basic permissions and uploads. Complete export and local Git.

## Delivery sequence

1. Reliability: atomic workspace publication, immutable iteration files,
   correct content diffs, visible persistence failures, cancellation, event
   correlation and correct relative preview URLs. ✅ (delivered in earlier
   batches, see below)
2. Modular foundation: typed versioned contracts, transactional metadata,
   durable events, revision manifests, verified migration and recovery. ✅ core
3. Visual workspace: project routes, onboarding, responsive panels, preview,
   editor, history and static export. ⚠️ partial (workbench, library, history,
   team panel; onboarding and resizable panels pending)
4. Native full-stack: supervisor, mandatory sandbox, isolated preview gateway,
   both templates and both database profiles. ⚠️ core delivered (supervisor,
   gateway, templates, manifest detection; sandbox wiring for generated apps
   and PostgreSQL profile pending)
5. Visual editing and quality: reference comparison, element selection, tokens,
   assets, URL/video inputs and verified correction loops. ⚠️ partial
6. Portability: local Git, import/export, backups, accessibility and performance.
   ⚠️ partial (ZIP export/import, git checkpoints)

## Current implementation — delivered in this batch

Reliability and agent foundations:

- Orchestrator architecture (execution modes removed): the project always
  runs as a coordinator + specialist team. The coordinator's model does NOT
  write code — it plans, delegates (spawn_agent/spawn_agents), verifies and
  integrates. Enforcement is layered: an orchestrator toolset without
  writing/asset tools (read/list/research/ask_user/delegation only), a
  structural guard in the tool runtime that refuses write calls even if a
  model insists, and the studio system prompt describing the split.
  The `auto/single/swarm` execution-mode setting is gone end to end
  (backend config, routes, store, UI, run records).
- Shared run budget: coordinator and every specialist spend from one
  `SharedBudget` pool (`agent/budget.py`); the runtime ceiling checks the pool
  total, so N subagents no longer each receive a full budget.
- Durable agent identity: every run persists an `AgentRun` record
  (`projects/agents.py`) — stable agent id, short human name (Nora ·
  Coordinator; Theo/Maya/Iris… · role), explicit states (queued, working,
  verifying, completed, failed, cancelled), objective, files produced,
  timestamps, summary and error. Restart recovery marks orphaned active
  agents as cancelled.
- Team protocol on the wire: `agent_status` lifecycle events and
  specialist-attributed tool events (`agentId`, `name`, `role`) replace the
  old lossy `swarm_agent` ping; the coordinator's reply no longer mixes
  specialist chatter. Frontend store keeps a `team` map and renders a Team
  panel (identity, state, current action, files, results).
- Draft vs. last validated version: failed/cancelled runs no longer publish
  partial files to the live workspace. Partial output goes to a per-run draft
  (`drafts/<run_id>`), recoverable via `POST /api/v1/projects/{id}/drafts/{run_id}/restore`.
  Only completed runs publish the workspace and create an iteration.
- Workspace GC: unreferenced snapshot generations are collected after each
  publish (keeps pointer + 2 most recent); event journal pruned to the newest
  1000 events per project, deleted with the project.
- Durable replay: `attach_sink` replays from the SQLite journal, not memory;
  reconnects after a backend restart still receive full run history.
- Edit concurrency: per-project edit lock serializes check-revision +
  publish in manual file writes and restores (`routes/studio.py`).
- Cascade cancellation: the run's cancel scope terminates queued specialists;
  agent records persist their final state.

Full-stack execution groundwork:

- Project manifest (`projects/manifest.py`): template, entry, services with
  commands/ports/health paths, required env var names, data paths excluded
  from code snapshots. Detection from workspace files (static-html default;
  Next.js and React/Vite promoted by package.json).
- Service supervisor (`projects/supervisor.py`): installs dependencies from
  lockfiles (no model secrets present), spawns services, pumps bounded logs,
  probes health, detects crashes, frees everything on stop/shutdown.
- Preview gateway (`routes/preview.py`): `/api/projects/{id}/app/...` proxies
  the project's running service on its own origin; control plane stays on
  separate paths; service status/start/stop endpoints.
- Versioned templates (`projects/templates.py`): React/Vite + FastAPI (with
  CRUD, login, permissions and uploads against SQLite) and Next.js, tested
  for import validity and manifest detection.

## Remaining constraints

- Generated full-stack apps do not yet run inside the native sandbox by
  default; the supervisor currently spawns processes directly. Wiring
  `NativeSandbox` into the supervisor's spawn path is the next reliability
  step (env allow-list, tmpfs writes, cgroup limits).
- PostgreSQL profile, Alembic migrations for the studio database, and
  migration of legacy document tables into normalized tables are pending.
- Team history is preserved per run but the UI team panel currently shows
  the latest run's team; run-scoped team fetch from
  `GET /api/v1/projects/{id}/runs/{run_id}/agents` is available for the
  history view.
- Verification loops (build, health, browser errors, journeys) are not yet
  part of generation; the supervisor's health probe is the first building
  block.
- Frontend still needs: onboarding checks, resizable panels, run-scoped team
  history view, and the remaining responsive/a11y passes.

## Audit pass (repository-wide)

- Dead weight removed: unused backend dependencies (moviepy, langfuse,
  keyring, alembic, aiohttp, pre-commit — lockfile shrank by ~2k lines),
  eleven unused shadcn wrappers (accordion, tabs, select… kept only the
  seven actually mounted), unused frontend packages (html2canvas, nanoid,
  react-dropzone, puppeteer, vitest duplicate, thememirror, classnames,
  copy-to-clipboard, webm-duration-fix and friends) and the broken
  `test:qa` script pointing at a deleted file. `model_choice_sets.py` was
  pruned to the single constant the code uses.
- Journal hot path: the event journal now keeps one persistent SQLite
  connection instead of opening a connection (plus WAL/PRAGMA setup) per
  streamed event, including every assistant delta.
- Supervisor hardening: re-entry guard on `start()` prevents double
  install/spawn from rapid calls; double `stop()` is idempotent. Verified
  with a real HTTP service end-to-end.
- Error surfaces: studio API failures now extract the server's actionable
  `detail` (string or validation array) instead of showing generic
  messages, so a 409 like "Stop the active run before deleting" reaches
  the user.
- Full-stack preview wired into the workbench: package.json-bearing
  projects get Start/Stop app controls and render through the project
  gateway when running, with installing/crashed states surfaced.

## Verification

Backend: 368 tests passing (`poetry run pytest`); pyright holds the
pre-existing baseline (21 errors / 68 warnings) — every file touched in this
batch is clean of new diagnostics. Frontend: 12 store tests, lint and build
clean.
