# Screenshot to Code — Desktop Studio

A Tauri v2 desktop application for building durable projects from screenshots
and conversation. React renders the interface in the operating system WebView;
Rust owns projects, provider requests, agent tools, previews and persistence.
The application does not start a Python backend or an HTTP control server.

## Develop

Install Node.js 22+, pnpm 10, Rust stable and the
[Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/).
On Linux this includes WebKitGTK 4.1, GTK 3 and a Secret Service keychain.

```sh
pnpm install
pnpm dev
```

`pnpm dev` starts Vite on `localhost:5173` and opens the native application.
Opening the Vite URL in an ordinary browser does not provide desktop IPC.

Add provider credentials in Settings. OpenAI Responses, Anthropic Messages,
Gemini and custom OpenAI-compatible Chat Completions/Responses endpoints are
supported. Custom HTTP endpoints must be on loopback; remote endpoints use HTTPS.
Keys and custom authorization headers are stored in the operating system
keychain. Other preferences and project data are stored in SQLite under the
platform's application data directory for `com.screenshottocode.studio`.
A locked or unavailable keychain produces a visible error; secrets are never
silently saved to plaintext.

## Build and check

```sh
pnpm check
pnpm test
pnpm build
```

Build installers on their target operating system. Tauri puts them under
`src-tauri/target/release/bundle/`. Signing and notarization require the
platform's signing credentials; they are not embedded in this repository.

For a local executable without an installer:

```sh
pnpm tauri build --debug --no-bundle
```

Linux native integration tests use `tauri-driver`, `WebKitWebDriver` and Xvfb:

```sh
cargo install tauri-driver --locked
pnpm tauri build --debug --no-bundle
xvfb-run -a node scripts/native-smoke.mjs
```

The smoke test uses a real Tauri WebView with an isolated data directory and a
local simulated provider. It does not consume paid provider credentials.

## Projects

- Create, rename, favorite, archive, trash and duplicate projects.
- Edit project files with optimistic revision checks. Every saved change and
  completed generation creates a version; restoring adds a new version.
- Import/export ZIP files using native dialogs, or import a project folder.
- Folder import also converts the previous Studio's `project.json`,
  `workspace/`, `sessions/main.json` and `iterations/*/files/` layout. It creates
  a new project and leaves the source untouched. Browser-stored credentials
  need to be entered in Settings again.
- Save to Git creates local checkpoints inside the app data directory without
  running repository hooks or publishing to a remote.

Agents receive bounded file scopes and can work concurrently when scopes do
not overlap. Runs stream progress through Tauri channels, support questions
and cancellation, and retain recoverable drafts after failures. The team shares
an estimated $3 model budget using the bundled pricing table and a 48-request
limit. A provider request already in flight can exceed the estimate; custom
unpriced models and Replicate are outside the dollar estimate.

Static previews use a dedicated protocol and sandboxed frames. Preview windows
have no Tauri capabilities. The bundled application has a restrictive CSP and
only its main window can invoke project commands. There is no general shell,
filesystem or HTTP plugin permission exposed to the interface.

Generated Node.js projects can install dependencies and start a `dev` or `start`
script on an assigned loopback port. This requires Node.js/npm or pnpm on the
machine. Install scripts are disabled. Linux uses Bubblewrap when the sandbox
probe succeeds; other environments use an isolated HOME and cleared environment,
which is not a filesystem sandbox. Start app executes the generated project's
script with the current user's privileges when Bubblewrap is unavailable.
Processes are stopped when their preview is stopped or the application exits.

Optional Chromium/Google Chrome enables the agent's static HTML screenshot tool.
The runtime also discovers existing Playwright Chromium installations, without
requiring Python or Playwright at runtime. Reference crops are generated in Rust;
Replicate enables generated image assets. Automatic screenshots currently target
static `index.html` projects, not managed application servers.

Developer evaluation dashboards and hosted deployment modes are not part of the
desktop interface. The previous Python source is replaced by Rust; existing
ignored local data is not deleted by the source migration.
