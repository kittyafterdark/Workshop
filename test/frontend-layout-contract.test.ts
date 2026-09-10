import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/frontend.ts', import.meta.url), 'utf8')

describe('Workshop frontend layout contract', () => {
  test('uses the host modal rather than a fullscreen float widget', () => {
    expect(source).toContain('ctx.ui.showModal({')
    expect(source).not.toContain('ctx.ui.createFloatWidget(')
    expect(source).not.toContain("tooltip: 'Workshop'")
  })

  test('bounds the native Loom editor so its own scroll area can scroll', () => {
    expect(source).toContain('.workshop-editor-frame > [data-role="editor-mount"]')
    expect(source).toContain('height: 100%;\n  min-height: 0;')
    expect(source).toContain('.workshop-editor-region {\n  min-width: 0;\n  min-height: 0;\n  overflow: hidden;')
  })

  test('collapsing a side preview returns it to the bottom-bar layout', () => {
    expect(source).toContain('.workshop-shell.preview-split:not(.preview-collapsed) .workshop-center')
    expect(source).toContain('.workshop-shell.preview-collapsed .workshop-center {\n  grid-template-columns: minmax(0, 1fr);')
    expect(source).toContain('.preview-collapsed .workshop-preview { border-left: 0; border-top: 1px solid')
  })

  test('stretches the Workshop launcher across its dedicated preset toolbar host', () => {
    expect(source).toContain("toolbar.root.style.width = '100%'")
    expect(source).toContain("host.style.flex = '1 1 100%'")
    expect(source).toContain("host.style.width = '100%'")
  })

  test('does not keep assembling a hidden preview', () => {
    expect(source).toContain('if (destroyed || previewCollapsed) return')
    expect(source).toContain("type: 'workshop:cancel-preview'")
    expect(source).toContain('schedulePreview(true)')
  })
})
