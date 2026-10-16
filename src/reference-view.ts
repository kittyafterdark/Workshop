import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import type { ReferencePreset, ReferenceResult } from './reference-backend.js'
import { computePromptGroups } from './workshop-core.js'

export const REFERENCE_CSS = `
.workshop-reference[hidden] {display:none}
.workshop-reference {min-height:0;min-width:0;display:flex;flex-direction:column;overflow:auto;padding:10px;gap:8px}
.workshop-reference-controls {flex-shrink:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.workshop-reference-controls>div {flex:1;min-width:160px}
.workshop-reference-controls label {font-size:11px;color:var(--lumiverse-text-muted)}
.workshop-reference select,.workshop-reference input {display:block;width:100%;min-width:0;padding:7px;border:1px solid var(--lumiverse-border);border-radius:7px;background:var(--lumiverse-input-bg,var(--lumiverse-bg));color:var(--lumiverse-text);font:inherit}
.workshop-reference>input {flex-shrink:0}
.workshop-reference-status {flex-shrink:0;font-size:11px;color:var(--lumiverse-text-muted);margin:0}
.workshop-reference-body {display:grid;grid-template-columns:minmax(130px,30%) minmax(0,1fr);gap:10px;min-height:150px;flex:1}
.workshop-reference-nav {overflow:auto;min-height:0;min-width:0;border:1px solid var(--lumiverse-border);border-radius:8px;padding:6px}
.workshop-reference-nav summary {cursor:pointer;padding:7px;font-size:12px;overflow-wrap:anywhere}
.workshop-reference-nav button {display:block;width:100%;text-align:left;padding:8px;margin:3px 0;white-space:normal;overflow-wrap:anywhere}
.workshop-reference-nav button[aria-current=true] {border-color:var(--lumiverse-primary);background:var(--lumiverse-fill-subtle,rgba(128,128,128,.15))}
.workshop-reference-document {display:flex;flex-direction:column;min-width:0;min-height:0;gap:6px}
.workshop-reference-document h3 {font-size:13px;margin:0;overflow-wrap:anywhere}
.workshop-reference-document label {font-size:11px;color:var(--lumiverse-text-muted)}
.workshop-reference-document textarea {flex:1;min-height:70px;width:100%;resize:none;border:1px solid var(--lumiverse-border);border-radius:8px;padding:10px;background:var(--lumiverse-input-bg,var(--lumiverse-bg));color:var(--lumiverse-text);font:12px/1.6 var(--lumiverse-font-mono,monospace)}
@media(max-width:900px){.workshop-shell.reference-mode:not(.preview-collapsed) .workshop-center,.workshop-shell.reference-mode.preview-split:not(.preview-collapsed) .workshop-center {grid-template-rows:minmax(0,1fr) 5px min(60vh,max(360px,var(--wk-preview-height)))}.workshop-preview-label {display:none}}
@media(max-width:600px){.workshop-reference-body {grid-template-columns:minmax(110px,35%) minmax(0,1fr)}.workshop-reference {padding:7px}}
`

