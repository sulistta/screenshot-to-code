# Design — Studio

## Product and structure
A creative work surface for making and refining web experiences. The user's work
is the visual center. App macrostructure: adaptive Workbench. Start with a brief;
show a focused journal during initial work; expand into the result with a compact
refinement dock. Project navigation lives in a library, not a persistent sidebar.
No decorative assets. Evaluation routes are advanced tools, not primary navigation.

## Visual system
Modern minimal, warm mineral surfaces, graphite ink, restrained green interaction
accent. Light/dark/system themes. Tokens in tokens.css, imported by Studio CSS.
Display: Georgia roman for the initial creative invitation only. Body: system
sans-serif. Monospace: source and technical detail only. Body 14px, metadata 12px,
display clamp(32px,4vw,56px). Four-point spacing. Subtle 4px controls; semantic
surfaces use rules and alignment rather than nested rounded cards.

## Motion
One 180ms opacity/6px entrance for a new phase or expanded journal. 120ms opacity
feedback. No token/event animations, pulsing dots, moving gradients, or bounce.
Reduced motion removes spatial movement. Focus rings appear immediately.

## Behavior
Ctrl/Cmd+Enter submits; Enter inserts a newline. Drafting remains possible during
work, submission waits. Questions stay visible even when the journal is closed.
Use authoritative events and acknowledged answers. Show saved preview while a
new run works; never claim that browser load means visual validation passed.
At narrow widths, shorten controls and use a full-width dock/journal; keep the
preview scrollable at chosen test width. Settings and library use focus-managed
Radix dialogs; ordinary work remains inline. All actions have text or labels.

## Exports
Canonical CSS tokens: ../../tokens.css from docs, or ./tokens.css at repository root.
Tailwind/shadcn compatibility remains through the existing semantic HSL variables;
new Studio components consume the OKLCH tokens directly. The repository uses
Tailwind v3, so no v4 @theme directive is injected into production CSS.
