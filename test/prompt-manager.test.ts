import { describe, expect, test } from 'bun:test'
import type { PromptBlockDTO } from 'lumiverse-spindle-types'
import { PromptManagerDraft, PROMPT_MARKERS } from '../src/prompt-manager-core.js'
import { computePromptGroups } from '../src/workshop-core.js'

const block = (id: string, extra: Partial<PromptBlockDTO> = {}): PromptBlockDTO => ({ id, name: id, content: `${id} content`,
  marker: null, role: 'system', enabled: true, position: 'pre_history', depth: 0, isLocked: false,
  color: null, injectionTrigger: [], group: null, ...extra })
const fixture = () => [block('root'), block('A', { marker: 'category' }), block('a1', { group: undefined }),
  block('a2', { group: 'A', enabled: false }), block('loose'), block('B', { marker: 'category', categoryMode: 'radio' }),
  block('b1', { group: undefined }), block('b2', { group: 'B' })]
const membership = (blocks: PromptBlockDTO[]) => Object.fromEntries(computePromptGroups(blocks).flatMap(group =>
  group.children.map(child => [child.id, group.categoryBlock?.id ?? null])))

describe('manual prompt structure drafts', () => {
  test('creates native prompt, category and supported marker defaults without mutating caller state', () => {
    const source = fixture(), original = structuredClone(source), draft = new PromptManagerDraft(source)
    const id = draft.add('prompt', 'New prompt', 'A')
    expect(membership(draft.snapshot())).toEqual({ ...membership(source), [id]: 'A' })
    expect(draft.snapshot().find(b => b.id === id)).toMatchObject({ name: 'New prompt', content: '', marker: null, isLocked: false, group: 'A' })
    const category = draft.add('category', 'New category', null)
    const history = draft.add('marker', 'History', category, 'chat_history')
    expect(draft.snapshot().find(b => b.id === history)).toMatchObject({ marker: 'chat_history', isLocked: true, content: '', group: category })
    draft.moveTo(history, null)
    draft.remove(history)
    expect(source).toEqual(original)
    const snapshot = draft.snapshot(); snapshot[0].content = 'caller changed clone'
    expect(draft.snapshot()[0].content).toBe('root content')
    expect(PROMPT_MARKERS).toHaveLength(12)
  })
  test('reorders within a category, moves across categories and to root without regrouping neighbours', () => {
    const source = fixture(), draft = new PromptManagerDraft(source)
    draft.moveRelative('a2', 'a1', false)
    expect(draft.snapshot().map(b => b.id)).toEqual(['root', 'A', 'a2', 'a1', 'loose', 'B', 'b1', 'b2'])
    draft.moveTo('a1', 'B')
    draft.moveRelative('b1', 'A', true)
    draft.moveTo('a2', null)
    expect(membership(draft.snapshot())).toEqual({ root: null, a2: null, a1: 'B', loose: null, b1: 'A', b2: 'B' })
    for (const b of draft.snapshot()) expect(b.content).toBe(source.find(old => old.id === b.id)!.content)
  })
  test('moving a whole category includes its implicit children but excludes root breakouts', () => {
    const source = fixture(), draft = new PromptManagerDraft(source)
    draft.moveRelative('A', 'B', true)
    expect(draft.snapshot().map(b => b.id)).toEqual(['root', 'loose', 'B', 'b1', 'b2', 'A', 'a1', 'a2'])
    expect(membership(draft.snapshot())).toEqual(membership(source))
    expect(draft.snapshot().find(b => b.id === 'B')?.categoryMode).toBe('radio')
    expect(draft.stepTarget('A', -1)).toBe('B')
    expect(draft.stepTarget('a1', 1)).toBe('a2')
    expect(draft.stepTarget('a1', -1)).toBeNull()
  })
  test('category deletion keeps children ungrouped rather than absorbing them into a preceding category', () => {
    const draft = new PromptManagerDraft(fixture().filter(b => b.id !== 'loose'))
    draft.remove('B', 'keep')
    expect(membership(draft.snapshot())).toEqual({ root: null, a1: 'A', a2: 'A', b1: null, b2: null })
    expect(draft.snapshot().find(b => b.id === 'b1')!.content).toBe('b1 content')
    draft.remove('A', 'delete')
    expect(draft.snapshot().map(b => b.id)).toEqual(['root', 'b1', 'b2'])
  })
  test('removing an explicit root breakout preserves the remaining inherited root blocks', () => {
    const draft = new PromptManagerDraft([block('A', { marker: 'category' }), block('a', { group: 'A' }), block('root'), block('legacy', { group: undefined })])
    draft.remove('root')
    expect(membership(draft.snapshot())).toEqual({ a: 'A', legacy: null })
  })
  test('keyboard steps cross complete categories while preserving root and child memberships', () => {
    const source = fixture(), draft = new PromptManagerDraft(source)
    draft.step('root', 1)
    expect(draft.snapshot().map(b => b.id)).toEqual(['A', 'a1', 'a2', 'root', 'loose', 'B', 'b1', 'b2'])
    draft.step('loose', 1)
    expect(draft.snapshot().map(b => b.id)).toEqual(['A', 'a1', 'a2', 'root', 'B', 'b1', 'b2', 'loose'])
    draft.step('loose', -1)
    draft.step('root', -1)
    expect(draft.snapshot()).toEqual(source)
    expect(membership(draft.snapshot())).toEqual(membership(source))
  })
  test('invalid destinations, missing or duplicate identities and locks fail before mutation', () => {
    expect(() => new PromptManagerDraft([block('same'), block('same')])).toThrow(/duplicated/)
    const draft = new PromptManagerDraft(fixture()), original = draft.snapshot()
    for (const operation of [() => draft.add('prompt', '', null), () => draft.add('marker', 'Unknown', null, 'arbitrary'),
      () => draft.add('category', 'Nested', 'A'), () => draft.moveTo('a1', 'missing'),
      () => draft.moveTo('a1', 'root'), () => draft.moveRelative('A', 'b1', true),
      () => draft.moveRelative('A', 'a1', false), () => draft.remove('missing')]) {
      expect(operation).toThrow(); expect(draft.snapshot()).toEqual(original)
    }
    const locked = new PromptManagerDraft(fixture().map(b => b.id === 'a1' ? { ...b, isLocked: true } : b))
    const before = locked.snapshot()
    for (const operation of [() => locked.remove('a1'), () => locked.moveTo('a1', null), () => locked.remove('A', 'delete'),
      () => locked.remove('A', 'keep'), () => locked.moveRelative('A', 'B', true)]) {
      expect(operation).toThrow(/locked/i); expect(locked.snapshot()).toEqual(before)
    }
    const categoryLocked = new PromptManagerDraft(fixture().map(b => b.id === 'A' ? { ...b, isLocked: true } : b))
    expect(() => categoryLocked.add('prompt', 'New', 'A')).toThrow(/Locked/)
    expect(() => categoryLocked.moveTo('a1', 'B')).toThrow(/Locked/)
  })
  test('duplicate titles remain distinct by ID, and the list may be emptied and rebuilt', () => {
    const draft = new PromptManagerDraft([block('one', { name: 'same' }), block('two', { name: 'same' })])
    draft.moveRelative('two', 'one', false)
    expect(draft.snapshot().map(b => b.id)).toEqual(['two', 'one'])
    draft.remove('one'); draft.remove('two')
    expect(draft.snapshot()).toEqual([])
    draft.add('prompt', 'Rebuilt', null)
    expect(draft.snapshot()).toHaveLength(1)
  })
  test('bulk moves preserve preset order across mixed source categories and the destination', () => {
    const source = fixture(), draft = new PromptManagerDraft(source)
    draft.moveManyTo(['b2', 'a1', 'root'], 'B')
    expect(draft.snapshot().map(b => b.id)).toEqual(['A', 'a2', 'loose', 'B', 'b1', 'root', 'a1', 'b2'])
    expect(membership(draft.snapshot())).toEqual({ root: 'B', a1: 'B', a2: 'A', loose: null, b1: 'B', b2: 'B' })
    draft.moveManyTo(['b2', 'root', 'a1'], null)
    expect(draft.snapshot().map(b => b.id)).toEqual(['A', 'a2', 'loose', 'B', 'b1', 'root', 'a1', 'b2'])
    expect(membership(draft.snapshot())).toEqual({ root: null, a1: null, a2: 'A', loose: null, b1: 'B', b2: null })
    expect(source).toEqual(fixture())
  })
  test('moving a root breakout into its preceding category does not absorb inherited root neighbours', () => {
    const draft = new PromptManagerDraft([block('A', { marker: 'category' }), block('a', { group: 'A' }), block('root'), block('legacy', { group: undefined })])
    draft.moveManyTo(['root'], 'A')
    expect(draft.snapshot().map(b => b.id)).toEqual(['A', 'a', 'root', 'legacy'])
    expect(membership(draft.snapshot())).toEqual({ a: 'A', root: 'A', legacy: null })
  })
  test('bulk validation is atomic for a locked member, category, duplicate ID or invalid destination', () => {
    const draft = new PromptManagerDraft(fixture().map(b => b.id === 'b2' ? { ...b, isLocked: true } : b))
    const original = draft.snapshot()
    for (const operation of [() => draft.moveManyTo(['a1', 'b2'], 'B'), () => draft.moveManyTo(['a1', 'A'], 'B'),
      () => draft.moveManyTo(['a1', 'a1'], 'B'), () => draft.moveManyTo(['a1', 'missing'], 'B'),
      () => draft.moveManyTo(['a1', 'root'], 'missing')]) {
      expect(operation).toThrow(); expect(draft.snapshot()).toEqual(original)
    }
    draft.moveManyTo([], null)
    expect(draft.snapshot()).toEqual(original)
  })
})
