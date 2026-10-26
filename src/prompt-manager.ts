import type { PromptBlockDTO } from 'lumiverse-spindle-types'
import { computePromptGroups } from './workshop-core.js'
import { PROMPT_MARKERS, PromptManagerDraft, structureProtected } from './prompt-manager-core.js'

export const PROMPT_MANAGER_CSS = `
.workshop-manage { box-sizing:border-box; width:min(900px,calc(100vw - 24px)); height: min(780px,calc(var(--app-interactive-viewport-height,100dvh) - 24px)); max-height:calc(var(--app-interactive-viewport-height,100dvh) - 24px); top:var(--app-interactive-safe-top,0px); margin:auto; padding:18px; border:1px solid var(--lumiverse-border,#444); border-radius:12px; background:var(--lumiverse-bg,#17171e); color:var(--lumiverse-text,#eee); overflow:auto; }
.workshop-manage[open] { display:flex; flex-direction:column; gap:8px; }
.workshop-manage::backdrop { background:rgba(0,0,0,.65); }
.workshop-manage * { box-sizing:border-box; }
.workshop-manage h2 { margin:0; font-size:18px; }
.workshop-manage p { margin:0; font-size:12px; color:var(--lumiverse-text-muted,#aaa); line-height:1.5; }
.workshop-manage header,.workshop-manage footer,.workshop-manage-tools { display:flex; gap:8px; align-items:center; flex-wrap:wrap; flex-shrink:0; }
.workshop-manage header { justify-content:space-between; }
.workshop-manage footer { justify-content:flex-end; }
.workshop-manage [aria-label="Add items"] { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); }
.workshop-manage p:empty { display:none; }
.workshop-manage-search-row { display:flex; align-items:center; gap:10px; flex-shrink:0; }
.workshop-manage-search-row .workshop-manage-search { flex:1; width:0; }
.workshop-manage .workshop-manage-check { display:inline-flex; align-items:center; gap:6px; white-space:nowrap; }
.workshop-manage input[type=checkbox] { width:16px; height:16px; min-height:0; flex-shrink:0; padding:0; margin:0; accent-color:var(--lumiverse-primary,#a6a6ff); }
.workshop-manage button,.workshop-manage input,.workshop-manage select { font:inherit; font-size:12px; color:inherit; border:1px solid var(--lumiverse-border,#444); border-radius:6px; background:var(--lumiverse-bg-deep,#101014); padding:8px 10px; min-height:36px; min-width:0; }
.workshop-manage button { cursor:pointer; }
.workshop-manage button:disabled { opacity:.45; cursor:default; }
.workshop-manage :focus-visible { outline:2px solid var(--lumiverse-primary,#a6a6ff); outline-offset:2px; }
.workshop-manage .primary { background:var(--lumiverse-primary-020,#30304b); border-color:var(--lumiverse-primary,#a6a6ff); }
.workshop-manage .danger { color:var(--lumiverse-danger,#ffb4b4); }
.workshop-manage label { display:grid; gap:5px; min-width:0; font-size:12px; }
.workshop-manage form { display:flex; flex-wrap:wrap; gap:8px; align-items:end; padding:12px; border:1px solid var(--lumiverse-border,#444); border-radius:8px; flex-shrink:0; }
.workshop-manage form label { flex:1 1 140px; }
.workshop-manage form[hidden],.workshop-manage [hidden] { display:none!important; }
.workshop-manage-search { width:100%; flex-shrink:0; }
.workshop-manage-list { padding:0; margin:0; list-style:none; overflow:auto; flex:1; min-height:80px; overscroll-behavior:contain; border:1px solid var(--lumiverse-border,#444); border-radius:8px; }
.workshop-manage-row { display:flex; align-items:center; gap:6px; padding:0 6px; border-top:2px solid transparent; border-bottom:2px solid transparent; }
.workshop-manage-row.child { padding-left:30px; }
.workshop-manage-row.category { background:var(--lumiverse-fill-subtle,rgba(255,255,255,.05)); }
.workshop-manage-row.selected { background:var(--lumiverse-primary-010,rgba(130,130,255,.12)); }
.workshop-manage-row.drop-before { border-top-color:var(--lumiverse-primary,#a6a6ff); }
.workshop-manage-row.drop-after { border-bottom-color:var(--lumiverse-primary,#a6a6ff); }
.workshop-manage .workshop-manage-select { flex:1; text-align:left; display:flex; gap:8px; align-items:center; border-color:transparent; background:transparent; }
.workshop-manage-select span { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.workshop-manage-select small { font-size:10px; color:var(--lumiverse-text-muted,#aaa); flex-shrink:0; }
.workshop-manage .workshop-manage-grip { cursor:grab; border-color:transparent; background:transparent; touch-action:pan-y; }
.workshop-manage-root { padding:6px; text-align:center; font-size:11px; color:var(--lumiverse-text-muted,#aaa); border:1px dashed var(--lumiverse-border,#444); border-radius:6px; }
.workshop-manage-root.drop-after { border-color:var(--lumiverse-primary,#a6a6ff); }
.workshop-manage-selection { padding:8px 0 0; border-top:1px solid var(--lumiverse-border,#444); display:grid; gap:6px; flex-shrink:0; }
.workshop-manage-selection strong { font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.workshop-manage-selection [data-manage=move-label] { display:flex; align-items:center; gap:8px; flex:1; white-space:nowrap; }
.workshop-manage-selection select { flex:1; width:0; }
.workshop-manage-confirm { display:grid; gap:8px; border-top:1px solid var(--lumiverse-border,#444); padding-top:10px; }
.workshop-manage [role=alert] { color:var(--lumiverse-warning,#e8b04c); }
@media(max-width:600px) { .workshop-manage { padding:12px; gap:8px; } .workshop-manage[open] { gap:8px; } .workshop-manage button { min-height:44px; } .workshop-manage-row { padding-inline:3px; } .workshop-manage-row.child { padding-left:16px; } .workshop-manage-selection .workshop-manage-tools { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); } .workshop-manage [data-manage=move-label] { grid-column:1/-1; } .workshop-manage-selection select { width:0; } .workshop-manage-search-row { flex-wrap:wrap; gap:6px 10px; } .workshop-manage-search-row .workshop-manage-search { flex-basis:100%; width:100%; } .workshop-manage-search-row [data-manage=clear-selection] { margin-left:auto; } .workshop-manage form { max-height:35vh; overflow:auto; } }
`

