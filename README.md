# Workshop

Workshop is a fullscreen Loom preset workspace for Lumiverse. It keeps the native Loom block editor authoritative, then adds the spatial context that large presets need: a prompt rail, a variable/dependency inspector, topology diagnostics, and a live assembly preview.

## Requirements

Workshop targets the controlled Loom editor contract shipped with `lumiverse-spindle-types` 0.6.31 and the corresponding Lumiverse staging changes.

## What it does

- Opens from the Loom preset-editor toolbar into a fullscreen, chromeless workspace.
- Uses Lumiverse's native Loom block editor in the center pane; Workshop does not clone prompt editing behavior.
- Lets the left prompt rail control the native editor's selected block.
- Aggregates prompt-variable definitions directly from `PromptBlockDTO.variables`, attributes them to their owning block titles, and scans prompt content for `{{var::...}}` references.
- Shows definition owners, current/default/resolved values, reference counts, and click-through navigation between variable dependencies and prompt blocks.
- Warns about missing variable definitions, duplicate definitions, unused variables, and duplicate block ids.
- Treats native in-progress drafts as ephemeral overlays. Drafts drive the index and preview but never save themselves.
- Commits only the selected edited block against the latest host preset draft, so unrelated host/profile changes are not round-tripped from a stale editor snapshot.
- Uses `spindle.assemble()` for a debounced, cancellable live preview against the active chat without invoking the LLM.
- Supports resolved-message and assembly-stack views, collapsible/resizable desktop rails, a bottom/side preview layout, and mobile overlay drawers.

## Development

```bash
bun install
bun run verify
```

Build output is written to `dist/backend.js` and `dist/frontend.js`.

## State model

Workshop deliberately has only three layers of state:

1. The current Lumiverse preset-editor draft is authoritative.
2. Workshop keeps a detached canonical mirror for navigation/indexing.
3. The native Loom editor may provide one transient selected-block draft through `onDraftChange`; Workshop overlays that one block onto the latest host mirror for preview only.

Only the native editor's committed `onChange` path writes back to Lumiverse. Targeted writes fail closed if the selected block identity is missing or ambiguous.
