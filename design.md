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
- Agents: an inline right panel with parallel conversations, execution status, changed files and available app logs.
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

### Live thinking and parallel agents
Provider-published reasoning streams in the main creation stage as an upward teleprompter. The center keeps full text width; the edges contract and fade. Pause holds the text for reading, and reduced motion removes smooth scrolling and distortion. No synthetic reasoning is generated when the provider sends none.
Project details live in the right workspace panel, alongside Result. Agents can be filtered independently; reasoning, messages, actions, changed files, run history and runtime logs stay within this panel. Both result and agent views remain mounted when switching. Activity retains its run and agent identity.
Provider configuration requests supported thinking summaries with `reasoning.summary: auto` for reasoning-enabled Responses models and `includeThoughts: true` for configured Gemini thinking models. References: [OpenAI reasoning summaries](https://developers.openai.com/api/docs/guides/reasoning) and [Gemini thinking summaries](https://ai.google.dev/gemini-api/docs/generate-content/thinking).
The teleprompter retains every reasoning block for the active run, including blocks separated by tool calls and agent changes. Text deltas accumulate independently of transport event IDs. A single animation clock advances the reading position; new deltas extend the destination without replacing previous lines or restarting scrolling.
Thinking uses the full stage width and left-aligned reading lines. Line wrapping measures the current font against the viewport width and recalculates on resize; transport fragments never create visual line breaks. Consecutive reasoning fragments from the same agent flow together, while actual newlines and agent changes remain visible.

### Streaming performance
Project IPC commands execute off the native main thread via Tauri's async command dispatch. Existing Channels carry text batches at 50 ms intervals, with ordered flushes and retained partial text on cancellation. React subscribes to selected store fields; hidden agent panels do not render history or poll logs. The teleprompter caches wrapped lines, measures only new text, and renders at most 14 rows with fixed line geometry. Its animation stops when caught up, paused or hidden. Full activity remains in the store and replay.
Validation includes a 2,000-fragment native stream, frame interval sampling, a 5,000-line DOM bound and ordering/cancellation tests. Tauri guidance: https://v2.tauri.app/develop/calling-rust/#async-commands and https://v2.tauri.app/develop/calling-frontend/#channels.
