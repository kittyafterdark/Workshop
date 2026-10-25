import type { PromptBlockDTO } from 'lumiverse-spindle-types'

export interface Replacement {
  before: PromptBlockDTO
  after: PromptBlockDTO
  count: number
}

/** Literal, non-overlapping content matches. Never mutate the supplied preset. */
export function previewReplacements(blocks: readonly PromptBlockDTO[], find: string, replacement: string): Replacement[] {
  if (!find || find === replacement) return []
  return blocks.flatMap(block => {
    if (block.isLocked) return []
    const parts = (block.content ?? '').split(find)
    if (parts.length === 1) return []
    return [{ before: structuredClone(block), after: { ...structuredClone(block), content: parts.join(replacement) }, count: parts.length - 1 }]
  })
}

export const FIND_REPLACE_CSS = `
.workshop-find-dialog { box-sizing: border-box; width: min(760px, calc(100vw - 24px)); max-height: calc(var(--app-interactive-viewport-height, 100dvh) - 24px); margin: auto; top: var(--app-interactive-safe-top, 0px); padding: 20px; border: 1px solid var(--lumiverse-border); border-radius: 12px; background: var(--lumiverse-bg, #17171e); color: var(--lumiverse-text); overflow: auto; }
.workshop-find-dialog::backdrop { background: rgba(0,0,0,.65); }
.workshop-find-dialog h2 { font-size: 18px; margin: 0 0 10px; }
.workshop-find-dialog p { color: var(--lumiverse-text-muted, #aaa); font-size: 12px; }
.workshop-find-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.workshop-find-fields label { display: grid; gap: 6px; font-size: 13px; }
.workshop-find-fields textarea { box-sizing: border-box; width: 100%; min-height: 80px; resize: vertical; padding: 8px; border: 1px solid var(--lumiverse-border); border-radius: 6px; background: var(--lumiverse-bg-deep, #101014); color: inherit; font: inherit; }
.workshop-find-results { list-style: none; padding: 0; max-height: 38vh; overflow: auto; }
.workshop-find-results li { margin-bottom: 8px; padding: 10px; border: 1px solid var(--lumiverse-border); border-radius: 6px; }
.workshop-find-results summary { cursor: pointer; overflow-wrap: anywhere; }
.workshop-find-results pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; max-height: 180px; overflow: auto; }
.workshop-find-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
@media (max-width: 600px) { .workshop-find-fields { grid-template-columns: 1fr; } .workshop-find-dialog { padding: 14px; } }
`

export function openFindReplace(
  root: HTMLElement,
  blocks: () => readonly PromptBlockDTO[],
  stage: (changes: Replacement[]) => string | null,
  onClose: () => void,
): () => void {
  const returnFocus = document.activeElement as HTMLElement | null
  const dialog = document.createElement('dialog')
  dialog.className = 'workshop-find-dialog'
  dialog.setAttribute('aria-label', 'Preset find and replace')
  dialog.innerHTML = `<h2>Preset find and replace</h2><p>Replace literal, case-sensitive text in prompt content across this preset, including disabled prompts. Locked prompts are excluded. Names and variable definitions stay unchanged.</p><div class="workshop-find-fields"><label>Find<textarea data-find="find" spellcheck="false"></textarea></label><label>Replace with<textarea data-find="replace" spellcheck="false"></textarea></label></div><p>Leave Replace with empty to remove matching text. Replacements stay local until you Apply in Workshop.</p><p data-find="status" role="status"></p><ul class="workshop-find-results" aria-label="Affected prompts"></ul><p data-find="error" role="alert"></p><div class="workshop-find-actions"><button type="button" class="workshop-text-button" data-find="refresh">Refresh preview</button><button type="button" class="workshop-text-button" data-find="cancel">Cancel</button><button type="button" class="workshop-text-button" data-find="stage" disabled>Replace all</button></div>`
  const find = dialog.querySelector<HTMLTextAreaElement>('[data-find="find"]')!
  const replacement = dialog.querySelector<HTMLTextAreaElement>('[data-find="replace"]')!
  const apply = dialog.querySelector<HTMLButtonElement>('[data-find="stage"]')!
  const error = dialog.querySelector<HTMLElement>('[data-find="error"]')!
  const list = dialog.querySelector<HTMLElement>('ul')!
  let changes: Replacement[] = []
  let closed = false
  const finish = () => {
    if (closed) return
    closed = true
    dialog.close()
    dialog.remove()
    onClose()
    if (returnFocus?.isConnected) returnFocus.focus()
  }
  const preview = () => {
    changes = previewReplacements(blocks(), find.value, replacement.value)
    const ambiguous = changes.some(change => blocks().filter(block => block.id === change.before.id).length !== 1)
    error.textContent = ambiguous ? 'Matching prompts have duplicate IDs. Repair their identities before replacing.' : ''
    apply.disabled = !changes.length || ambiguous
    const count = changes.reduce((sum, change) => sum + change.count, 0)
    dialog.querySelector<HTMLElement>('[data-find="status"]')!.textContent = !find.value ? 'Enter text to find.' : find.value === replacement.value ? 'Find and replacement text are identical.' : `${count} replacement${count === 1 ? '' : 's'} in ${changes.length} prompt${changes.length === 1 ? '' : 's'}.`
    list.replaceChildren()
    for (const change of changes) {
      const item = document.createElement('li')
      const details = document.createElement('details')
      const summary = document.createElement('summary')
      summary.textContent = `${change.before.name} — ${change.count} replacement${change.count === 1 ? '' : 's'}`
      details.append(summary)
      for (const [label, content] of [['Before', change.before.content], ['After', change.after.content]]) {
        const heading = document.createElement('h3')
        heading.textContent = label
        const text = document.createElement('pre')
        text.textContent = content
        details.append(heading, text)
      }
      item.append(details)
      list.append(item)
    }
  }
  find.addEventListener('input', preview)
  replacement.addEventListener('input', preview)
  dialog.querySelector('[data-find="refresh"]')!.addEventListener('click', preview)
  dialog.querySelector('[data-find="cancel"]')!.addEventListener('click', finish)
  apply.addEventListener('click', () => {
    const failure = stage(changes)
    if (failure) { error.textContent = failure; apply.disabled = true }
    else finish()
  })
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish() })
  dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation() })
  root.append(dialog)
  preview()
  dialog.showModal()
  find.focus()
  return finish
}
