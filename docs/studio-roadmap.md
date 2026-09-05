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
   correlation and correct relative preview URLs.
2. Modular foundation: typed versioned contracts, transactional metadata,
   durable events, revision manifests, verified migration and recovery.
3. Visual workspace: project routes, onboarding, responsive panels, preview,
   editor, history and static export.
4. Native full-stack: supervisor, mandatory sandbox, isolated preview gateway,
   both templates and both database profiles.
5. Visual editing and quality: reference comparison, element selection, tokens,
   assets, URL/video inputs and verified correction loops.
6. Portability: local Git, import/export, backups, accessibility and performance.

## Current implementation — reliability groundwork

Implemented, pending final review:

- Workspace generations written before atomically updating workspace-state.json.
- Legacy workspace directories remain readable and are retained on first save.
- Binary assets that cannot be decoded as UTF-8 survive workspace saves.
- Version files staged separately from metadata and published by rename.
- JSON records written with atomic replacement and fsync.
- Existing-file edits and removals included in run diffs.
- Persistence failures reported as failed runs, with actionable messages.
- Immediate cancellation finalizes the run; repeated cancellation is ignored.
- Broken live event consumers cannot fail generation.
- Stream sequence deduplication, project guards and tool-call correlation.
- Canonical preview entry URLs preserve relative stylesheet/script paths.
- Image-only submission, visible user messages and stale-fetch protection.
- Pyright excludes the local virtualenv rather than analyzing installed packages.

## Remaining constraints

This is the first implementation slice, not completion of the roadmap.
Events still use an in-memory buffer; durable replay and restart recovery are
pending. Snapshot generations are retained without garbage collection, increasing
disk usage. Cancellation still publishes partial files as in the existing product;
separate draft and last-valid revisions are pending. Native execution isolation,
preview origin isolation, new UI and full-stack templates are not implemented.

## Verification

The previous implementation batch passed 327 backend tests and frontend lint,
TypeScript and 5 frontend tests. Additional cancellation, persistence failure,
event replay, tool correlation and stale-fetch tests are now included.
Final results are reported in the task response. Pyright has existing repository
diagnostics; no clean global baseline is claimed. Its final rerun was blocked by
automatic approval review reporting the account usage limit.
