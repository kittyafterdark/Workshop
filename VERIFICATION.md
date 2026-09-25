# Workshop 0.3.3 verification

Workshop targets `lumiverse-spindle-types` 0.6.31 and the corresponding controlled Loom editor implementation.

Validation performed while assembling this archive:

- Every source/test TypeScript file syntax-transpiles cleanly with TypeScript 5.9.3.
- Focused Node assertions verify nested prompt-variable references such as `{{if::{{var::KL_CRAFT_FOCUS}}::...}}` are counted instead of falsely reported as unused.
- Frontend source contracts cover host-safe fullscreen modal promotion (including `--app-interactive-safe-top` / `--app-interactive-viewport-height`), the compact single topbar, Stack-default dry run, category row navigation with dedicated disclosure carets, the single next-action category bulk control, variable-pane thirds/halves with Show More, readable variable cards, dry-run search/content collapse, dual editors, and native variable sidecar geometry.
- Existing desynchronization, targeted-write, preview cancellation, and category-grouping tests remain in the cumulative source.
- Navigation-draft coverage verifies that primary/secondary prompt switches only guard editor lanes whose transient native drafts would actually be discarded, including the secondary-to-primary promotion case.
- Focused static contracts verify Stack is the initial dry-run tab, category disclosure uses its own caret control, category rows navigate to their Loom blocks, the prompt rail exposes only one next-action Expand/Collapse All control, and split-pane navigation still routes through the unsaved-draft guard.
- Distribution bundles are synchronized with the 0.3.3 source and pass `node --check`.
- All shipped text files use LF repository semantics.

The artifact sandbox does not provide Bun, so run the canonical repository suite locally before publishing:

```bash
bun install
bun run verify
```

## Deliberately deferred

Temporary editing of prompt-variable **values** remains deliberately deferred in 0.3.3. That should use a dedicated ephemeral preview-value layer rather than piggybacking on persisted preset/profile values.
