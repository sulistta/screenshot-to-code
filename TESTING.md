# Verification

Run `pnpm check` for frontend lint/type/build checks and warning-free Rust Clippy.
Run `pnpm test` for frontend protocol/store tests and Rust unit tests.
Run the real WebView integration test as described in README.md.

Rust tests cover path traversal, portable archive paths, revision conflicts,
SQLite persistence and event replay, credential redaction, provider stream
assembly, incomplete streams, image crops and preview isolation policy.
The native smoke test verifies commands through the actual Tauri dispatcher,
streaming tool calls against a simulated provider, an interactive question,
completion, cancellation, history, reload and denied preview IPC.

Tests must not use real provider credentials. Network contract tests should use
loopback fixtures. Installer and runtime behavior must be tested on each target
OS; a successful Linux build does not verify macOS or Windows.
