# Workshop 0.2.0 source manifest

This archive is the complete cumulative Workshop source tree, not an installer and not an overlay against Lumiverse core.

## Runtime surface

- `src/frontend.ts` — host-modal workspace, persistent full-width launcher, prompt/category rail, dual native Loom editors, single-prompt native variable sidecar, resizers, host synchronization, diagnostics, and dry-run rendering.
- `src/backend.ts` — Spindle backend entrypoint.
- `src/backend-core.ts` — cancellable per-user assembly coordinator.
- `src/shared.ts` — frontend/backend message contracts and guards.
- `src/workshop-core.ts` — variable parser/index, Loom-style prompt grouping, fail-closed block patching, and one-/two-draft overlay helpers.

## Verification surface

- `test/workshop-core.test.ts` — parsing/attribution, diagnostics, grouping, value resolution, fail-closed writes, and dual-draft composition.
- `test/pipeline-mock.test.ts` — minimal host/draft pipeline mock proving two transient editor drafts preserve a newer unrelated host block.
- `test/backend-core.test.ts` — preview cancellation, stale-result suppression, errors, and per-user cleanup.
- `test/frontend-layout-contract.test.ts` — modal/launcher, owned rail controls, enlarged native editor, dual-editor, variable-sidecar, category, resizable-preview, and hidden-preview contracts.
- `scripts/build.mjs` — canonical Bun bundler.
- `tsconfig.json` — strict source typecheck.

## Distribution surface

- `dist/frontend.js`
- `dist/backend.js`
- `spindle.json`
- `package.json`
- `README.md`

## Packaging rules

- `node_modules/` is not shipped.
- Source and generated distribution files use LF.
- The archive contains the full editable Workshop surface so it can be reviewed or modified without an apply/install script.
