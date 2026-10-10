import type { SpindleFrontendContext, SpindlePresetEditorDraft } from 'lumiverse-spindle-types'
import type { AgentContext } from './agent-core.js'
import type { AgentResponse } from './agent-backend.js'
import { presetFingerprint } from './backup-core.js'

/** Native dialogs avoid consuming Lumi's last extension-modal slot. */
export function confirmAgentApply(parent: HTMLElement): Promise<boolean> {
  if (parent.querySelector('.workshop-agent-apply')) return Promise.resolve(false)
  const dialog = document.createElement('dialog'), titleId = `agent-apply-${crypto.randomUUID()}`
  const previous = document.activeElement as HTMLElement | null
  dialog.className = 'workshop-agent-exit workshop-agent-apply'
  dialog.setAttribute('aria-labelledby', titleId)
  dialog.innerHTML = `<h2 id="${titleId}">Apply local agent drafts?</h2><p>Apply all unsynced Workshop changes to the mounted preset? A backup will be created first.</p><button type="button" class="workshop-text-button" data-confirm>Apply drafts</button><button type="button" class="workshop-text-button" data-cancel autofocus>Keep editing</button>`
  parent.append(dialog)
  return new Promise(resolve => {
    const finish = (confirmed: boolean) => {
      observer.disconnect(); dialog.close(); dialog.remove()
      if (previous?.isConnected) previous.focus({ preventScroll: true })
      resolve(confirmed)
    }
    const observer = new MutationObserver(() => { if (!dialog.isConnected) finish(false) })
    observer.observe(document.body, { childList: true, subtree: true })
    dialog.querySelector('[data-confirm]')!.addEventListener('click', () => finish(true))
    dialog.querySelector('[data-cancel]')!.addEventListener('click', () => finish(false))
    dialog.addEventListener('cancel', e => { e.preventDefault(); finish(false) })
    dialog.showModal()
  })
}

export const AGENT_CSS = `
.workshop-shell .workshop-header {grid-template-columns:auto minmax(0,1fr) auto}
.workshop-shell.agent-mode .workshop-body { display:none!important }
.workshop-shell.agent-mode .workshop-mobile-only,.workshop-shell.agent-mode [data-action="backups"],.workshop-shell.agent-mode [data-action="preview-layout"] { display:none!important }
.workshop-agent { min-height:0;min-width:0;display:grid;grid-template-rows:minmax(0,1fr) minmax(80px,26%);overflow:hidden;grid-row:2 }
.has-draft-error .workshop-agent {grid-row:3}
.workshop-shell.agent-mode .workshop-preview {grid-column:1;grid-row:2;border-left:0;min-height:0}
.workshop-shell.agent-mode.preview-collapsed .workshop-agent {grid-template-rows:minmax(0,1fr) 38px}
.workshop-agent-columns {display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,42%);min-height:0;min-width:0}
.workshop-agent-editor,.workshop-agent-chat {display:flex;flex-direction:column;gap:12px;min-width:0;min-height:0;padding:16px;overflow:auto}
.workshop-agent-chat {border-left:1px solid var(--lumiverse-border);background:var(--lumiverse-fill-subtle,rgba(255,255,255,.025))}
.workshop-agent h2 {font-size:15px;margin:0}.workshop-agent p{font-size:12px;color:var(--lumiverse-text-muted);margin:0;line-height:1.5}
.workshop-agent label {display:flex;flex-direction:column;gap:6px;font-size:12px;font-weight:600;min-width:0}
.workshop-agent select,.workshop-agent textarea {box-sizing:border-box;width:100%;border:1px solid var(--lumiverse-border);border-radius:8px;background:var(--lumiverse-bg);color:var(--lumiverse-text);padding:10px;font:inherit}
.workshop-agent textarea {resize:vertical;line-height:1.5}.workshop-agent [data-agent="content"] {font-family:monospace;min-height:180px;flex:1;resize:none}
.workshop-agent .workshop-agent-content {flex:1;min-height:180px}
.workshop-agent-settings>div {display:flex;flex-direction:column;gap:6px;min-width:0}
.workshop-agent-settings {display:grid;grid-template-columns:1fr 1fr;gap:10px}
.workshop-agent-log {flex:1;min-height:90px;overflow:auto;display:flex;flex-direction:column;gap:12px;padding:4px}
.workshop-agent-message {white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.5;padding:12px;border:1px solid var(--lumiverse-border);border-radius:10px}
.workshop-agent-message strong {display:block;margin-bottom:6px;font-size:11px;color:var(--lumiverse-text-muted)}
.workshop-agent details {font-size:12px}.workshop-agent pre {white-space:pre-wrap;overflow-wrap:anywhere;max-height:200px;overflow:auto;font-size:11px}
.workshop-agent form {display:flex;flex-direction:column;gap:8px}.workshop-agent-actions{display:flex;gap:8px;align-items:center}.workshop-agent-status{font-size:12px;line-height:1.5}
.workshop-agent-exit {max-width:min(440px,calc(100vw - 32px));border:1px solid var(--lumiverse-border);border-radius:12px;padding:22px;background:var(--lumiverse-bg,#17171e);color:var(--lumiverse-text,#eee)}
.workshop-agent-exit::backdrop{background:rgba(0,0,0,.65)}.workshop-agent-exit h2{font-size:17px}.workshop-agent-exit p{font-size:13px;line-height:1.5}.workshop-agent-exit button {margin:6px 5px 0 0}
@media(max-width:900px){.workshop-agent-columns{grid-template-columns:minmax(0,1fr);grid-auto-rows:max-content;align-content:start;overflow:auto}.workshop-agent .workshop-agent-content{flex:none;min-height:0}.workshop-agent .workshop-preview-label,.workshop-agent .workshop-preview-status,.workshop-agent [data-action="preview-entries-collapse"]{display:none}.workshop-agent-editor,.workshop-agent-chat{overflow:visible;padding:12px}.workshop-agent-chat{border-left:0;border-top:1px solid var(--lumiverse-border)}.workshop-agent-log{max-height:250px;flex:none}.workshop-agent [data-agent="content"]{height:210px;flex:none}.workshop-agent-settings{grid-template-columns:1fr}.workshop-agent{grid-template-rows:minmax(0,1fr) 150px}.workshop-shell.agent-mode .workshop-header-brand{display:none}}
`

