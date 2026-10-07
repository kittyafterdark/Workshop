# Workshop 0.4.0 verification

- `bun run verify`: typecheck, 47 unit tests, and synchronized distribution build.
- Issue-review core tests cover ordered per-prompt issues, duplicate identities, local multi-prompt fixes, caller isolation, atomic Apply, original-baseline conflicts, and reverting a fix.
- `scripts/check-issue-review.mjs` uses the real distribution bundle with a minimal controlled native-editor/Spindle structure on desktop/mobile: draft navigation, local Save, close/reopen, batch Apply, unrelated host changes, conflicting edits, Cancel, discard, modal teardown and footer containment.
- The controlled editor fixture is not a substitute for live Loom mounting; live checks must exercise the actual editor without applying changes to personal presets.

# Workshop 0.3.9 verification

- `bun run verify`: typecheck, 43 unit tests, and synchronized distribution build.
- Desktop/mobile browser fixture verifies full-width values beneath the name/reset header, slider numbers beside their tracks, and stable control positions across edits/reset. Existing keyboard and write-isolation checks remain covered.

# Workshop 0.3.8 verification

- `bun run verify`: typecheck, 43 unit tests, and synchronized distribution build.
- Desktop/mobile browser fixture verifies switch semantics, Space toggling, and unchanged switch, value-label, and slider positions when overrides activate. Existing editing/reset/isolation checks remain covered.

# Workshop 0.3.7 verification

- `bun run verify`: typecheck, 43 unit tests, and synchronized distribution build.
- Controlled browser checks at desktop/mobile widths cover direct editing of all seven variable types, multiple owner groups in preset order, keyboard collapse, search expansion/restoration, empty results, form/map switching without duplicate controls, fresh host updates, reset, and close/reopen isolation.

# Workshop 0.3.6 verification

- Browser regression fixture uses a translucent rail theme and checks both mobile rails have a solid base beneath the theme tint. Desktop and mobile sandbox interaction checks remain covered.
- Live theme inspection confirmed `--lumiverse-bg-dark` resolves to `rgba(0, 0, 0, 0.15)`, explaining the mobile bleed-through.

# Workshop 0.3.5 verification

- `bun run verify`: full typecheck, unit tests, and distribution build.
- `test/variable-sandbox.test.ts`: immutable preview overlays, array isolation, reset to fresh host values, empty/zero values, invalid inputs, and stale/ambiguous definition handling.
- `scripts/check-variable-sandbox.mjs`: real Workshop distribution bundle with controlled Spindle/native-editor boundaries and assembly responses. Uses Playwright from the Lumiverse diagnostics tooling or another existing installation via `PLAYWRIGHT_MODULE`. Runs desktop (1440px) and mobile (390px) checks for all seven variable types, keyboard focus/selection, reset, host refresh, definition changes, close/reopen, and isolation from preset writes/native editor values.
- The browser fixture does not exercise live Lumiverse assembly or the extension updater. Verify those by updating Workshop from Lumi's Extensions tab and changing mock values against an active chat.

# Historical 0.3.4 verification

Workshop targets `lumiverse-spindle-types` 0.6.31 and the corresponding controlled Loom editor implementation.

Validation performed while assembling this archive:

- Every source/test TypeScript file passes a no-emit/no-check syntax parse in the artifact sandbox; full repository type validation remains part of the canonical local `bun run verify`.
- Focused Node assertions verify nested prompt-variable references such as `{{if::{{var::KL_CRAFT_FOCUS}}::...}}` are counted instead of falsely reported as unused.
- Frontend source contracts cover host-safe fullscreen modal promotion (including `--app-interactive-safe-top` / `--app-interactive-viewport-height`), the compact single topbar, Stack-default dry run, category row navigation with dedicated disclosure carets, the single next-action category bulk control, variable-pane thirds/halves with Show More, readable variable cards, dry-run search/content collapse, dual editors, and native variable sidecar geometry.
- Launcher contracts verify Workshop uses the canonical persistent `preset_editor_toolbar` mount point and no longer contains the registered-toolbar deferred-paint repair loop.
- Existing desynchronization, targeted-write, preview cancellation, and category-grouping tests remain in the cumulative source.
- Navigation-draft coverage verifies that primary/secondary prompt switches only guard editor lanes whose transient native drafts would actually be discarded, including the secondary-to-primary promotion case.
- Focused static contracts verify Stack is the initial dry-run tab, category disclosure uses its own caret control, category rows navigate to their Loom blocks, the prompt rail exposes only one next-action Expand/Collapse All control, and split-pane navigation still routes through the unsaved-draft guard.
- Distribution bundles are synchronized with the 0.3.4 source and pass `node --check`.
- All shipped text files use LF repository semantics.

The artifact sandbox does not provide Bun, so run the canonical repository suite locally before publishing:

```bash
bun install
bun run verify
```

## Deferred in 0.3.4 (implemented in 0.3.5)

Temporary editing of prompt-variable **values** remains deliberately deferred in 0.3.4. That should use a dedicated ephemeral preview-value layer rather than piggybacking on persisted preset/profile values.
