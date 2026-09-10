# Workshop

Workshop is a near-fullscreen Loom preset workspace for Lumiverse. It keeps Lumiverse's native Loom editor authoritative while making large presets navigable: prompt/category structure on the left, native editing in the center, variable/dependency context on the right, and a live assembly dry run below or beside the editor.

## Requirements

Workshop targets the controlled Loom editor contract in `lumiverse-spindle-types` 0.6.31 and the corresponding Lumiverse staging implementation.

## 0.2.3 independent pane scrolling

- Bounds the single-prompt native variable sidecar to the actual Loom editor viewport instead of letting large variable collections determine the whole form height.
- Gives the variable sidecar its own vertical scroll while the native Loom scroll container continues to own prompt-form scrolling.
- Recomputes the sidecar height when the editor lane resizes, including Workshop preview resizing and modal viewport changes.
- Restores ordinary stacked/flowing variable behavior below the desktop sidecar breakpoint.

## 0.2.2 fit-and-width pass

- Keeps the collapsed dry-run toolbar fully inside the host modal body instead of letting it fall below the modal viewport.
- Removes Loom's native 800px form cap inside Workshop so single-prompt editing can use the wider Workshop canvas; the variable sidecar inherits the same wider surface.

## 0.2.1 workspace pass

- Keeps the Workshop launcher visible across Loom list/edit remounts and stretches the current preset-toolbar host to a full-width launcher row.
- Gives the prompt and variable rails their own collapse/reopen controls.
- Mirrors Loom category grouping, including category collapse/search behavior. Only category headers get the explicit pencil action; ordinary prompt rows open directly.
- Supports two native Loom prompts side-by-side. Each lane keeps an independent transient draft and commits only its selected block against the latest host draft.
- In single-prompt desktop mode, prompts with variable definitions use the existing native VariablesEditor as a sidecar beside the prompt form. No React-owned nodes are reparented; Workshop only adds layout classes. Opening a second prompt restores the ordinary native below-prompt variable layout.
- Widens the native edit surface and gives the primary prompt textarea substantially more vertical room.
- Makes the dry-run preview resizable: drag height in bottom mode or width in side mode. Hiding a side preview returns it to the bottom toolbar and cancels preview work until shown again.
- Keeps the native expanded text editor available through Loom's existing Expand action. Workshop does not clone or DOM-reparent that React-owned editor because Spindle 0.6.31 does not expose it as a separately mountable host component.

## Existing Workshop behavior

- Opens in a persistent host modal rather than a fullscreen float widget.
- Aggregates prompt-variable definitions from `PromptBlockDTO.variables`, attributes them to owning block titles, and scans prompt content for `{{var::...}}` references.
- Shows owners, defaults/current values, reference counts, and click-through dependency navigation.
- Warns about missing definitions, duplicate definitions, unused variables, and duplicate block IDs.
- Treats native `onDraftChange` values as ephemeral overlays for indexing and preview only.
- Uses `spindle.assemble()` for debounced, cancellable live preview against the active chat without invoking the LLM.
- Offers resolved-message and assembly-stack preview modes.

## State model

Lumiverse remains authoritative. Workshop keeps a detached host mirror, then overlays at most one transient draft per open editor lane for display/preview. Native editor Save is the only path that writes; each commit replaces only its selected block in the newest host draft and fails closed if that identity is missing or ambiguous.

This prevents a stale editor snapshot from overwriting unrelated host/profile changes while one or two prompts are being edited.

## Development

```bash
bun install
bun run verify
```

Build output is written to `dist/frontend.js` and `dist/backend.js`.

## 0.2.1

- Hard-bounds category chevron SVGs to 13px so browser intrinsic SVG sizing cannot overflow the prompt rail.
