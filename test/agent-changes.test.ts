import { expect, test } from 'bun:test'
import type { PromptBlockDTO, SpindlePresetEditorDraft } from 'lumiverse-spindle-types'
import { AgentDraft } from '../src/agent-core.js'
import { agentBlockChanges, diffPromptLines } from '../src/agent-changes.js'
import { computePromptGroups } from '../src/workshop-core.js'

const block = (id: string, overrides: Partial<PromptBlockDTO> = {}): PromptBlockDTO => ({ id, name: id, content: 'Header\nBody\nFooter', role: 'system', enabled: true, position: 'pre_history', depth: 0, marker: null, isLocked: false, color: null, injectionTrigger: [], group: null, ...overrides })
const preset = (blocks: PromptBlockDTO[]): SpindlePresetEditorDraft => ({ id: 'p', name: 'Preset', blocks, parameters: {}, prompts: {}, metadata: {}, createdAt: 0, updatedAt: 0 })
const draft = (blocks: PromptBlockDTO[]) => new AgentDraft(preset(blocks), { values: {}, mocks: {}, preview: null, changes: [] })
const grouped = () => [block('A', { marker: 'category' }), block('a1', { group: undefined }), block('a2', { group: 'A' }), block('root'), block('B', { marker: 'category' }), block('b1', { group: 'B' })]
const membership = (blocks: PromptBlockDTO[]) => Object.fromEntries(computePromptGroups(blocks).flatMap(g => g.children.map(b => [b.name, g.categoryBlock?.name ?? null])))

test('insertion explicitly groups or inherits anchor membership without breaking neighbouring prompts', () => {
  const source = grouped(), agent = draft(source)
  agent.execute('preset_insert_block', { name: 'new', content: 'new', category: 'A' })
  agent.execute('preset_insert_block', { name: 'adjacent', content: 'adjacent', before: 'a2' })
  agent.execute('preset_insert_block', { name: 'first in B', content: 'first', after: 'B' })
  expect(membership(agent.snapshot().blocks)).toEqual({ a1: 'A', adjacent: 'A', a2: 'A', new: 'A', root: null, 'first in B': 'B', b1: 'B' })
  expect(agent.snapshot().blocks.find(b => b.name === 'adjacent')?.group).toBe('A')
  expect(source.map(b => b.name)).toEqual(['A', 'a1', 'a2', 'root', 'B', 'b1'])
})

test('moving can regroup an existing prompt, reorder within a category, or explicitly move to root', () => {
  const agent = draft(grouped())
  agent.execute('preset_move_block', { name: 'root', category: 'B' })
  agent.execute('preset_move_block', { name: 'a2', before: 'a1' })
  agent.execute('preset_move_block', { name: 'b1', category: '' })
  expect(agent.snapshot().blocks.map(b => b.name)).toEqual(['A', 'a2', 'a1', 'B', 'root', 'b1'])
  expect(membership(agent.snapshot().blocks)).toEqual({ a2: 'A', a1: 'A', root: 'B', b1: null })
})

test('invalid category targets and splitting placements fail without partial mutation', () => {
  const agent = draft(grouped()), before = agent.snapshot()
  for (const args of [
    { category: 'missing' }, { category: 'a1' }, { category: 'A', after: 'b1' },
    { category: '', before: 'a2' }, { category: 'A', before: 'A' }, { after: '' },
  ]) expect(() => agent.execute('preset_insert_block', { name: 'new', content: 'new', ...args })).toThrow()
  expect(agent.snapshot()).toEqual(before)
  const locked = grouped(); locked[0].isLocked = true
  expect(() => draft(locked).execute('preset_insert_block', { name: 'new', content: '', category: 'A' })).toThrow(/Locked/)
  expect(() => draft(locked).execute('preset_move_block', { name: 'a1', category: '' })).toThrow(/Locked/)
  const ambiguous = grouped(); ambiguous[4].name = 'A'
  expect(() => draft(ambiguous).execute('preset_insert_block', { name: 'new', content: '', category: 'A' })).toThrow(/ambiguous/)
  // Removing this explicit breakout would silently attach a legacy ungrouped neighbour to A.
  const legacy = draft([block('A', { marker: 'category' }), block('breakout'), block('legacy root', { group: undefined })])
  const original = legacy.snapshot()
  expect(() => legacy.execute('preset_move_block', { name: 'breakout', after: 'legacy root' })).toThrow(/regroup other prompts/)
  expect(legacy.snapshot()).toEqual(original)
})

test('snapshot review identifies adds, removals, edits, category and role changes without shifted-neighbour noise', () => {
  const before = grouped(), after = structuredClone(before)
  after[1].content = 'Header\nChanged\nFooter'; after[1].role = 'assistant_append'; after[1].depth = 2
  after.splice(3, 1); after.splice(2, 0, block('added', { group: 'A' }))
  const changes = agentBlockChanges(before, after)
  expect(changes.map(c => [c.id, c.kind])).toEqual([['a1', 'edited'], ['added', 'added'], ['root', 'removed']])
  expect(changes[0].fields).toContainEqual({ name: 'Role', before: 'system', after: 'assistant_append' })
  expect(changes[1].fields).toContainEqual({ name: 'Category', before: '—', after: 'A' })
  after[1].content = 'Later caller mutation'
  expect(changes[0].after?.content).toBe('Header\nChanged\nFooter')
  expect(agentBlockChanges(before, structuredClone(before))).toEqual([])
  const explicit = structuredClone(before); explicit[1].group = 'A'
  expect(agentBlockChanges(before, explicit)[0].fields).toContainEqual({ name: 'Category', before: 'A (inherited)', after: 'A' })
})

test('review detects reorder-only and metadata-only changes, and ignores unrelated ambiguous IDs', () => {
  const before = [block('one'), block('two'), block('three')]
  expect(agentBlockChanges(before, [before[2], before[0], before[1]]).map(c => [c.id, c.kind])).toEqual([['three', 'reordered']])
  const after = structuredClone(before); after[1].enabled = false
  expect(agentBlockChanges(before, after)[0].fields).toEqual([{ name: 'Enabled', before: 'true', after: 'false' }])
  expect(agentBlockChanges([block('dupe'), block('dupe'), ...before], [block('dupe'), block('dupe'), ...after]).map(c => c.id)).toEqual(['two'])
})

test('content diffs preserve both complete texts, line numbers, empty content and repeated lines', () => {
  for (const [before, after] of [['', 'new'], ['old', ''], ['a\nb\nc', 'a\nnew\nc'], ['a\nx\na\n', 'a\na\nx\n'], ['a\r\n', 'a\n']]) {
    const rows = diffPromptLines(before, after)
    expect(rows.filter(r => r.kind !== 'add').map(r => r.text).join('\n')).toBe(before)
    expect(rows.filter(r => r.kind !== 'remove').map(r => r.text).join('\n')).toBe(after)
    expect(rows.filter(r => r.before !== null).map(r => r.before)).toEqual(rows.filter(r => r.kind !== 'add').map((_, i) => i + 1))
  }
  expect(diffPromptLines('a\nb\nc', 'a\nnew\nc').map(r => r.kind)).toEqual(['equal', 'remove', 'add', 'equal'])
  const before = Array.from({ length: 1000 }, (_, i) => `old ${i}`).join('\n'), after = before.replaceAll('old', 'new')
  const rows = diffPromptLines(before, after)
  expect(rows.filter(r => r.kind === 'remove').map(r => r.text).join('\n')).toBe(before)
  expect(rows.filter(r => r.kind === 'add').map(r => r.text).join('\n')).toBe(after)
})
