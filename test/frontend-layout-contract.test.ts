import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/frontend.ts', import.meta.url), 'utf8')

describe('Workshop frontend layout contract', () => {
  test('uses the host modal but promotes its extension-owned modal surface to true fullscreen', () => {
    expect(source).toContain('ctx.ui.showModal({')
    expect(source).not.toContain('ctx.ui.createFloatWidget(')
    expect(source).toContain('function installFullscreenModalChrome(root: HTMLElement): () => void')
    expect(source).toContain("alignItems: 'stretch'")
    expect(source).toContain("justifyContent: 'stretch'")
    expect(source).toContain("top: 'var(--app-interactive-safe-top, 0px)'")
    expect(source).toContain("height: 'var(--app-interactive-viewport-height, calc(100dvh - var(--app-interactive-safe-top, 0px)))'")
    expect(source).toContain("padding: '0'")
    expect(source).toContain("width: '100%', maxWidth: 'none', height: '100%', maxHeight: 'none'")
    expect(source).toContain("hostHeader.style.display = 'none'")
    expect(source).toContain("height: 100%;\n  min-height: 0;")
  })

  test('uses one compact Workshop topbar with centered preset name and status actions', () => {
    expect(source).toContain('grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1fr)')
    expect(source).toContain('<span class="workshop-header-brand">Workshop</span>')
    expect(source).toContain('<span class="workshop-preset-name"></span>')
    expect(source).toContain('class="workshop-header-actions"')
    expect(source).not.toContain('workshop-header-spacer')
  })

  test('keeps the launcher visible, stretches Loom toolbar hosts, and repairs the deferred host-mount race', () => {
    expect(source).toContain('toolbar.setVisible(true)')
    expect(source).toContain("toolbar.root.style.width = '100%'")
    expect(source).toContain("host.style.flex = '1 1 100%'")
    expect(source).toContain("host.style.width = '100%'")
    expect(source).toContain('scheduleToolbarRepair()')
    expect(source).toContain('if (toolbar.root.isConnected)')
    expect(source).toContain('toolbar.setVisible(false)')
    expect(source).toContain('MAX_TOOLBAR_REPAIR_ATTEMPTS = 3')
  })

  test('gives each rail ownership of its own collapse control and uses one next-action category bulk control', () => {
    expect(source).toContain('data-action="left" aria-label="Collapse prompts"')
    expect(source).toContain('data-action="right" aria-label="Collapse variables"')
    expect(source).toContain('data-action="toggle-categories"')
    expect(source).toContain("allCategoriesCollapsed ? 'Expand all categories' : 'Collapse all categories'")
    expect(source).toContain('for (const id of categoryIds) collapsedCategories.add(id)')
  })

  test('bounds and enlarges the native Loom editor without stealing its scroll area', () => {
    expect(source).toContain('.workshop-editor-region { grid-column: 1; grid-row: 1; min-width: 0; min-height: 0; overflow: hidden;')
    expect(source).toContain('.workshop-primary-textarea')
    expect(source).toContain('min-height: clamp(360px, 48vh, 720px)')
    expect(source).toContain('width: min(100%, 1500px)')
    expect(source).toContain('.workshop-native-form { width: 100% !important; max-width: none !important; margin-inline: 0 !important; }')
  })

  test('supports dual native Loom editors and restores variables beneath in dual mode', () => {
    expect(source).toContain('data-role="secondary-editor-mount"')
    expect(source).toContain('ctx.components.mountLoomBlockEditor(secondaryEditorMount')
    expect(source).toContain('void requestSecondaryBlock(block.id === secondaryBlockId ? null : block.id)')
    expect(source).toContain('&& !secondaryBlockId')
    expect(source).toContain('decorateNativeMount(secondaryEditorMount, false)')
  })

  test('uses the native variable editor as a single-prompt sidecar without reparenting it', () => {
    expect(source).toContain("form.classList.add('workshop-variable-sidecar')")
    expect(source).toContain("child.classList.add(child === variableRoot ? 'workshop-native-variable-root' : 'workshop-native-main-field')")
    expect(source).not.toContain('appendChild(variableRoot)')
    expect(source).not.toContain('append(variableRoot)')
  })

  test('bounds the variable sidecar without manufacturing empty native-scroll rows', () => {
    expect(source).toContain('max-height: var(--wk-native-pane-height, calc(100dvh - 220px))')
    expect(source).toContain('overflow-y: auto')
    expect(source).toContain('scrollbar-gutter: stable')
    expect(source).toContain('grid-auto-rows: max-content')
    expect(source).toContain('Math.min(scroll.clientHeight, mount.clientHeight || scroll.clientHeight)')
    expect(source).toContain("form.style.setProperty('--wk-native-pane-height'")
    expect(source).toContain('variableRoot.style.gridRow = `1 / span ${Math.max(1, mainFields.length)}`')
    expect(source).not.toContain('grid-row: 1 / span 99')
    expect(source).toContain('new ResizeObserver(scheduleNativeDecoration)')
  })

  test('preserves prompt and variable-pane scroll state through rerenders and prompt selection', () => {
    expect(source).toContain('const previousScrollTop = promptList.scrollTop')
    expect(source).toContain('promptList.scrollTop = Math.min(previousScrollTop')
    expect(source).toContain('const variablePaneScroll = new Map<string, number>()')
    expect(source).toContain("variablePaneScroll.set(body.dataset.variablePaneBody ?? '', body.scrollTop)")
    expect(source).toContain('function preserveHostScrollThroughSelection(work: () => void): void')
    expect(source).toContain('preserveHostScrollThroughSelection(() => {')
  })


  test('guards prompt navigation when native Loom drafts are unsaved', () => {
    expect(source).toContain('async function confirmDraftDiscard(slots: readonly WorkshopEditorSlot[]): Promise<boolean>')
    expect(source).toContain("title: 'Discard unsaved prompt edits?'")
    expect(source).toContain("confirmLabel: 'Discard changes'")
    expect(source).toContain('async function requestSelectedBlock(blockId: string | null): Promise<void>')
    expect(source).toContain('async function requestSecondaryBlock(blockId: string | null): Promise<void>')
    expect(source).toContain("draftSlotsDiscardedBySelection({")
    expect(source).toContain("}, 'primary', blockId)")
    expect(source).toContain("}, 'secondary', blockId)")
    expect(source).toContain("row.addEventListener('click', () => { void requestSelectedBlock(block.id) })")
    expect(source).toContain("split.addEventListener('click', () => { void requestSecondaryBlock(block.id === secondaryBlockId ? null : block.id) })")
  })

  test('renders real Loom categories with separate disclosure controls and full-row block navigation', () => {
    expect(source).toContain('for (const group of computePromptGroups(value.blocks))')
    expect(source).toContain('collapsedCategories.has(category.id)')
    expect(source).toContain("'workshop-category-toggle'")
    expect(source).toContain("row.addEventListener('click', () => { void requestSelectedBlock(category.id) })")
    expect(source).not.toContain('Edit category ${category.name')
  })

  test('hard-bounds category chevron SVGs so intrinsic SVG sizing cannot blow out the prompt rail', () => {
    expect(source).toContain('.workshop-category-chevron { width: 13px; height: 13px;')
    expect(source).toContain('.workshop-category-chevron svg { width: 13px; height: 13px; display: block; max-width: 13px; max-height: 13px; }')
  })

  test('splits variable context into reduced detail/all/diagnostic panes with show-more expansion', () => {
    expect(source).toContain('.workshop-variable-workspace { min-height: 0; display: grid; grid-template-rows: repeat(2, minmax(0, 1fr))')
    expect(source).toContain('.workshop-variable-workspace.has-selection { grid-template-rows: repeat(3, minmax(0, 1fr)); }')
    expect(source).toContain("id: 'detail' | 'all' | 'diagnostics'")
    expect(source).toContain("toggle.textContent = expandedVariablePane === id ? 'Show sections' : 'Show more'")
    expect(source).toContain("makePane('all', 'All variables'")
    expect(source).toContain("makePane('diagnostics', 'Diagnostics'")
  })

  test('makes variable cards more scannable with label, reference count, macro, and owner hierarchy', () => {
    expect(source).toContain('workshop-variable-card-head')
    expect(source).toContain('workshop-variable-refcount')
    expect(source).toContain('workshop-variable-macro')
    expect(source).toContain('`Defined in ${primary.blockName}`')
  })

  test('defaults dry-run preview to Stack while keeping Resolved available', () => {
    expect(source).toContain("let previewTab: 'resolved' | 'stack' = 'stack'")
    expect(source).toContain('data-preview-tab="resolved">Resolved</button>')
    expect(source).toContain('data-preview-tab="stack" class="active">Stack</button>')
  })

  test('makes dry-run preview draggable, searchable, and content-collapsible', () => {
    expect(source).toContain('data-resize="preview"')
    expect(source).toContain('data-role="preview-search"')
    expect(source).toContain('data-action="preview-entries-collapse"')
    expect(source).toContain('previewQuery = previewSearch.value')
    expect(source).toContain("previewElement.classList.toggle('entries-collapsed', previewEntriesCollapsed)")
    expect(source).toContain("root.style.setProperty('--wk-preview-width'")
    expect(source).toContain("root.style.setProperty('--wk-preview-height'")
  })

  test('collapsing a side preview returns it to the bottom toolbar and stops assembly work', () => {
    expect(source).toContain('.workshop-shell.preview-split:not(.preview-collapsed) .workshop-center')
    expect(source).toContain('.workshop-shell.preview-collapsed .workshop-center')
    expect(source).toContain('if (destroyed || previewCollapsed) return')
    expect(source).toContain("type: 'workshop:cancel-preview'")
    expect(source).toContain('schedulePreview(true)')
  })
})
