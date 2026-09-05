# Design — Screenshot to Code Studio

A restrained visual workspace in English. Preview is dominant; project navigation
and conversation support it. App pages share semantic Tailwind/shadcn tokens from
frontend/src/index.css. Preserve existing evaluation routes.

System sans-serif typography; monospace only for source and diffs. Roman headings,
14px body, 12px secondary copy. Four-pixel spacing scale. Neutral surfaces, subtle
green accent, light/dark/system themes. No decorative motion. Focus is immediate.

Desktop: project rail, conversation, flexible preview. Below 1024px: one panel at
a time with Projects/Chat/Preview navigation. All actions have accessible labels;
loading, error and empty states are explicit. Long files and generated previews
may scroll inside their panels; the Studio itself must not overflow horizontally.