export class AgentWorkspace {
  readonly element = document.createElement('section')
  busy = false
  private request: { id: string; fingerprint: string; history: Array<{ role: 'user' | 'assistant'; content: string }> } | null = null
  private history: Array<{ role: 'user' | 'assistant'; content: string }> = []
  private unsubscribe: () => void
  private timer: ReturnType<typeof setTimeout> | null = null
  private configId = crypto.randomUUID()
  private disposed = false
  private exitDialog: HTMLDialogElement | null = null
  private finishExit: ((choice: 'keep' | 'discard' | null) => void) | null = null
  constructor(private readonly ctx: SpindleFrontendContext, private readonly options: {
    snapshot: () => SpindlePresetEditorDraft
    context: () => AgentContext
    stage: (preset: SpindlePresetEditorDraft, baseline: string) => void
  }) {
    this.element.className = 'workshop-agent'
    this.element.setAttribute('aria-label', 'Agent workspace')
    const fieldId = crypto.randomUUID()
    this.element.innerHTML = `<div class="workshop-agent-columns"><section class="workshop-agent-editor" aria-label="Draft prompt editor"><h2>Agent workspace</h2><p>Everything here stays local until Apply. Leaving lets you keep drafts in Workshop or discard them.</p><div><label for="${fieldId}-block">Prompt</label><select id="${fieldId}-block" data-agent="block"></select></div><label class="workshop-agent-content">Draft content<textarea data-agent="content" spellcheck="false"></textarea></label><details><summary>Inspect mounted context</summary><p>Includes current values, preview mocks, diagnostics, settings and regex metadata. Only this mounted preset is available to the agent.</p><pre data-agent="context"></pre></details></section><section class="workshop-agent-chat" aria-label="Preset assistant"><div class="workshop-agent-settings"><div><label for="${fieldId}-connection">Lumi connection</label><select id="${fieldId}-connection" data-agent="connection"><option value="">Loading connections…</option></select></div><div><label for="${fieldId}-server">PresetTools compatibility</label><select id="${fieldId}-server" data-agent="server"><option value="">Built-in tools · no MCP required</option></select></div></div><p>Optional MCP discovery maps supported PresetTools names to this local draft. External file tools are never executed.</p><div class="workshop-agent-log" data-agent="log" aria-label="Conversation"></div><details><summary>Tool activity</summary><pre data-agent="activity"></pre></details><div class="workshop-agent-status" data-agent="status" role="status"></div><form><label>Ask the preset assistant<textarea data-agent="instruction" rows="3" placeholder="Review diagnostics, or describe an edit…" required maxlength="30000"></textarea></label><div class="workshop-agent-actions"><button class="workshop-text-button" type="submit" data-agent="send" disabled>Send</button><button class="workshop-text-button" type="button" data-agent="stop" disabled>Stop</button></div></form></section></div>`
    this.unsubscribe = ctx.onBackendMessage(payload => this.receive(payload))
    this.select('block').addEventListener('change', () => this.renderContent())
    this.select('connection').addEventListener('change', () => this.updateControls())
    this.area('content').addEventListener('input', () => {
      try {
        const preset = options.snapshot(), baseline = presetFingerprint(preset)
        const block = preset.blocks.find(b => b.id === this.select('block').value)
        if (!block || block.isLocked || preset.blocks.filter(b => b.id === block.id).length !== 1) throw Error('This prompt cannot be edited.')
        block.content = this.area('content').value
        options.stage(preset, baseline)
      } catch (error) { this.status(error instanceof Error ? error.message : 'Could not stage this edit.') }
    })
    this.element.querySelector('form')!.addEventListener('submit', e => { e.preventDefault(); this.run() })
    this.button('stop').addEventListener('click', () => this.cancel())
    this.refresh()
    ctx.sendToBackend({ type: 'workshop:agent-config', requestId: this.configId })
  }
  private select(name: string): HTMLSelectElement { return this.element.querySelector(`[data-agent="${name}"]`)! }
  private area(name: string): HTMLTextAreaElement { return this.element.querySelector(`[data-agent="${name}"]`)! }
  private button(name: string): HTMLButtonElement { return this.element.querySelector(`[data-agent="${name}"]`)! }
  private status(text: string): void { this.element.querySelector('[data-agent="status"]')!.textContent = text }
  private updateControls(): void {
    this.button('send').disabled = this.busy || !this.select('connection').value
    this.button('stop').disabled = !this.busy
    this.area('content').readOnly = this.busy || !!this.options.snapshot().blocks.find(b => b.id === this.select('block').value)?.isLocked
    this.select('connection').disabled = this.busy
    this.select('server').disabled = this.busy
  }
  private message(role: 'user' | 'assistant', text: string): void {
    const node = document.createElement('div'), label = document.createElement('strong')
    node.className = 'workshop-agent-message'; label.textContent = role === 'user' ? 'You' : 'Assistant'
    node.append(label, document.createTextNode(text))
    const log = this.element.querySelector('[data-agent="log"]')!
    log.append(node); log.scrollTop = log.scrollHeight
  }
  refresh(): void {
    if (this.disposed) return
    const preset = this.options.snapshot(), selected = this.select('block').value
    this.select('block').replaceChildren(...preset.blocks.map(b => new Option(`${b.name}${b.isLocked ? ' · Locked' : ''}`, b.id)))
    if (preset.blocks.some(b => b.id === selected)) this.select('block').value = selected
    this.renderContent()
    this.element.querySelector('[data-agent="context"]')!.textContent = JSON.stringify({ preset, ...this.options.context() }, null, 2)
    this.updateControls()
  }
  private renderContent(): void {
    const block = this.options.snapshot().blocks.find(b => b.id === this.select('block').value)
    if (this.area('content').value !== (block?.content ?? '')) this.area('content').value = block?.content ?? ''
    this.area('content').disabled = !block
    this.updateControls()
  }
  private run(): void {
    if (this.busy || !this.select('connection').value || !this.area('instruction').value.trim()) return
    try {
      const preset = this.options.snapshot(), instruction = this.area('instruction').value.trim()
      this.request = { id: crypto.randomUUID(), fingerprint: presetFingerprint(preset), history: [...this.history, { role: 'user', content: instruction }] }
      this.busy = true; this.updateControls(); this.status('Working in a detached draft…')
      this.message('user', instruction)
      this.element.querySelector('[data-agent="activity"]')!.textContent = ''
      this.timer = setTimeout(() => this.cancel('Agent timed out. No generated changes were staged.'), 125000)
      this.ctx.sendToBackend({ type: 'workshop:agent-run', requestId: this.request.id, connectionId: this.select('connection').value, serverId: this.select('server').value, instruction, history: this.history, preset, context: this.options.context() })
      this.area('instruction').value = ''
    } catch (error) { this.cancel(error instanceof Error ? error.message : 'Could not start agent.') }
  }
  private receive(payload: unknown): void {
    if (this.disposed || !payload || typeof payload !== 'object') return
    const p = payload as AgentResponse
    if (p.type === 'workshop:agent-config' && p.requestId === this.configId) {
      this.select('connection').replaceChildren(new Option('Choose a connection', ''), ...(p.connections ?? []).map(c => new Option(`${c.name}${c.model ? ` · ${c.model}` : ''}`, c.id)))
      if (p.connections?.length === 1) this.select('connection').value = p.connections[0].id
      this.select('server').replaceChildren(new Option('Built-in tools · no MCP required', ''), ...(p.servers ?? []).map(s => new Option(s.name, s.id)))
      this.status(p.error ?? 'Ready. Sending shares this preset context with the selected connection.'); this.updateControls(); return
    }
    if (!this.request || p.requestId !== this.request.id) return
    if (p.type === 'workshop:agent-progress') {
      this.element.querySelector('[data-agent="activity"]')!.textContent += `${p.content ?? ''}\n`; return
    }
    if (p.type !== 'workshop:agent-result') return
    const request = this.request
    this.request = null; this.busy = false
    if (this.timer) clearTimeout(this.timer); this.timer = null
    try {
      if (p.error) throw Error(p.error)
      if (p.preset && presetFingerprint(p.preset) !== request.fingerprint) this.options.stage(p.preset, request.fingerprint)
      this.history = [...request.history, { role: 'assistant', content: p.content ?? '' }]
      this.message('assistant', p.content ?? 'Finished.'); this.status('Finished. Review local drafts and preview before Apply.')
    } catch (error) {
      if (p.content) this.message('assistant', p.content)
      this.status(error instanceof Error ? error.message : 'Could not stage agent result.')
    }
    this.refresh(); this.area('instruction').focus({ preventScroll: true })
  }
  cancel(message = 'Stopped. No generated changes were staged.'): void {
    if (this.request) this.ctx.sendToBackend({ type: 'workshop:agent-cancel', requestId: this.request.id })
    this.request = null; this.busy = false
    if (this.timer) clearTimeout(this.timer); this.timer = null
    this.status(message); this.updateControls()
  }
  confirmLeave(): Promise<'keep' | 'discard' | null> {
    if (this.exitDialog) return Promise.resolve(null)
    const dialog = document.createElement('dialog'), titleId = `agent-exit-${crypto.randomUUID()}`
    dialog.className = 'workshop-agent-exit'; dialog.setAttribute('aria-labelledby', titleId)
    dialog.innerHTML = `<h2 id="${titleId}">Leave agent mode?</h2><p>Keep drafts returns to Workshop with all local edits intact. Discard removes all unsynced Workshop edits. A running agent will be stopped. Neither option applies changes.</p><button class="workshop-text-button" data-choice="keep">Keep drafts and leave</button><button class="workshop-text-button" data-choice="discard">Discard drafts and leave</button><button class="workshop-text-button" data-choice="stay" autofocus>Stay</button>`
    this.element.append(dialog); this.exitDialog = dialog
    return new Promise(resolve => {
      this.finishExit = choice => { dialog.close(); dialog.remove(); this.exitDialog = null; this.finishExit = null; resolve(choice) }
      dialog.addEventListener('cancel', e => { e.preventDefault(); this.finishExit?.(null) })
      dialog.addEventListener('click', e => {
        const choice = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-choice]')?.dataset.choice
        if (choice) this.finishExit?.(choice === 'stay' ? null : choice as 'keep' | 'discard')
      })
      dialog.showModal()
    })
  }
  destroy(): void { this.cancel(); this.disposed = true; this.finishExit?.(null); this.unsubscribe(); this.element.remove() }
}