export class ReferenceView {
  readonly element = document.createElement('div')
  private disposed = false
  private started = false
  private sequence = 0
  private preset: ReferencePreset | null = null
  private selected: string | null = null
  private collapsed = new Set<string>()
  private pending = new Map<string, { resolve: (result: ReferenceResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private unsubscribe: () => void
  private picker: HTMLSelectElement
  private search: HTMLInputElement
  private nav: HTMLElement
  private text: HTMLTextAreaElement
  private title: HTMLElement
  private status: HTMLElement
  private copy: HTMLButtonElement
  constructor(private readonly ctx: SpindleFrontendContext, private readonly mountedId: string) {
    this.element.className = 'workshop-reference'
    this.element.hidden = true
    this.element.setAttribute('role', 'region')
    this.element.setAttribute('aria-label', 'Reference preset')
    const id = `reference-${crypto.randomUUID()}`
    this.element.innerHTML = `<div class="workshop-reference-controls"><div><label for="${id}-preset">Reference preset</label><select id="${id}-preset"><option value="">Choose a second preset</option></select></div><button type="button" class="workshop-text-button" data-reference-refresh>Refresh reference presets</button></div><p class="workshop-reference-status" role="status"></p><input type="search" placeholder="Search reference prompts…" aria-label="Search reference prompts"><div class="workshop-reference-body"><nav class="workshop-reference-nav" aria-label="Reference prompts"></nav><section class="workshop-reference-document" aria-label="Reference prompt"><h3>Select a reference prompt</h3><button class="workshop-text-button" type="button" data-reference-copy disabled>Copy reference prompt</button><label for="${id}">Read-only prompt content</label><textarea id="${id}" readonly spellcheck="false"></textarea></section></div>`
    this.picker = this.element.querySelector('select')!
    this.search = this.element.querySelector('input')!
    this.nav = this.element.querySelector('nav')!
    this.text = this.element.querySelector('textarea')!
    this.title = this.element.querySelector('h3')!
    this.status = this.element.querySelector('[role=status]')!
    this.copy = this.element.querySelector('[data-reference-copy]')!
    this.unsubscribe = ctx.onBackendMessage(payload => {
      if (!payload || typeof payload !== 'object') return
      const p = payload as ReferenceResult
      if (p.type !== 'workshop:reference-result') return
      const pending = this.pending.get(p.requestId)
      if (!pending) return
      clearTimeout(pending.timer); this.pending.delete(p.requestId)
      if (p.error) pending.reject(Error(p.error)); else pending.resolve(p)
    })
    this.picker.addEventListener('change', () => { this.search.value = ''; this.selected = null; this.collapsed.clear(); void this.loadSelected() })
    this.search.addEventListener('input', () => this.renderNav())
    this.element.querySelector('[data-reference-refresh]')!.addEventListener('click', () => { void this.refresh() })
    this.copy.addEventListener('click', () => {
      const content = this.text.value
      void Promise.resolve().then(() => navigator.clipboard.writeText(content)).then(() => { if (!this.disposed) this.status.textContent = 'Reference prompt copied.' }, () => {
        if (this.disposed) return
        this.text.focus(); this.text.select(); this.status.textContent = 'Clipboard unavailable. Copy the selected text with your keyboard or selection menu.'
      })
    })
  }
  activate(): void { if (!this.started) { this.started = true; void this.refresh() } }
  private request(type: 'list' | 'get', presetId?: string): Promise<ReferenceResult> {
    const requestId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(Error('Reference read timed out. Refresh to retry.')) }, 10000)
      this.pending.set(requestId, { resolve, reject, timer })
      try { this.ctx.sendToBackend({ type: `workshop:reference-${type}`, requestId, presetId }) }
      catch { clearTimeout(timer); this.pending.delete(requestId); reject(Error('Could not request reference presets.')) }
    })
  }
  async refresh(): Promise<void> {
    const sequence = ++this.sequence
    const selected = this.picker.value
    this.status.textContent = 'Loading reference presets…'
    try {
      const result = await this.request('list')
      if (this.disposed || sequence !== this.sequence) return
      const entries = (result.presets ?? []).filter(p => p.id !== this.mountedId)
      this.picker.replaceChildren(new Option(entries.length ? 'Choose a second preset' : 'No other presets available', ''), ...entries.map(p => new Option(p.name, p.id)))
      this.picker.value = entries.some(p => p.id === selected) ? selected : ''
      await this.loadSelected()
    } catch (error) { if (!this.disposed && sequence === this.sequence) this.status.textContent = error instanceof Error ? error.message : 'Could not load presets.' }
  }
  private async loadSelected(): Promise<void> {
    const sequence = ++this.sequence, presetId = this.picker.value
    const previous = this.selected
    this.preset = null; this.selected = null; this.renderNav(); this.renderDocument()
    if (!presetId) { this.status.textContent = 'Read-only saved snapshot. Choose a second preset; unsynced edits are not included.'; return }
    this.status.textContent = 'Loading reference preset…'
    try {
      const result = await this.request('get', presetId)
      if (this.disposed || sequence !== this.sequence) return
      if (!result.preset || result.preset.id !== presetId) throw Error('Reference preset unavailable.')
      this.preset = result.preset
      this.selected = this.preset.blocks.some(b => b.id === previous) ? previous : null
      this.status.textContent = `${this.preset.name} · Read-only saved snapshot; unsynced edits are not included.`
      this.renderNav(); this.renderDocument()
    } catch (error) { if (!this.disposed && sequence === this.sequence) this.status.textContent = error instanceof Error ? error.message : 'Could not read preset.' }
  }
  private renderNav(): void {
    const scroll = this.nav.scrollTop
    this.nav.replaceChildren()
    const query = this.search.value.trim().toLowerCase()
    for (const [index, group] of computePromptGroups(this.preset?.blocks ?? []).entries()) {
      const category = group.categoryBlock?.name ?? 'Ungrouped'
      const blocks = [group.categoryBlock, ...group.children].filter(b => b && (!query || `${category}\n${b.name}\n${b.content}`.toLowerCase().includes(query)))
      if (!blocks.length) continue
      const details = document.createElement('details'), summary = document.createElement('summary')
      const key = `${group.categoryBlock?.id ?? 'ungrouped'}-${index}`
      details.open = !!query || !this.collapsed.has(key)
      summary.textContent = category; details.append(summary)
      details.addEventListener('toggle', () => { if (details.open) this.collapsed.delete(key); else this.collapsed.add(key) })
      for (const block of blocks) {
        if (!block) continue
        const button = document.createElement('button')
        button.type = 'button'; button.className = 'workshop-text-button'
        button.textContent = block.name || 'Untitled prompt'
        if (block.id === this.selected) button.setAttribute('aria-current', 'true')
        button.addEventListener('click', () => {
          this.selected = block.id
          for (const other of this.nav.querySelectorAll('[aria-current]')) other.removeAttribute('aria-current')
          button.setAttribute('aria-current', 'true'); this.renderDocument()
        })
        details.append(button)
      }
      this.nav.append(details)
    }
    if (this.preset && !this.nav.children.length) this.nav.textContent = query ? 'No matching reference prompts.' : 'This preset has no prompt blocks.'
    this.nav.scrollTop = scroll
  }
  private renderDocument(): void {
    const block = this.preset?.blocks.find(b => b.id === this.selected)
    this.title.textContent = block ? `${block.name} · ${block.role} · ${block.enabled ? 'Enabled' : 'Disabled'}` : 'Select a reference prompt'
    this.text.value = block?.content ?? ''; this.copy.disabled = !block
  }
  destroy(): void {
    this.disposed = true; this.unsubscribe()
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(Error('Reference view closed.')) }
    this.pending.clear(); this.element.remove()
  }
}
