# Workshop 0.2.5 verification

Workshop targets `lumiverse-spindle-types` 0.6.31.

Validation performed while assembling this archive:

- Strict `tsc --noEmit` passes against a local Spindle type surface patched only with the merged 0.6.31 controlled Loom selection fields.
- Frontend/backend distribution bundles are synchronized with the 0.2.5 source changes and pass `node --check`.
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

## 0.2.3 focused regression

- The single-prompt variable sidecar receives a measured `--wk-native-pane-height` capped to the smaller of the current native Loom scroll viewport and the Workshop editor mount viewport.
- Variable-heavy blocks use an independent sidecar scrollbar instead of forcing the prompt form to match the full variable collection height.
- A `ResizeObserver` refreshes the measured pane height when Workshop geometry changes.
- Below the desktop sidecar breakpoint, the variable editor returns to normal document flow with no independent height cap.
## 0.2.4 focused regressions

- The launcher has a bounded deferred-mount repair: while the preset editor is open, a disconnected toolbar root is toggled through one real hidden/visible remount and retried at most three times. This gives Lumiverse's paint-phase host insertion effect another mount without a permanent observer loop.
- Sidecar grid rows now span exactly the current native main-form child count. The previous `span 99` created empty implicit grid rows and inherited 16px row gaps, explaining the large blank scroll tail in variable-heavy single-block mode.
- Decoration cleanup removes the inline `grid-row` when sidecar mode exits, so dual-prompt/stacked layouts return to untouched native flow.


## 0.2.5 focused regression

- `renderPrompts()` and `renderVariables()` capture and restore their own scroll offsets around `replaceChildren()` rebuilds, preventing long rails from snapping to the top during selection-driven rerenders.
- Primary and secondary prompt selection capture scrollable host-modal ancestors before native editor updates and restore them immediately and across two animation frames. This covers delayed native focus/layout work without reusing the previous prompt's internal editor scroll offset.
- The focused frontend layout contract asserts both rail preservation and host-scroll preservation hooks are present.
