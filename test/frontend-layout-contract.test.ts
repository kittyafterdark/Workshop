import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/frontend.ts', import.meta.url), 'utf8')

describe('Workshop frontend layout contract', () => {
  test('uses the host modal rather than a fullscreen float widget', () => {
    expect(source).toContain('ctx.ui.showModal({')
    expect(source).not.toContain('ctx.ui.createFloatWidget(')
    expect(source).not.toContain("tooltip: 'Workshop'")
  })

  test('keeps the launcher visible and stretches each Loom toolbar host', () => {
    expect(source).toContain('toolbar.setVisible(true)')
    expect(source).toContain("toolbar.root.style.width = '100%'")
    expect(source).toContain("host.style.flex = '1 1 100%'")
    expect(source).toContain("host.style.width = '100%'")
    expect(source).toContain('new MutationObserver(fitToolbarHost)')
  })

  test('gives each rail ownership of its own collapse control', () => {
    expect(source).toContain('data-action="left" aria-label="Collapse prompts"')
    expect(source).toContain('data-action="right" aria-label="Collapse variables"')
    expect(source).toContain("root.classList.toggle('left-collapsed')")
    expect(source).toContain("root.classList.toggle('right-collapsed')")
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
    expect(source).toContain("ctx.components.mountLoomBlockEditor(secondaryEditorMount")
    expect(source).toContain("setSecondaryBlock(block.id === secondaryBlockId ? null : block.id)")
    expect(source).toContain('&& !secondaryBlockId')
    expect(source).toContain('decorateNativeMount(secondaryEditorMount, false)')
  })

  test('uses the native variable editor as a single-prompt sidecar without reparenting it', () => {
    expect(source).toContain("form.classList.add('workshop-variable-sidecar')")
    expect(source).toContain("child.classList.add(child === variableRoot ? 'workshop-native-variable-root' : 'workshop-native-main-field')")
    expect(source).not.toContain('appendChild(variableRoot)')
    expect(source).not.toContain('append(variableRoot)')
  })

  test('bounds the variable sidecar to the live native editor viewport and lets it scroll independently', () => {
    expect(source).toContain('max-height: var(--wk-native-pane-height, calc(100dvh - 220px))')
    expect(source).toContain('overflow-y: auto')
    expect(source).toContain('scrollbar-gutter: stable')
    expect(source).toContain('Math.min(scroll.clientHeight, mount.clientHeight || scroll.clientHeight)')
    expect(source).toContain("form.style.setProperty('--wk-native-pane-height'")
    expect(source).toContain('new ResizeObserver(scheduleNativeDecoration)')
  })

  test('renders real Loom categories and reserves edit actions for category headers', () => {
    expect(source).toContain('for (const group of computePromptGroups(value.blocks))')
    expect(source).toContain('collapsedCategories.has(category.id)')
    expect(source).toContain("const edit = button('workshop-mini-button', `Edit category ${category.name || ''}`.trim(), ICONS.pencil)")
  })

  test('hard-bounds category chevron SVGs so intrinsic SVG sizing cannot blow out the prompt rail', () => {
    expect(source).toContain('.workshop-category-chevron { width: 13px; height: 13px;')
    expect(source).toContain('.workshop-category-chevron svg { width: 13px; height: 13px; display: block; max-width: 13px; max-height: 13px; }')
  })

  test('makes dry-run preview size draggable in bottom and side layouts', () => {
    expect(source).toContain('data-resize="preview"')
    expect(source).toContain("root.style.setProperty('--wk-preview-width'")
    expect(source).toContain("root.style.setProperty('--wk-preview-height'")
    expect(source).toContain('previewSplit && window.innerWidth > MOBILE_BREAKPOINT')
  })

  test('collapsing a side preview returns it to the bottom toolbar and stops assembly work', () => {
    expect(source).toContain('.workshop-shell.preview-split:not(.preview-collapsed) .workshop-center')
    expect(source).toContain('.workshop-shell.preview-collapsed .workshop-center')
    expect(source).toContain('if (destroyed || previewCollapsed) return')
    expect(source).toContain("type: 'workshop:cancel-preview'")
    expect(source).toContain('schedulePreview(true)')
  })

  test('fits the Workshop shell to the host modal body so the collapsed preview bar stays visible', () => {
    expect(source).toContain('height: calc(100dvh - 120px)')
    expect(source).toContain('function fitWorkshopHeightToModalBody(): void')
    expect(source).toContain('body.clientHeight - paddingTop - paddingBottom')
    expect(source).toContain('requestAnimationFrame(fitWorkshopHeightToModalBody)')
  })
})
