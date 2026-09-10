# Workshop 0.2.2 verification

Workshop targets `lumiverse-spindle-types` 0.6.31.

Validation performed while assembling this archive:

- Strict `tsc --noEmit` passes against a local Spindle type surface patched only with the merged 0.6.31 controlled Loom selection fields.
- Frontend/backend distribution bundles are regenerated from the 0.2.2 source and pass `node --check`.
- Focused source assertions cover launcher remount/full-width behavior, rail-owned collapse controls, bounded/enlarged native editing, dual editors, native variable sidecar behavior, category grouping, draggable dry-run sizing, and hidden-preview cancellation.
- Core Node assertions cover Loom-style category grouping and two simultaneous transient drafts over a newer unrelated host block.
- All shipped text files are normalized to LF.

The artifact sandbox does not provide Bun, so the canonical repository suite still needs to be run locally before publishing:

```bash
bun install
bun run verify
```

The deliberately minimal desynchronization model remains:

```text
host:       A(old)  B(old)  C(fresh external change)
left draft: A(new)
right draft:        B(new)
preview:    A(new)  B(new)  C(fresh external change)
```

Selected blocks disappearing before commit and ambiguous duplicate identities continue to fail closed.

- `frontend-layout-contract.test.ts` now asserts the category-chevron SVG itself is dimension-bounded, preventing intrinsic SVG sizing regressions.

## 0.2.2 focused regressions

- Workshop shell height is fitted to the actual Spindle modal body content box so the collapsed preview toolbar remains visible.
- Native Loom forms are uncapped inside Workshop (`max-width: none`) while the outer Workshop slot still controls the maximum workspace width.
