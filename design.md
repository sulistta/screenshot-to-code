# Design — Forge

A minimal, adaptive creation studio, not a chat-first interface. The project
starts with a compact direction and references. Its active stage explains the
work, brings decisions into focus and reveals the saved result once available.
Conversation history is secondary and opens on demand. Further changes to the layout
belong to the user, not to incoming events.

## Shared system

- Neutral light/dark surfaces and system sans-serif typography; monospace for code.
- All workspace surface, text, spacing and motion tokens live in `frontend/tokens.css`.
- Use quiet dividers and whitespace. Reserve containers for the composer, result,
  questions and contextual dialogs. No decorative browser frames or metric cards.
- Primary action: one solid send/stop control in the composer. Secondary actions
  use text or compact icon controls with accessible names.

## Information hierarchy

- Sidebar: New Project, project library, Settings.
- Composer: primary model, automatic/selected subagent model, optional ideas,
  request, references, attach and send/stop.
- Result: Preview and Code; version history, reference comparison, ZIP/Git and
  preview window under result options.
- Overview: direction, reference images, current work and decisions.
- History: chronological requests and replies in a separate dialog.
- Details: execution status, agents, activity, changed files and available app logs.
- Settings: Providers (with expandable model catalogue) and Preferences.

## Motion and states

Use opacity/transform at 140–220 ms, without spring overshoot. Animate state
changes, not streamed tokens. Activity breathing reflects actual running work.
Placeholders rotate every six seconds only while empty and unfocused; reduced
motion disables rotation and spatial animation. Focus appears immediately.
Loading, empty, running, waiting, completed, stopped and error states must remain
distinct. No invented percentages or claims of verification.

## Layout

At 1200 px and above, the project overview and result share the workspace. Below that,
show one at a time with explicit controls. The native minimum is 800×600; also
verify narrow component layouts. Keep the composer within reach and preserve
reading position, drafts and editor state while opening panels.
