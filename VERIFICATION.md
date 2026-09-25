# Workshop 0.3.1 verification

Workshop targets `lumiverse-spindle-types` 0.6.31 and the corresponding controlled Loom editor implementation.

Validation performed while assembling this archive:

- Strict `tsc --noEmit` passes against the local Spindle type surface with the merged 0.6.31 controlled Loom selection fields.
- Every source/test TypeScript file syntax-transpiles cleanly with TypeScript 5.8.
- Focused Node assertions verify nested prompt-variable references such as `{{if::{{var::KL_CRAFT_FOCUS}}::...}}` are counted instead of falsely reported as unused.
- Frontend source contracts cover host-safe fullscreen modal promotion (including `--app-interactive-safe-top` / `--app-interactive-viewport-height`), the compact single topbar, prompt Expand All / Collapse All, variable-pane thirds/halves with Show More, readable variable cards, dry-run search/content collapse, dual editors, and native variable sidecar geometry.
- Existing desynchronization, targeted-write, preview cancellation, and category-grouping tests remain in the cumulative source.
- Distribution bundles are synchronized with the 0.3.1 source and pass `node --check`.
- All shipped text files use LF repository semantics.

The artifact sandbox does not provide Bun, so run the canonical repository suite locally before publishing:

```bash
bun install
bun run verify
```

## Deliberately deferred

Temporary editing of prompt-variable **values** is not included in 0.3.0. That should use a dedicated ephemeral preview-value layer rather than piggybacking on persisted preset/profile values.
