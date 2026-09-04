# Migration Status

Living record of the platform migration: what shipped, what changed vs. the
original plan, and where the seams for future work are. Companion to
`target-architecture.md` (the design) and `research-notes.md` (the why).

## Shipped (all committed, 345 backend tests green)

| Phase | Commit | What |
|---|---|---|
| Runtime core | `6ed5cc1` | `agent/runtime/`: typed RunEvents, RunStatus machine, stuck detection, `ask_user` + QuestionGate; AgentEngine → facade |
| Workspace | `45d4d80` | Multi-file `Workspace` with strict paths; `read_file`/`list_files`; previews + finalize render the inline self-contained entry |
| Projects | `c6296a5` | Disk-backed `ProjectStore` (meta/workspace/transcript), `ProjectRunManager` (one run per project, persist-on-finish incl. cancel), project routes + `/ws/projects/{id}` with event replay |
| Studio prompts | `ada740c` | `STUDIO_SYSTEM_PROMPT` (creative direction, anti-slop, engineering standards, ask-user policy), `research` tool, transcript-aware run prompts |
| Studio frontend | `8078e60` | `/studio` route: project rail, conversation + question cards + activity timeline, workspace preview, reconnecting project socket; browser-verified E2E |
| Subagents | `fc35ef1` | `spawn_agent` → scoped subagents (isolated workspace copy, depth-1, no questions), merge-back, orchestrator wiring |
| Cleanup | `be5d4ca` | Dead protocol members, store actions, components, packages removed |

## Where the seams are (next steps, in rough order)

1. **Context compaction** — the event log is structured for it, but long
   project runs still grow unbounded. Adopt keep-first/summarize-middle/
   preserve-recent-tail over `ChatCompletionMessageParam` history at the
   manager level; drop old screenshot/tool images first (they dominate).
2. **Interaction/motion QA in the preview tool** — extend
   `screenshot_preview` with viewport actions (click/type/scroll) and console
   error capture so the agent perceives interactive behavior, not just stills.
3. **Video references** as motion context (upload pipeline exists in the
   variant flow; reuse for studio projects).
4. **Swarm orchestration quality** — spawn_agent exists; teach the orchestrator
   *when* to use it (complexity estimation, `auto` mode), and surface subagent
   progress in the studio UI (events already flow through the runtime).
5. **PROJECT.md/PLAN.md conventions** are prompted but not surfaced in the
   UI; a "decisions" panel reading those artifacts would make direction
   visible and editable.
6. **Checkpoints** — snapshot `workspace/` per run boundary (cheap directory
   copy) to give "restore files, keep conversation" in the studio.
7. **Variant-flow ↔ studio bridge** — "promote this variant to a project"
   endpoint + button.

## Deviations from the original plan (and why)

- **Workspace served over HTTP** (phase 2) shipped as a *project* route in
  phase 3 instead — during runs the workspace lives in memory; serving it
  from the store avoids double-write machinery. The variant flow still uses
  the inline-render path (zero-risk compatibility).
- **Subagent scoping** uses copy-merge isolation rather than per-path locks:
  with 1-page-scale workspaces, copies are trivially cheap and eliminate the
  lock/timeout failure modes entirely. `run_subagents_parallel` exists for
  fan-out, but the current orchestrator tool spawns sequentially-in-turn —
  measured parallelism lands with the swarm-quality work above.
- **Run status** kept `waiting_for_user` but dropped a separate `STUCK`
  terminal status in the transport payload — stuck runs surface as `failed`
  with a "stuck" reason string. (Runtime keeps the distinct enum.)
- The `chunk` protocol member was removed outright (dead on both sides)
  instead of being kept for compatibility — no client ever consumed it.

## Invariants that held

- The variant flow (`/generate-code`) works unchanged; all its tests pass
  untouched except dead-member removal.
- Every phase landed with: full pytest green, pyright clean on touched files
  (no new diagnostics vs. baseline), frontend lint at the documented 25-problem
  baseline, and jest green.
- No API keys or settings formats broke; custom providers keep working.
