import type { PromptBlockDTO } from 'lumiverse-spindle-types'
import { computePromptGroups } from './workshop-core.js'

export interface AgentBlockChange {
  id: string
  name: string
  kind: 'added' | 'edited' | 'reordered' | 'removed'
  before: PromptBlockDTO | null
  after: PromptBlockDTO | null
  fields: Array<{ name: string; before: string; after: string }>
}
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)])) : value
const same = (a: unknown, b: unknown) => JSON.stringify(stable(a)) === JSON.stringify(stable(b))
const display = (value: unknown): string => value === undefined || value === null ? '—' : typeof value === 'string' ? value : JSON.stringify(stable(value))

/** Minimal reorder set among surviving IDs; insertion/deletion alone never marks neighbours moved. */
function reorderedIds(before: PromptBlockDTO[], after: PromptBlockDTO[]): Set<string> {
  const old = new Map(before.map((b, i) => [b.id, i]))
  const common = after.filter(b => old.has(b.id))
  const tails: number[] = [], parents: number[] = []
  common.forEach((block, i) => {
    let lo = 0, hi = tails.length
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (old.get(common[tails[mid]].id)! < old.get(block.id)!) lo = mid + 1; else hi = mid }
    parents[i] = lo ? tails[lo - 1] : -1; tails[lo] = i
  })
  const kept = new Set<string>()
  for (let i = tails.at(-1) ?? -1; i >= 0; i = parents[i]) kept.add(common[i].id)
  return new Set(common.filter(b => !kept.has(b.id)).map(b => b.id))
}

/** Derive review data from real snapshots, never from the model's claimed edits. */
export function agentBlockChanges(before: PromptBlockDTO[], after: PromptBlockDTO[]): AgentBlockChange[] {
  const unique = (blocks: PromptBlockDTO[]) => blocks.filter(b => blocks.filter(other => other.id === b.id).length === 1)
  const oldBlocks = unique(before), newBlocks = unique(after)
  const old = new Map(oldBlocks.map(b => [b.id, b])), next = new Map(newBlocks.map(b => [b.id, b]))
  const moved = reorderedIds(oldBlocks, newBlocks)
  const categories = (blocks: PromptBlockDTO[]) => new Map(computePromptGroups(blocks).flatMap(group => group.children.map(b => [b.id, group.categoryBlock?.name ?? 'Ungrouped'] as const)))
  const oldCategories = categories(before), newCategories = categories(after)
  const categoryLabel = (block: PromptBlockDTO | undefined, names: Map<string, string>) => !block ? '—' : `${names.get(block.id) ?? '—'}${block.group === undefined ? ' (inherited)' : ''}`
  const labels: Record<string, string> = { name: 'Name', role: 'Role', depth: 'Depth', enabled: 'Enabled', position: 'Injection position', isLocked: 'Locked' }
  const changes: AgentBlockChange[] = []
  for (const id of [...newBlocks.map(b => b.id), ...oldBlocks.filter(b => !next.has(b.id)).map(b => b.id)]) {
    // Ambiguous identities elsewhere in the preset cannot masquerade as added/removed blocks.
    if (before.filter(b => b.id === id).length > 1 || after.filter(b => b.id === id).length > 1) continue
    const a = old.get(id), b = next.get(id)
    if (a && b && same(a, b) && !moved.has(id)) continue
    const fields: AgentBlockChange['fields'] = []
    for (const key of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
      if (['id', 'content', 'group'].includes(key) || ((!a || !b) && !['name', 'role', 'depth', 'enabled', 'position', 'variables'].includes(key))) continue
      const av = a ? (a as unknown as Record<string, unknown>)[key] : undefined
      const bv = b ? (b as unknown as Record<string, unknown>)[key] : undefined
      if (!same(av, bv)) fields.push({ name: labels[key] ?? key, before: display(av), after: display(bv) })
    }
    if (!a || !b || !same(a.group, b.group) || oldCategories.get(id) !== newCategories.get(id)) fields.push({ name: 'Category', before: categoryLabel(a, oldCategories), after: categoryLabel(b, newCategories) })
    if (!a || !b || moved.has(id)) fields.push({ name: 'Order', before: a ? `#${before.indexOf(a) + 1}` : '—', after: b ? `#${after.indexOf(b) + 1}` : '—' })
    changes.push({ id, name: b?.name ?? a!.name, kind: !a ? 'added' : !b ? 'removed' : !same(a, b) ? 'edited' : 'reordered',
      before: a ? structuredClone(a) : null, after: b ? structuredClone(b) : null, fields })
  }
  return changes
}

export interface PromptDiffLine { kind: 'equal' | 'add' | 'remove'; text: string; before: number | null; after: number | null }
/** Trim common edges before bounded LCS. Large changed regions use an honest whole-region replacement. */
export function diffPromptLines(before: string, after: string): PromptDiffLine[] {
  const a = before ? before.split('\n') : [], b = after ? after.split('\n') : []
  let prefix = 0, suffix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++
  const aa = a.slice(prefix, a.length - suffix), bb = b.slice(prefix, b.length - suffix)
  const operations: Array<{ kind: PromptDiffLine['kind']; text: string }> = a.slice(0, prefix).map(text => ({ kind: 'equal', text }))
  if (aa.length * bb.length <= 250000) {
    const width = bb.length + 1, grid = new Uint32Array((aa.length + 1) * width)
    for (let i = aa.length - 1; i >= 0; i--) for (let j = bb.length - 1; j >= 0; j--) grid[i * width + j] = aa[i] === bb[j] ? 1 + grid[(i + 1) * width + j + 1] : Math.max(grid[(i + 1) * width + j], grid[i * width + j + 1])
    let i = 0, j = 0
    while (i < aa.length || j < bb.length) {
      if (i < aa.length && j < bb.length && aa[i] === bb[j]) { operations.push({ kind: 'equal', text: aa[i++] }); j++ }
      else if (i < aa.length && (j === bb.length || grid[(i + 1) * width + j] >= grid[i * width + j + 1])) operations.push({ kind: 'remove', text: aa[i++] })
      else operations.push({ kind: 'add', text: bb[j++] })
    }
  } else { for (const text of aa) operations.push({ kind: 'remove', text }); for (const text of bb) operations.push({ kind: 'add', text }) }
  for (const text of a.slice(a.length - suffix)) operations.push({ kind: 'equal', text })
  let oldLine = 0, newLine = 0
  return operations.map(line => ({ ...line, before: line.kind === 'add' ? null : ++oldLine, after: line.kind === 'remove' ? null : ++newLine }))
}
