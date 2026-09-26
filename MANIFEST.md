# Lumiverse Workshop v0.3.4 — Source Manifest

Cumulative editable source package. This patch replaces the flaky registered-toolbar launcher bridge with Loom's canonical persistent `preset_editor_toolbar` mount point, eliminating the base-editor registration race while retaining the 0.3.3 prompt-navigation polish and 0.3.2 unsaved-draft guard.

## Files

- `.gitignore`
- `README.md`
- `VERIFICATION.md`
- `bun.lock`
- `dist/backend.js`
- `dist/frontend.js`
- `package.json`
- `scripts/build.mjs`
- `spindle.json`
- `src/backend-core.ts`
- `src/backend.ts`
- `src/frontend.ts`
- `src/shared.ts`
- `src/workshop-core.ts`
- `test/backend-core.test.ts`
- `test/frontend-layout-contract.test.ts`
- `test/pipeline-mock.test.ts`
- `test/workshop-core.test.ts`
- `tsconfig.json`

## Text/EOL policy

All shipped text files use LF repository semantics. No CRLF-normalized copies are included.
