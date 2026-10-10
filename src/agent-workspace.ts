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
.workshop-shell.agent-mode .workshop-body {display:none!important}
.workshop-shell.agent-mode .workshop-mobile-only,.workshop-shell.agent-mode [data-action="backups"],.workshop-shell.agent-mode [data-action="preview-layout"] {display:none!important}
.workshop-agent {min-height:0;min-width:0;display:grid;grid-template-rows:minmax(0,1fr) minmax(80px,26%);overflow:hidden;grid-row:2}
.has-draft-error .workshop-agent {grid-row:3}
.workshop-shell.agent-mode .workshop-preview {grid-column:1;grid-row:2;border-left:0;min-height:0}
.workshop-shell.agent-mode.preview-collapsed .workshop-agent {grid-template-rows:minmax(0,1fr) 38px}
.workshop-agent-columns {display:grid;grid-template-columns:minmax(0,1fr) minmax(320px,42%);min-height:0;min-width:0}
.workshop-agent-prompt {position:relative;display:grid;grid-template-columns:minmax(0,1fr);min-width:0;min-height:0;overflow:hidden}
.workshop-agent-prompt.navigation-open {grid-template-columns:minmax(180px,30%) minmax(0,1fr)}
.workshop-shell.agent-mode .workshop-agent .workshop-rail.left {position:static;grid-column:1;grid-row:1;width:auto!important;transform:none;box-shadow:none;visibility:visible!important}
.workshop-shell.agent-mode .workshop-agent .workshop-rail.left[hidden] {display:none!important}
.workshop-shell.agent-mode .workshop-agent .workshop-rail.left .workshop-rail-title,
.workshop-shell.agent-mode .workshop-agent .workshop-rail.left .workshop-count,
.workshop-shell.agent-mode .workshop-agent .workshop-rail.left .workshop-search-wrap,
.workshop-shell.agent-mode .workshop-agent .workshop-rail.left .workshop-scroll,
.workshop-shell.agent-mode .workshop-agent .workshop-rail.left .workshop-rail-note {display:block}
.workshop-shell.agent-mode .workshop-agent .workshop-rail.left .workshop-scroll {flex:1}
.workshop-shell.agent-mode .workshop-agent .workshop-rail-header {justify-content:initial;padding:7px 7px 5px 11px}
.workshop-shell.agent-mode .workshop-agent .workshop-rail-tools {display:inline-flex}
.workshop-shell.agent-mode .workshop-agent .workshop-rail-collapse {display:inline-flex}
.workshop-agent-editor,.workshop-agent-chat {min-width:0;min-height:0;display:flex;flex-direction:column}
.workshop-agent-editor {gap:14px;padding:18px;overflow:auto;grid-column:-2 / -1}
.workshop-agent-chat {border-left:1px solid var(--lumiverse-border);background:var(--lumiverse-fill-subtle,rgba(255,255,255,.025));overflow:hidden}
.workshop-agent-editor-heading {display:flex;gap:10px;align-items:center}
.workshop-agent h2 {font-size:15px;margin:0}.workshop-agent p {font-size:12px;color:var(--lumiverse-text-muted);margin:0;line-height:1.5}
.workshop-agent .workshop-agent-block-name {font-size:14px;font-weight:650;color:var(--lumiverse-text);overflow-wrap:anywhere;padding-bottom:12px;border-bottom:1px solid var(--lumiverse-border)}
.workshop-agent label {display:flex;flex-direction:column;gap:7px;font-size:12px;font-weight:600;min-width:0}
.workshop-agent select,.workshop-agent textarea {box-sizing:border-box;width:100%;border:1px solid var(--lumiverse-border);border-radius:10px;background:var(--lumiverse-bg);color:var(--lumiverse-text);padding:11px;font:inherit}
.workshop-agent textarea {line-height:1.6}.workshop-agent [data-agent="content"] {font-family:var(--lumiverse-font-mono,monospace);font-size:12px;min-height:180px;flex:1;resize:none;padding:16px;border-radius:12px}
.workshop-agent .workshop-agent-content {flex:1;min-height:180px}
.workshop-agent-settings>div {display:flex;flex-direction:column;gap:7px;min-width:0}
.workshop-agent-settings {display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:18px;border-bottom:1px solid var(--lumiverse-border)}
.workshop-agent-settings>p {grid-column:1 / -1;font-size:11px}
.workshop-agent-log {flex:1;min-height:60px;overflow:auto;display:flex;flex-direction:column;gap:14px;padding:18px;scrollbar-gutter:stable}
.workshop-agent-message {white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.6;padding:14px;border:1px solid var(--lumiverse-border);border-radius:12px;background:var(--lumiverse-bg)}
.workshop-agent-message strong {display:block;margin-bottom:7px;font-size:11px;color:var(--lumiverse-text-muted)}
.workshop-agent details {font-size:12px}.workshop-agent pre {white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto;font-size:11px}
.workshop-agent-chat-footer {flex:0 0 auto;padding:0 18px 18px;display:flex;flex-direction:column;gap:10px}
.workshop-agent-chat-footer details {padding:0 3px}.workshop-agent-status {font-size:11px;line-height:1.5;color:var(--lumiverse-text-muted);padding:0 3px}
.workshop-agent-composer {display:flex;gap:10px;align-items:flex-end;padding:12px;border:1px solid var(--lumiverse-border);border-radius:18px;background:var(--lumiverse-bg);box-shadow:0 6px 20px rgba(0,0,0,.12)}
.workshop-agent-composer:focus-within {border-color:var(--lumiverse-primary,var(--lumiverse-text-muted))}
.workshop-agent-composer textarea {flex:1;min-width:0;min-height:48px;max-height:180px;resize:none;border:0!important;border-radius:0;background:transparent;padding:4px;outline:none;font-size:13px;box-shadow:none}
.workshop-agent-send {flex:0 0 auto;width:36px;height:36px;display:grid;place-items:center;border:0;border-radius:50%;background:var(--lumiverse-primary,#a3a0e5);color:var(--lumiverse-primary-text,#111);cursor:pointer}
.workshop-agent-send:disabled {opacity:.4;cursor:default}.workshop-agent-send svg,.workshop-agent-nav-toggle svg {width:18px;height:18px;display:block}
.workshop-agent-nav-toggle {flex:0 0 auto;width:32px;height:32px;display:grid;place-items:center}
.workshop-agent button:focus-visible,.workshop-agent summary:focus-visible {outline:2px solid var(--lumiverse-primary,#a3a0e5);outline-offset:3px}
.workshop-agent-sr-only {position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
.workshop-agent-exit {max-width:min(440px,calc(100vw - 32px));border:1px solid var(--lumiverse-border);border-radius:12px;padding:22px;background:var(--lumiverse-bg,#17171e);color:var(--lumiverse-text,#eee)}
.workshop-agent-exit::backdrop {background:rgba(0,0,0,.65)}.workshop-agent-exit h2 {font-size:17px}.workshop-agent-exit p {font-size:13px;line-height:1.5}.workshop-agent-exit button {margin:6px 5px 0 0}
@media(max-width:1100px){.workshop-agent-prompt.navigation-open {grid-template-columns:minmax(0,1fr)}.workshop-shell.agent-mode .workshop-agent-prompt.navigation-open .workshop-rail.left {position:absolute;inset:0 auto 0 0;width:min(85%,300px)!important;z-index:2;box-shadow:8px 0 24px rgba(0,0,0,.3)}}
@media(max-width:900px){
 .workshop-agent-columns {grid-template-columns:minmax(0,1fr);grid-auto-rows:max-content;align-content:start;overflow:auto}
 .workshop-agent .workshop-agent-content {flex:none;min-height:0}
 .workshop-agent .workshop-preview-label,.workshop-agent .workshop-preview-status,.workshop-agent [data-action="preview-entries-collapse"] {display:none}
 .workshop-agent-editor {overflow:visible;padding:14px}
 .workshop-agent-chat {border-left:0;border-top:1px solid var(--lumiverse-border);min-height:480px}
 .workshop-agent-log {max-height:300px;min-height:70px}
 .workshop-agent [data-agent="content"] {height:230px;flex:none}
 .workshop-agent-settings {grid-template-columns:1fr;padding:14px}
 .workshop-agent-chat-footer {padding:0 14px 14px}
 .workshop-agent {grid-template-rows:minmax(0,1fr) 150px}
 .workshop-shell.agent-mode .workshop-header-brand {display:none}
}
`

const AGENT_ICONS = {
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  sidebar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>',
}

export class AgentWorkspace {
  readonly element = document.createElement('section')
  busy = false
  private request: { id: string; fingerprint: string; history: Array<{ role: 'user' | 'assistant'; content: string }> } | null = null
  private history: Array<{ role: 'user' | 'assistant'; content: string }> = []
  private unsubscribe: () => void
  private timer: ReturnType<typeof setTimeout> | null = null
  private configId = crypto.randomUUID()
  private disposed = false
  private selectedId: string | null = null
  private navigationOpen = false
  private navigationHome: { parent: Node; next: ChildNode | null; id: string; label: string | null; hidden: boolean; buttonLabel: string | null }
  private exitDialog: HTMLDialogElement | null = null
  private finishExit: ((choice: 'keep' | 'discard' | null) => void) | null = null
  constructor(private readonly ctx: SpindleFrontendContext, private readonly options: {
    snapshot: () => SpindlePresetEditorDraft
    context: () => AgentContext
    stage: (preset: SpindlePresetEditorDraft, baseline: string) => void
    navigation: HTMLElement
    initialBlockId: string | null
    onSelection: () => void
  }) {
    this.element.className = 'workshop-agent'
    this.element.setAttribute('aria-label', 'Agent workspace')
    const fieldId = crypto.randomUUID()
    this.element.innerHTML = `<div class="workshop-agent-columns"><div class="workshop-agent-prompt"><section class="workshop-agent-editor" aria-label="Draft prompt editor"><div class="workshop-agent-editor-heading"><button class="workshop-text-button workshop-agent-nav-toggle" type="button" data-agent="prompts" aria-controls="${fieldId}-prompts" aria-expanded="false" aria-label="Open agent prompts">${AGENT_ICONS.sidebar}</button><h2>Prompt draft</h2></div><p>All edits stay local until Apply.</p><p class="workshop-agent-block-name" data-agent="block-name"></p><label class="workshop-agent-content">Draft content<textarea data-agent="content" spellcheck="false"></textarea></label><details><summary>Inspect mounted context</summary><p>Includes current values, preview mocks, diagnostics, settings and regex metadata. Only this mounted preset is available to the agent.</p><pre data-agent="context"></pre></details></section></div><section class="workshop-agent-chat" aria-label="Preset assistant"><div class="workshop-agent-settings"><div><label for="${fieldId}-connection">Lumi connection</label><select id="${fieldId}-connection" data-agent="connection"><option value="">Loading connections…</option></select></div><div><label for="${fieldId}-server">PresetTools compatibility</label><select id="${fieldId}-server" data-agent="server"><option value="">Built-in tools · no MCP required</option></select></div><p>Built-in tools work without MCP. Optional compatibility uses the same local draft.</p></div><div class="workshop-agent-log" data-agent="log" aria-label="Conversation"></div><div class="workshop-agent-chat-footer"><details><summary>Tool activity</summary><pre data-agent="activity"></pre></details><div class="workshop-agent-status" data-agent="status" role="status"></div><form class="workshop-agent-composer"><label class="workshop-agent-sr-only" for="${fieldId}-instruction">Ask the preset assistant</label><textarea id="${fieldId}-instruction" data-agent="instruction" rows="2" placeholder="Review diagnostics, or describe an edit…" required maxlength="30000"></textarea><button class="workshop-agent-send" type="submit" data-agent="send" aria-label="Send" title="Send" disabled>${AGENT_ICONS.send}</button></form></div></section></div>`
    const navigation = options.navigation
    this.navigationHome = { parent: navigation.parentNode!, next: navigation.nextSibling, id: navigation.id, label: navigation.getAttribute('aria-label'), hidden: navigation.hidden, buttonLabel: navigation.querySelector('[data-action="left"]')!.getAttribute('aria-label') }
    navigation.id = `${fieldId}-prompts`
    navigation.setAttribute('aria-label', 'Agent prompts')
    navigation.querySelector('[data-action="left"]')!.setAttribute('aria-label', 'Collapse agent prompt sidebar')
    const initiallyCollapsed = !!navigation.closest('.left-collapsed')
    this.element.querySelector('.workshop-agent-prompt')!.prepend(navigation)
    this.selectedId = options.initialBlockId
    this.setNavigation(window.innerWidth > 1100 && !initiallyCollapsed)
    this.button('prompts').addEventListener('click', () => this.toggleNavigation())
    this.button('send').addEventListener('click', e => { if (this.busy) { e.preventDefault(); this.cancel() } })
    this.unsubscribe = ctx.onBackendMessage(payload => this.receive(payload))
    this.select('connection').addEventListener('change', () => this.updateControls())
    this.area('content').addEventListener('input', () => {
      try {
        const preset = options.snapshot(), baseline = presetFingerprint(preset)
        const block = preset.blocks.find(b => b.id === this.selectedId)
        if (!block || block.isLocked || preset.blocks.filter(b => b.id === block.id).length !== 1) throw Error('This prompt cannot be edited.')
        block.content = this.area('content').value
        options.stage(preset, baseline)
      } catch (error) { this.status(error instanceof Error ? error.message : 'Could not stage this edit.') }
    })
    this.element.querySelector('form')!.addEventListener('submit', e => { e.preventDefault(); if (this.busy) this.cancel(); else this.run() })
    this.area('instruction').addEventListener('input', () => { this.resizeComposer(); this.updateControls() })
    this.area('instruction').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !this.busy) { e.preventDefault(); this.run() }
    })
    this.refresh()
    ctx.sendToBackend({ type: 'workshop:agent-config', requestId: this.configId })
  }
  private select(name: string): HTMLSelectElement { return this.element.querySelector(`[data-agent="${name}"]`)! }
  private area(name: string): HTMLTextAreaElement { return this.element.querySelector(`[data-agent="${name}"]`)! }
  private button(name: string): HTMLButtonElement { return this.element.querySelector(`[data-agent="${name}"]`)! }
  private status(text: string): void { this.element.querySelector('[data-agent="status"]')!.textContent = text }
  private updateControls(): void {
    const send = this.button('send')
    send.disabled = !this.busy && (!this.select('connection').value || !this.area('instruction').value.trim())
    send.type = this.busy ? 'button' : 'submit'
    send.setAttribute('aria-label', this.busy ? 'Stop' : 'Send')
    send.title = this.busy ? 'Stop' : 'Send'
    send.innerHTML = this.busy ? AGENT_ICONS.stop : AGENT_ICONS.send
    this.area('content').readOnly = this.busy || !!this.options.snapshot().blocks.find(b => b.id === this.selectedId)?.isLocked
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
    const preset = this.options.snapshot()
    if (!preset.blocks.some(b => b.id === this.selectedId)) {
      this.selectedId = (preset.blocks.find(b => b.marker !== 'category') ?? preset.blocks[0])?.id ?? null
      if (this.element.isConnected) this.options.onSelection()
    }
    this.renderContent()
    this.element.querySelector('[data-agent="context"]')!.textContent = JSON.stringify({ preset, ...this.options.context() }, null, 2)
    this.updateControls()
  }
  private renderContent(): void {
    const block = this.options.snapshot().blocks.find(b => b.id === this.selectedId)
    if (this.area('content').value !== (block?.content ?? '')) this.area('content').value = block?.content ?? ''
    this.area('content').disabled = !block
    this.element.querySelector('[data-agent="block-name"]')!.textContent = block ? `${block.name}${block.isLocked ? ' · Locked' : ''}` : 'Choose a prompt from the sidebar'
    this.updateControls()
  }
  get selectedBlockId(): string | null { return this.selectedId }
  selectBlock(id: string | null): void {
    if (id && !this.options.snapshot().blocks.some(b => b.id === id)) return
    this.selectedId = id
    this.renderContent()
    this.options.onSelection()
    if (window.innerWidth <= 1100) this.setNavigation(false)
    this.area('content').focus({ preventScroll: true })
  }
  toggleNavigation(): void { this.setNavigation(!this.navigationOpen); if (!this.navigationOpen) this.button('prompts').focus({ preventScroll: true }) }
  closeNavigation(): boolean {
    if (!this.navigationOpen || window.innerWidth > 1100) return false
    this.setNavigation(false); this.button('prompts').focus({ preventScroll: true }); return true
  }
  private setNavigation(open: boolean): void {
    this.navigationOpen = open
    this.options.navigation.hidden = !open
    this.element.querySelector('.workshop-agent-prompt')!.classList.toggle('navigation-open', open)
    this.button('prompts').setAttribute('aria-expanded', String(open))
    this.button('prompts').setAttribute('aria-label', open ? 'Close agent prompts' : 'Open agent prompts')
    this.button('prompts').title = open ? 'Close prompts' : 'Open prompts'
  }
  private resizeComposer(): void {
    const input = this.area('instruction')
    input.style.height = 'auto'
    input.style.height = `${Math.min(180, Math.max(48, input.scrollHeight))}px`
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
      this.resizeComposer()
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
  destroy(): void {
    this.cancel(); this.disposed = true; this.finishExit?.(null); this.unsubscribe()
    const nav = this.options.navigation, home = this.navigationHome
    home.parent.insertBefore(nav, home.next)
    nav.id = home.id; nav.hidden = home.hidden
    if (home.label === null) nav.removeAttribute('aria-label'); else nav.setAttribute('aria-label', home.label)
    const close = nav.querySelector('[data-action="left"]')!
    if (home.buttonLabel === null) close.removeAttribute('aria-label'); else close.setAttribute('aria-label', home.buttonLabel)
    this.element.remove()
  }
}
