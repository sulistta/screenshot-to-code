# Migration Status

Living record of the platform migration. Companion to
`target-architecture.md` (design), `research-notes.md` (why), and
`migration-plan.md` (phasing).

## Pass 1 — foundation (commits `bf0e51a`…`be5d4ca`)

Built `agent/runtime/` (typed events, status machine, stuck detection,
ask_user gate), the multi-file Workspace, the durable project layer
(store, run manager, routes, project socket), the studio system prompt
with creative direction, scoped subagents, and the first Studio
frontend. The legacy variant flow remained alongside.

## Pass 2 — product correction (commits `b4199e7`…)

This pass made the product coherent per the second migration brief:

1. **Four-generation behavior removed completely.** The `/generate-code`
   WS pipeline, its middleware, the App.tsx orchestration with the
   commit/variant graph, the variants grid, select-and-edit, the screen
   recorder, and the screenshot-by-URL proxy are deleted — backend and
   frontend (~12k lines). One prompt creates ONE project; iteration
   happens in the conversation. The studio is the application root.
2. **Project lifecycle.** Project → conversation → execution (run) →
   tasks/agents → workspace changes → validation (preview/screenshot) →
   iteration (checkpoint) → next execution. Iterations are created only
   by COMPLETED runs — a checkpoint means validated state, not every
   file write.
3. **Primary + subagent model selection.** Chosen per project in the
   run-config bar; resolved at execution start and snapshotted into the
   run record; explicit-but-unavailable models fail loudly (no silent
   fallback). Custom providers expose their individual model ids as
   `custom:<model-id>` values that pin the exact model on both the
   orchestrator and every spawned subagent.
4. **Execution modes.** SINGLE removes the spawn tool from the run
   entirely; AUTO leaves the decision to the orchestrator; SWARM
   injects a decomposition-encouraging directive. All three verified
   against a scripted provider.
5. **Workflow UX.** Composer with reference-image attachments (picker,
   paste), human phase feedback derived from tool activity ("Writing
   the project", "Reviewing the result visually"), completed/failed/
   stopped handoff cards, iterations bar linking historical snapshots,
   categorized error messages, quiet visual language, product identity
   ("Studio") replacing screenshot-to-code branding in user surfaces.

## Dogfood verification (scripted OpenAI-compatible provider)

A scripted provider (`fake-main`/`fake-sub`/`fake-swarm`/`fake-hang`)
exercised the real stack end to end: text-only creation, question flow
with structured options and answer routing, iteration creation with
change summaries, reload recovery (event replay + question persistence
in the ring buffer), stop/cancel (idempotent; UI and backend converge),
swarm delegation with merge-back. Model routing was verified from the
provider's request log: primary and subagent requests carried the
pinned models. Live LLM runs remain untested in this environment (no
real keys — `.env` placeholders); the first real generation is the one
remaining check.

## Data migration

Historical four-variant data lived only in browser memory (the old
product had no persistence), so there is nothing to migrate; the old
UI's disappearance retires it by construction. Persisted studio data
(projects under `~/.screenshot-to-code/projects/`) predates nothing —
its schema already carries the new fields (`config`, iterations) with
backwards-compatible defaults. Eval data and run logs are untouched.

## Next seams

- Context compaction for long project runs.
- Interactive preview QA (click/scroll/console capture) in the browser
  tool; video references as motion context.
- Select-and-edit (click an element to scope an edit) — the old UX had
  it; the studio needs it re-expressed on the workspace preview.
- PLAN.md-driven plan display (the prompt asks for the artifact; the UI
  can render it as the user-visible plan checklist).
- Subagent progress in the studio UI (runtime events already flow).
