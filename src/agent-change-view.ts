import { diffPromptLines, type AgentBlockChange, type PromptDiffLine } from './agent-changes.js'

function contentDiff(change: AgentBlockChange): HTMLElement {
  const result = document.createElement('div')
  const before = change.before?.content ?? '', after = change.after?.content ?? ''
  if (before === after) { result.textContent = 'Prompt content unchanged.'; return result }
  const lines = diffPromptLines(before, after)
  const count = document.createElement('p')
  count.textContent = `${lines.filter(line => line.kind === 'add').length} lines added · ${lines.filter(line => line.kind === 'remove').length} removed`
  const scroller = document.createElement('div'), table = document.createElement('table'), caption = document.createElement('caption'), head = document.createElement('thead'), body = document.createElement('tbody')
  scroller.className = 'workshop-agent-diff-scroll'; table.className = 'workshop-agent-diff'
  caption.textContent = `Content changes for ${change.name}`
  const header = document.createElement('tr')
  for (const name of ['Before', 'After', 'Change', 'Content']) { const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = name; header.append(cell) }
  head.append(header); table.append(caption, head, body); scroller.append(table)
  const visible: Array<PromptDiffLine | number> = []
  for (let i = 0; i < lines.length;) {
    if (lines[i].kind !== 'equal') { visible.push(lines[i++]); continue }
    let end = i; while (end < lines.length && lines[end].kind === 'equal') end++
    if (end - i > 8) {
      const left = i === 0 ? 0 : 3, right = end === lines.length ? 0 : 3
      visible.push(...lines.slice(i, i + left), end - i - left - right, ...lines.slice(end - right, end))
    } else visible.push(...lines.slice(i, end))
    i = end
  }
  let shown = 0
  const more = document.createElement('button'); more.type = 'button'; more.className = 'workshop-text-button'
  const append = (all = false) => {
    const end = all ? visible.length : Math.min(500, visible.length)
    for (; shown < end; shown++) {
      const line = visible[shown], row = document.createElement('tr')
      if (typeof line === 'number') { const cell = document.createElement('td'); cell.colSpan = 4; cell.textContent = `${line} unchanged lines`; row.className = 'diff-gap'; row.append(cell) }
      else {
        row.className = `diff-${line.kind}`
        for (const value of [line.before ?? '', line.after ?? '', line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' ', line.text]) {
          const cell = document.createElement('td'); cell.textContent = String(value); row.append(cell)
        }
      }
      body.append(row)
    }
    more.hidden = shown === visible.length
    more.textContent = `Show remaining ${visible.length - shown} diff lines for ${change.name}`
  }
  append(); more.addEventListener('click', () => { append(true); table.focus() })
  table.tabIndex = -1; result.append(count, scroller, more)
  return result
}

export function renderAgentChanges(changes: AgentBlockChange[], primaryId: string, open: (id: string) => void): HTMLElement {
  const card = document.createElement('section'); card.className = 'workshop-agent-changes'; card.setAttribute('aria-label', 'Draft changes')
  const heading = document.createElement('h3'); heading.textContent = `Draft changes (${changes.length})`
  const copy = document.createElement('p'); copy.textContent = 'Changes from this run. Review the draft before Apply.'
  card.append(heading, copy)
  for (const change of [...changes.filter(change => change.id === primaryId), ...changes.filter(change => change.id !== primaryId)]) {
    const detail = document.createElement('details'), summary = document.createElement('summary'), fields = document.createElement('dl')
    summary.textContent = `${change.kind[0].toUpperCase() + change.kind.slice(1)} · ${change.name}`
    for (const field of change.fields.filter(field => !['Category', 'Order'].includes(field.name))) {
      const row = document.createElement('div'), key = document.createElement('dt'), value = document.createElement('dd')
      key.textContent = field.name; value.textContent = `${field.before} → ${field.after}`; row.append(key, value); fields.append(row)
    }
    detail.append(summary)
    const placement = document.createElement('p')
    placement.className = 'workshop-agent-change-placement'
    placement.textContent = change.fields.filter(field => ['Category', 'Order'].includes(field.name)).map(field => `${field.name}: ${field.before} → ${field.after}`).join(' · ')
    if (placement.textContent) detail.append(placement)
    if (fields.children.length) {
      const settings = document.createElement('details'), settingsSummary = document.createElement('summary')
      settings.className = 'workshop-agent-change-settings'; settingsSummary.textContent = `Settings changes (${fields.children.length})`
      settings.append(settingsSummary, fields); settings.open = change.before?.content === change.after?.content; detail.append(settings)
    }
    if (change.after) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'workshop-text-button'; button.textContent = `Open prompt: ${change.name}`
      button.addEventListener('click', () => open(change.id)); detail.append(button)
    }
    let rendered = false
    detail.addEventListener('toggle', () => { if (detail.open && !rendered) { rendered = true; detail.append(contentDiff(change)) } })
    card.append(detail)
    if (change.id === primaryId && (change.before?.content.length ?? 0) + (change.after?.content.length ?? 0) < 20000) detail.open = true
  }
  return card
}