export function openPromptManager(
  root: HTMLElement,
  blocks: readonly PromptBlockDTO[],
  stage: (blocks: PromptBlockDTO[], createdId: string | null) => string | null,
  onClose: () => void,
): () => void {
  const model = new PromptManagerDraft(blocks)
  const baseline = JSON.stringify(blocks)
  const returnFocus = document.activeElement as HTMLElement | null
  const dialog = document.createElement('dialog')
  dialog.className = 'workshop-manage'
  const headingId = `workshop-manage-${crypto.randomUUID()}`
  dialog.setAttribute('aria-labelledby', headingId)
  dialog.innerHTML = `<header><h2>Manage prompts</h2><span data-manage="count"></span></header>
    <p>Add, organize, or delete items. Drag by the handle, select a title to organize it, or check multiple prompts to move them together. Done keeps changes local until Apply in Workshop.</p>
    <div class="workshop-manage-tools" role="group" aria-label="Add items"><button type="button" data-add="prompt">Add prompt</button><button type="button" data-add="marker">Add marker</button><button type="button" data-add="category">Add category</button></div>
    <form hidden><label>Title<input name="title" required maxlength="500" autocomplete="off"></label><label data-manage="marker-label" hidden>Marker type<select name="marker"></select></label><label data-manage="category-label">Category<select name="category"></select></label><button type="submit" class="primary">Add</button><button type="button" data-manage="cancel-add">Cancel add</button></form>
    <div class="workshop-manage-search-row"><input type="search" class="workshop-manage-search" aria-label="Search prompt titles" placeholder="Search titles…"><label class="workshop-manage-check"><input type="checkbox" data-manage="select-visible">Select visible prompts</label><button type="button" data-manage="clear-selection" disabled>Clear selection</button></div>
    <ul class="workshop-manage-list" aria-label="Prompt order"></ul>
    <div class="workshop-manage-root" data-manage="root-drop">Ungrouped · drop here to move to the end</div>
    <section class="workshop-manage-selection" aria-label="Selected item" hidden><strong data-manage="selected-title"></strong><div class="workshop-manage-tools"><button type="button" data-manage="up">Move up</button><button type="button" data-manage="down">Move down</button><label data-manage="move-label">Move to<select data-manage="destination"></select></label><button type="button" data-manage="move">Move</button><button type="button" class="danger" data-manage="delete">Delete</button></div>
    <div class="workshop-manage-confirm" hidden><p data-manage="delete-copy"></p><div class="workshop-manage-tools"><button type="button" data-manage="keep">Keep prompts ungrouped</button><button type="button" class="danger" data-manage="remove">Delete item</button><button type="button" data-manage="cancel-delete">Cancel deletion</button></div></div></section>
    <p data-manage="status" role="status"></p><p data-manage="error" role="alert"></p>
    <footer><button type="button" data-manage="cancel">Cancel</button><button type="button" class="primary" data-manage="done">Done</button></footer>`
  dialog.querySelector('h2')!.id = headingId
  const el = <T extends HTMLElement = HTMLElement>(name: string) => dialog.querySelector<T>(`[data-manage="${name}"]`)!
  const button = (name: string) => el<HTMLButtonElement>(name)
  const list = dialog.querySelector<HTMLUListElement>('ul')!
  const search = dialog.querySelector<HTMLInputElement>('input[type=search]')!
  const form = dialog.querySelector<HTMLFormElement>('form')!
  form.id = `${headingId}-add`
  const confirmation = dialog.querySelector<HTMLElement>('.workshop-manage-confirm')!
  confirmation.id = `${headingId}-delete`
  button('delete').setAttribute('aria-controls', confirmation.id)
  const title = form.elements.namedItem('title') as HTMLInputElement
  const marker = form.elements.namedItem('marker') as HTMLSelectElement
  const parent = form.elements.namedItem('category') as HTMLSelectElement
  let kind: 'prompt' | 'category' | 'marker' = 'prompt'
  let selectedId: string | null = null, createdId: string | null = null, dragId: string | null = null
  const checked = new Set<string>()
  let visibleSelectable: string[] = []
  let closed = false
  const selected = () => model.snapshot().find(block => block.id === selectedId)
  const finish = () => {
    if (closed) return
    closed = true
    dialog.close(); dialog.remove(); onClose()
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
  }
  const run = (operation: () => void, message: string) => {
    try { operation(); el('error').textContent = ''; render(); el('status').textContent = message }
    catch (error) { el('error').textContent = error instanceof Error ? error.message : 'Could not change the prompt list.' }
  }
  const categories = (select: HTMLSelectElement, value: string) => {
    select.replaceChildren(new Option('Ungrouped', ''))
    for (const block of model.snapshot().filter(block => block.marker === 'category')) {
      const option = new Option(block.name || '(Untitled category)', block.id)
      option.disabled = structureProtected(block)
      select.add(option)
    }
    select.value = value
    if (select.selectedIndex === -1) select.value = ''
  }
  const renderSelection = () => {
    const block = selected()
    el('selected-title').textContent = checked.size ? `${checked.size} prompts selected` : block?.name || '(Untitled item)'
    dialog.querySelector<HTMLElement>('.workshop-manage-selection')!.hidden = (!block && !checked.size) || !form.hidden
    confirmation.hidden = true
    button('delete').setAttribute('aria-expanded', 'false')
    const bulk = checked.size > 0
    for (const name of ['up', 'down', 'delete']) button(name).hidden = bulk
    button('move').textContent = bulk ? 'Move selected' : 'Move'
    if (bulk) {
      el('move-label').hidden = button('move').hidden = false
      button('move').disabled = el<HTMLSelectElement>('destination').disabled = false
      const parents = new Set(computePromptGroups(model.snapshot()).flatMap(group => group.children.filter(child => checked.has(child.id)).map(() => group.categoryBlock?.id ?? '')))
      categories(el<HTMLSelectElement>('destination'), parents.size === 1 ? [...parents][0] : '')
      return
    }
    if (!block) return
    const group = computePromptGroups(model.snapshot()).find(group => group.children.some(child => child.id === block.id))
    const protectedItem = structureProtected(block) || Boolean(group?.categoryBlock && structureProtected(group.categoryBlock))
    button('up').disabled = protectedItem || !model.stepTarget(block.id, -1)
    button('down').disabled = protectedItem || !model.stepTarget(block.id, 1)
    for (const name of ['up', 'down', 'delete']) button(name).setAttribute('aria-label', `${name === 'up' ? 'Move up' : name === 'down' ? 'Move down' : 'Delete'} ${block.name || 'untitled item'}`)
    button('delete').disabled = protectedItem
    el('move-label').hidden = button('move').hidden = block.marker === 'category'
    button('move').disabled = protectedItem
    el<HTMLSelectElement>('destination').disabled = protectedItem
    categories(el<HTMLSelectElement>('destination'), group?.categoryBlock?.id ?? '')
  }
  const clearDrop = () => dialog.querySelectorAll('.drop-before,.drop-after').forEach(row => row.classList.remove('drop-before', 'drop-after'))
  const render = () => {
    const scroll = list.scrollTop
    const all = model.snapshot(), query = search.value.trim().toLowerCase()
    const groups = computePromptGroups(all)
    list.replaceChildren()
    for (const id of checked) if (!all.some(block => block.id === id)) checked.delete(id)
    visibleSelectable = []
    let count = 0
    for (const group of groups) {
      const categoryMatches = group.categoryBlock?.name.toLowerCase().includes(query)
      const children = query && !categoryMatches ? group.children.filter(block => block.name.toLowerCase().includes(query)) : group.children
      if (query && !categoryMatches && !children.length) continue
      for (const block of [...(group.categoryBlock ? [group.categoryBlock] : []), ...children]) {
        count++
        const row = document.createElement('li')
        const child = block.marker !== 'category' && Boolean(group.categoryBlock)
        row.className = `workshop-manage-row${child ? ' child' : ''}${block.marker === 'category' ? ' category' : ''}${selectedId === block.id || checked.has(block.id) ? ' selected' : ''}`
        row.dataset.manageId = block.id
        const grip = document.createElement('button')
        grip.type = 'button'; grip.className = 'workshop-manage-grip'; grip.textContent = '⠿'
        grip.setAttribute('aria-label', `Reorder ${block.name || 'untitled item'}`)
        grip.disabled = structureProtected(block) || Boolean(child && group.categoryBlock && structureProtected(group.categoryBlock)) || Boolean(query) || checked.size > 0
        grip.draggable = !grip.disabled
        grip.addEventListener('dragstart', event => {
          dragId = block.id
          if (event.dataTransfer) { event.dataTransfer.setData('text/plain', block.id); event.dataTransfer.effectAllowed = 'move' }
        })
        grip.addEventListener('dragend', () => { dragId = null; clearDrop() })
        grip.addEventListener('click', () => {
          selectedId = block.id; render()
          const action = !button('up').disabled ? button('up') : !button('down').disabled ? button('down') : !button('move').hidden && !button('move').disabled ? button('move') : null
          if (action) action.focus()
          else list.querySelector<HTMLButtonElement>(`[data-manage-id="${CSS.escape(block.id)}"] .workshop-manage-select`)?.focus()
        })
        row.addEventListener('dragover', event => {
          if (!dragId || query) return
          event.preventDefault(); clearDrop()
          row.classList.add(event.clientY > row.getBoundingClientRect().top + row.clientHeight / 2 ? 'drop-after' : 'drop-before')
          const bounds = list.getBoundingClientRect()
          if (event.clientY < bounds.top + 40) list.scrollTop -= 24
          if (event.clientY > bounds.bottom - 40) list.scrollTop += 24
        })
        row.addEventListener('drop', event => {
          if (!dragId || query) return
          event.preventDefault()
          const id = dragId, after = event.clientY > row.getBoundingClientRect().top + row.clientHeight / 2
          dragId = null; clearDrop(); selectedId = id
          run(() => model.moveRelative(id, block.id, after), 'Item moved. Changes are local.')
        })
        const select = document.createElement('button')
        select.type = 'button'; select.className = 'workshop-manage-select'
        select.setAttribute('aria-pressed', String(block.id === selectedId))
        const duplicate = all.filter(item => item.name === block.name).length > 1
        select.setAttribute('aria-label', `Select ${block.name || 'untitled item'}${duplicate ? `, item ${all.findIndex(item => item.id === block.id) + 1}` : ''}`)
        const name = document.createElement('span'); name.textContent = block.name || '(Untitled item)'; name.title = name.textContent
        const badge = document.createElement('small')
        badge.textContent = `${block.marker === 'category' ? 'Category' : block.marker ? 'Marker' : 'Prompt'}${block.isLocked ? ' · Locked' : ''}${!block.enabled ? ' · Off' : ''}`
        select.append(name, badge)
        select.addEventListener('click', () => {
          selectedId = block.id
          render()
          list.querySelector<HTMLButtonElement>(`[data-manage-id="${CSS.escape(block.id)}"] .workshop-manage-select`)?.focus({ preventScroll: true })
        })
        if (block.marker !== 'category') {
          const checkbox = document.createElement('input')
          checkbox.type = 'checkbox'
          checkbox.dataset.checkId = block.id
          const suffix = duplicate ? `, item ${all.findIndex(item => item.id === block.id) + 1}` : ''
          checkbox.setAttribute('aria-label', `Include ${block.name || 'untitled prompt'}${suffix} in move`)
          checkbox.checked = checked.has(block.id)
          checkbox.disabled = structureProtected(block) || Boolean(group.categoryBlock && structureProtected(group.categoryBlock))
          if (!checkbox.disabled) visibleSelectable.push(block.id)
          checkbox.addEventListener('change', () => {
            if (checkbox.checked) checked.add(block.id)
            else checked.delete(block.id)
            selectedId = block.id
            render()
            list.querySelector<HTMLInputElement>(`[data-check-id="${CSS.escape(block.id)}"]`)?.focus({ preventScroll: true })
          })
          row.append(checkbox)
        }
        row.append(grip, select); list.append(row)
      }
    }
    if (!count) { const empty = document.createElement('li'); empty.className = 'workshop-manage-row'; empty.textContent = query ? 'No matching titles.' : 'No prompts yet. Add a prompt, marker, or category.'; list.append(empty) }
    const selectVisible = el<HTMLInputElement>('select-visible')
    const visibleChecked = visibleSelectable.filter(id => checked.has(id)).length
    selectVisible.disabled = !visibleSelectable.length
    selectVisible.checked = visibleChecked > 0 && visibleChecked === visibleSelectable.length
    selectVisible.indeterminate = visibleChecked > 0 && visibleChecked < visibleSelectable.length
    button('clear-selection').disabled = !checked.size
    el('count').textContent = `${all.length} items`
    el('root-drop').hidden = Boolean(query)
    list.scrollTop = scroll
    renderSelection()
    categories(parent, parent.value)
  }
  for (const [id, label] of PROMPT_MARKERS) marker.add(new Option(label, id))
  const addButtons = dialog.querySelectorAll<HTMLButtonElement>('[data-add]')
  const hideForm = () => { form.hidden = true; addButtons.forEach(add => add.setAttribute('aria-expanded', 'false')) }
  addButtons.forEach(add => {
    add.setAttribute('aria-controls', form.id)
    add.setAttribute('aria-expanded', 'false')
    add.addEventListener('click', () => {
    kind = add.dataset.add as typeof kind
    form.hidden = false
    addButtons.forEach(button => button.setAttribute('aria-expanded', String(button === add)))
    el('marker-label').hidden = kind !== 'marker'
    el('category-label').hidden = kind === 'category'
    title.value = kind === 'marker' ? marker.selectedOptions[0].text : ''
    const group = computePromptGroups(model.snapshot()).find(group => group.categoryBlock?.id === selectedId || group.children.some(child => child.id === selectedId))
    categories(parent, group?.categoryBlock?.id ?? '')
    renderSelection()
    title.focus()
    })
  })
  marker.addEventListener('change', () => { title.value = marker.selectedOptions[0].text })
  button('cancel-add').addEventListener('click', () => { hideForm(); renderSelection(); dialog.querySelector<HTMLButtonElement>(`[data-add="${kind}"]`)!.focus() })
  form.addEventListener('submit', event => {
    event.preventDefault()
    run(() => {
      selectedId = createdId = model.add(kind, title.value, kind === 'category' ? null : parent.value || null, marker.value)
      hideForm(); search.value = ''
    }, 'Item added. Choose Done to keep it in Workshop.')
    if (form.hidden) { button('done').focus(); list.querySelector(`[data-manage-id="${CSS.escape(selectedId!)}"]`)?.scrollIntoView({ block: 'nearest' }) }
  })
  search.addEventListener('input', render)
  el<HTMLInputElement>('select-visible').addEventListener('change', event => {
    const include = (event.target as HTMLInputElement).checked
    for (const id of visibleSelectable) { if (include) checked.add(id); else checked.delete(id) }
    render()
  })
  button('clear-selection').addEventListener('click', () => { checked.clear(); render(); if (el<HTMLInputElement>('select-visible').disabled) search.focus(); else el('select-visible').focus() })
  for (const [name, direction] of [['up', -1], ['down', 1]] as const) button(name).addEventListener('click', () => {
    run(() => { if (selectedId) model.step(selectedId, direction) }, 'Item moved. Changes are local.')
    if (button(name).disabled) {
      const other = button(name === 'up' ? 'down' : 'up')
      if (!other.disabled) other.focus()
      else list.querySelector<HTMLButtonElement>(`[data-manage-id="${CSS.escape(selectedId!)}"] .workshop-manage-select`)?.focus()
    }
    list.querySelector(`[data-manage-id="${CSS.escape(selectedId!)}"]`)?.scrollIntoView({ block: 'nearest' })
  })
  button('move').addEventListener('click', () => {
    const ids = checked.size ? [...checked] : selectedId ? [selectedId] : []
    run(() => model.moveManyTo(ids, el<HTMLSelectElement>('destination').value || null), `${ids.length} prompt${ids.length === 1 ? '' : 's'} moved. Changes are local.`)
  })
  button('delete').addEventListener('click', () => {
    const block = selected()
    if (!block) return
    const category = block.marker === 'category'
    const count = computePromptGroups(model.snapshot()).find(group => group.categoryBlock?.id === block.id)?.children.length ?? 0
    el('delete-copy').textContent = category ? `Delete “${block.name}”? Keep its ${count} prompts ungrouped, or delete them too.` : `Delete “${block.name}” from the prompt list?`
    button('keep').hidden = !category
    button('remove').textContent = category ? 'Delete category and prompts' : 'Delete item'
    confirmation.hidden = false
    button('delete').setAttribute('aria-expanded', 'true')
    button('cancel-delete').focus()
  })
  button('cancel-delete').addEventListener('click', () => { confirmation.hidden = true; button('delete').setAttribute('aria-expanded', 'false'); button('delete').focus() })
  for (const [name, mode] of [['keep', 'keep'], ['remove', 'delete']] as const) button(name).addEventListener('click', () => {
    run(() => { if (selectedId) model.remove(selectedId, mode); selectedId = null }, 'Item deleted locally. Choose Done to keep changes.')
    search.focus()
  })
  el('root-drop').addEventListener('dragover', event => { if (dragId && !search.value.trim()) { event.preventDefault(); clearDrop(); el('root-drop').classList.add('drop-after') } })
  el('root-drop').addEventListener('drop', event => {
    if (!dragId || search.value.trim()) return
    event.preventDefault()
    const id = dragId; dragId = null; clearDrop(); selectedId = id
    run(() => {
      const blocks = model.snapshot(), source = blocks.find(block => block.id === id)!
      if (source.marker !== 'category') model.moveTo(id, null)
      else {
        const last = computePromptGroups(blocks).flatMap(group => group.categoryBlock ? [group.categoryBlock] : group.children).at(-1)
        if (last) model.moveRelative(id, last.id, true)
      }
    }, 'Item moved to the end. Changes are local.')
  })
  button('cancel').addEventListener('click', finish)
  button('done').addEventListener('click', () => {
    const next = model.snapshot()
    if (JSON.stringify(next) === baseline) { finish(); return }
    const error = stage(next, next.some(block => block.id === createdId) ? createdId : null)
    if (error) el('error').textContent = error
    else finish()
  })
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish() })
  dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation() })
  root.append(dialog); render(); dialog.showModal(); search.focus()
  return finish
}
