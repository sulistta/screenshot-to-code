# Project Agent Instructions

This is a Tauri v2 desktop application. React/Vite lives in `frontend/` and the
Rust application lives in `src-tauri/`. Do not reintroduce a Python sidecar,
HTTP control API, browser-only fallback, hosted feature flags or Docker deployment.

After code changes:
- `pnpm -C frontend lint`
- `pnpm -C frontend build`
- `pnpm -C frontend test --runInBand`
- `cargo fmt --manifest-path src-tauri/Cargo.toml --check`
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- `cargo test --manifest-path src-tauri/Cargo.toml`

For IPC, security, lifecycle or generation changes, also build the native app
and run `scripts/native-smoke.mjs` through `tauri-driver` (see README.md).

Use explicit commands and typed frontend adapters. Declare custom commands in
`build.rs` and `permissions/studio.toml`. Only the main bundled window receives
project capabilities; preview windows and generated content must never receive
IPC, filesystem, shell or provider credentials.

Use the OS app data directory and keychain. Never log provider keys, headers or
complete HTTP request bodies. Validate project/archive paths for every supported
OS. Persist before publishing terminal events; do not hold state locks over
network requests, dialogs or subprocess waits. Keep generated processes supervised
and clean them up on stop and exit. Preserve existing user data during migrations.

Keep multi-line prompts in dedicated text resources or Rust raw strings.
