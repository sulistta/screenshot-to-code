# Studio experience inventory and decisions

## Discovery

Traced routes/projects.py → ProjectRunManager → AgentRuntime → specialist runtime,
the durable journal/WebSocket replay, project store/service, frontend store and all
Studio components. Inspected the running app before edits. Evaluation routes are a
separate developer tool, retained under Settings → Advanced.

## Capability inventory

| Capability / user / frequency | Authoritative source and current behavior | New placement / decision |
|---|---|---|
| Create / everyone / each project | POST projects then POST runs; name and brief are separate today | One brief composer creates a named project and begins work; failed starts retain the brief |
| Text, URLs / everyone / every run | text sent to prompt pipeline; research tool can inspect URLs | One multiline composer, URLs naturally in text |
| Image references / creators / occasional | images array, up to five in existing UI | Shared paste/drop/file input, preview/removal, explicit limits |
| Video/general files / some / occasional | Studio RunRequest supports images only; older prompt pipeline supports video elsewhere | Do not advertise unsupported attachments; ZIP import retained in project tools |
| Conversation / everyone / every run | persisted transcript plus assistant_delta | Semantic brief/response journal, no chat bubbles; expandable in result phase |
| Models / advanced creators / occasional | project primary/subagent model PATCH; snapshotted per run | Compact configuration disclosure; next-run choices distinguished from active config |
| Providers / owners / setup | local persisted settings; built-in keys; custom endpoint/protocol/headers/models/test | Settings, password fields, no secrets in workspace or diagnostics |
| AUTO/SINGLE/SWARM / advanced | No selectable mode contract in current repository. Coordinator always delegates; may spawn one or parallel specialists | Honest “Adaptive team” policy, explain automatic team sizing; no fake mode controls |
| Planning / creators / substantial runs | PLAN.md via specialist, no typed phase or task graph | Show actual saved plan in project source; team objectives show real current work; never invented stages |
| Active work / everyone / every run | run_status, tool_start/result, agent_status | One concise status, real outstanding actions, expandable work detail |
| Clarification / everyone / when needed | question event with question ID and options; HTTP answer acknowledges delivery | Prominent in-flow decision area; await server response; only one choice + free text supported |
| Specialists / advanced / when delegated | agent_status and attributed tools; durable agents endpoint | Quiet objective list, statuses as text; names/files/details disclosed |
| Private thinking / nobody | thinking_delta currently shown in ActivityItem | Removed from presentation and client accumulation |
| Preview / everyone / every result | saved workspace published on completion; failed/cancelled output is a draft | Result dominates; keep saved frame during work; explicit update/failed/stopped labels |
| Runnable apps / creators / as needed | supervisor state installing/running/stopped/crashed | Contextual start/stop and real service error; poll running status for crash visibility |
| Responsive review / creators / frequent | iframe width, refresh, open in new tab | Desktop/tablet/mobile named choices, focus mode |
| Targeted refinement / creators / frequent | inspector postMessage with selector/text | Select element, then focus composer with contextual instruction |
| Compare reference / creators / occasional | transcript images; side-by-side or opacity overlay | Review view, meaningful empty state if no reference |
| Versions / creators / each completion | list_iterations; immutable preview; restore creates new revision | Versions view; “View saved version” distinct from “Restore as new version” |
| Manual files / developers / occasional | revision-checked file PUT, CodeMirror drafts | Source under inspect; explicit unsaved state and conflict error |
| Import/export/Git / developers / occasional | ZIP importer/exporter, checkpoint endpoint | Project tools disclosure; ZIP export accessible |
| Errors/retry / everyone / when failed | actionable API detail, terminal error, draftAvailable | Inline recovery; retry last instruction; technical detail separate |
| Stop / everyone / long work | cancel endpoint; final cancelled status; draft restore | Visible text stop action, acknowledgement while stopping |
| Reload/reconnect / everyone / interruption | cursor/streamId journal replay; transcript fetch merges live messages | Connection status, replay survives navigation; questions cleared by matching tool result |
| Library / everyone / project switching | metadata + options; rename/favorite/archive/trash/duplicate | Searchable dialog with meaningful collection states; reversible trash |
| Theme / everyone / rare | light/dark/system persisted | Settings → Appearance, coherent tokens |
| Evals / developers / rare | eight existing /evals routes, reports/timelines/compare | Settings → Advanced; preserve workflows |

## Information architecture

Primary: brief → work journal → result → refinement. Secondary: library, versions,
reference comparison, configuration. Transient: question, element selection, error,
connection status. Advanced: source, tool outcomes, team implementation detail,
import/Git, evaluation routes. No permanent project rail or chat column.

## State and truth rules

Empty: one brief. Running without result: journal and real team work. Question:
attention block independent of journal disclosure. Result while running: previous
saved result explicitly marked as such. Completed: saved version and actual summary,
no automatic validation claim. Failed/stopped: saved result retained; retry and
recoverable draft only when server says available. Reconnection: no fabricated
stage; unknown remains unknown. Historical preview is an immutable separate view.
A tool start never means that the tool succeeded. Plan labels never come from a
fixed creative checklist. No percentages, estimated time, costs, or fake fixtures.

## QA ledger

Verified in the running app: text-only creation and retained failed brief; image
attachment and Ctrl/Cmd+Enter submission; library navigation; model configuration
disclosure; result preview at desktop/tablet/mobile frame widths; saved-version
viewing; light and dark themes; no horizontal overflow at 320, 375, 414, 768,
and 1280px; ZIP import through the production project endpoint. The test instance
had no configured model provider, so a real agent run, clarification, swarm, stop,
reload-during-run, and recovery-draft UI could not be observed end-to-end. Their
views are backed by the existing typed event and persistence contracts and have
store-level regression coverage. Unsupported flows must be recorded as unsupported,
never passed using fabricated runtime events.
