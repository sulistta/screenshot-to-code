# Research Notes: Mature Agent Architectures

Findings from studying open-source coding agents (source-level, 2026-09) and
what this project adopts or rejects. Full comparisons live in the migration
PR description; here we record only decisions that shape the code.

## Sources examined

OpenCode (sst/opencode → anomalyco/opencode), Aider, OpenHands
(software-agent-sdk), Cline, Roo Code, pi (badlogic/pi-mono), Claude Code
(docs), Gemini CLI, upstream abi/screenshot-to-code.

## Adopted

1. **Run status machine** (OpenHands `ConversationExecutionStatus`,
   OpenCode run-state): a run is RUNNING / WAITING_FOR_USER / COMPLETED /
   FAILED / CANCELLED / STUCK. One runner per run; concurrent prompts are
   rejected, not queued silently. → `agent/runtime/statuses.py`.
2. **Mid-run questions as a tool that parks the loop** (OpenCode `question`
   tool + reply API; Roo `ask_followup_question`): the loop blocks on a
   future; the user's answer becomes the tool result. → `ask_user` +
   `AsyncQuestionGate`.
3. **Stuck detection** (Gemini CLI loopDetectionService, OpenHands
   StuckDetector): nudge once on repeated identical tool calls, then fail as
   STUCK instead of burning budget. → `runtime/loop.py`.
4. **Compaction principles** (OpenHands condenser, Cline/Roo context
   management, Gemini CLI split points): trigger near a token fraction of the
   window; keep the first exchanges + recent tail verbatim; never split
   tool-call/result pairs; stale tool outputs (esp. screenshots) are the first
   thing dropped. Not implemented in phase 1 — the single-page loop rarely
   exceeds windows — but the event log is designed so compaction can be added
   as a view over history.
5. **Subagent isolation by scoped file ownership, not locks** (Claude Code
   worktrees; AutoGen/CrewAI avoid shared writes structurally): parallel
   workers get disjoint scopes; an in-process per-path lock map covers shared
   resources. Worktrees rejected (single-page workspace, no git repo inside).
6. **Orchestrator→worker briefs** (Anthropic multi-agent research post):
   objective + output format + tool guidance + boundaries in; summary +
   artifact references out.
7. **Aider's reflection cap**: failed edits reflect back to the model with a
   bounded retry count (≤3) — matches our existing `edit_file` error flow.
8. **Event-log discipline** (OpenHands event sourcing, pi JSONL tree, Gemini
   CLI typed event union): one append-only typed event stream feeds the WS,
   the recorder, and future recovery/eval. We formalize the existing ad-hoc
   `send_message` calls into `runtime/events.py`.

## Rejected (with reasons)

- **Docker runtime per run** (OpenHands): our artifact is static web content;
  a headless browser + workspace dir is the whole runtime. Cost/complexity
  unjustified.
- **Shadow-git checkpoints** (Cline): workspace snapshots are plain directory
  copies at run boundaries; sufficient and simpler.
- **Repo maps** (Aider): the workspace is generated, small, and known.
- **Vercel-AI-SDK-style full server framework** (OpenCode): FastAPI + one WS
  per project already covers our needs; adopting Effect/HTTP-API frameworks
  adds layers without product value.
- **Plan/Act hard mode split** (Cline/Roo): planning is prompted and artifact-
  based instead of a tool-restricted mode; avoids a second UX surface.
- **Vector-database memory**: PROJECT.md + session transcripts cover the
  memory needs; retrieval problems don't exist at this scale.

## Upstream alignment

Upstream abi/screenshot-to-code already converged on the same loop shape
(30-step tool loop, screenshot_preview self-critique, budget ceiling, run
recorder, variant isolation). This migration generalizes those foundations
rather than replacing them: the riskiest parts (provider sessions, loop
correctness, visual capture) are battle-tested upstream code we keep.
