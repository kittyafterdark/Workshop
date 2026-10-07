import { describe, expect, test } from 'bun:test'
import type { PromptBlockDTO } from 'lumiverse-spindle-types'
import { buildReviewIssues, WorkshopIssueReview } from '../src/workshop-core.js'

const block = (id: string, content: string): PromptBlockDTO => ({ id, name: id, content, role: 'system', enabled: true, position: 'pre_history', depth: 0, marker: null, isLocked: false, color: null, injectionTrigger: [], group: null })

describe('Issue review', () => {
  test('queues each affected prompt, duplicate owners, unused warnings and ambiguous identities', () => {
    const definition = { id: 'v', name: 'mode', label: 'Mode', type: 'text' as const, defaultValue: '' }
    const blocks = [{ ...block('one', '{{var::missing}} {{var::missing}}'), variables: [definition] }, { ...block('two', '{{var::missing}}'), variables: [definition] }, block('bad', ''), block('bad', '')]
    const issues = buildReviewIssues(blocks, {})
    expect(issues.map((issue) => [issue.blockId, issue.editable])).toEqual([['one', true], ['two', true], ['one', true], ['two', true], ['bad', false]])
    expect(new Set(issues.map((issue) => issue.key)).size).toBe(issues.length)
    expect(buildReviewIssues([{ ...block('unused', ''), variables: [definition] }], {})[0].title).toContain('Unused')
  })
  test('retains multiple local fixes and applies only touched prompts against fresh host data', () => {
    const host = [block('one', 'a'), block('two', 'b'), block('other', 'old')]
    const review = new WorkshopIssueReview()
    const first = [block('one', 'fixed a'), block('two', 'b'), block('other', 'stale')]
    expect(review.stage(host, first, 'one')).toBe(true)
    first[0].content = 'mutated caller'
    review.stage(host, [block('two', 'fixed b')], 'two')
    expect(review.size).toBe(2)
    expect(host[0].content).toBe('a')
    const applied = review.apply([host[0], host[1], block('other', 'fresh')])
    expect(applied.ok).toBe(true)
    expect(applied.blocks.map((item) => item.content)).toEqual(['fixed a', 'fixed b', 'fresh'])
    expect(review.size).toBe(2)
    review.clear()
    expect(review.size).toBe(0)
  })
  test('rejects a changed, deleted or ambiguous target atomically', () => {
    const host = [block('one', 'a'), block('two', 'b')]
    const review = new WorkshopIssueReview()
    review.stage(host, [block('one', 'fixed a')], 'one')
    review.stage(host, [block('two', 'fixed b')], 'two')
    for (const current of [[host[0], block('two', 'external')], [host[0]], [host[0], host[1], host[1]]]) {
      const result = review.apply(current)
      expect(result.ok).toBe(false)
      expect(result.conflict).toBe('two')
      expect(result.blocks).toEqual(current)
    }
  })
  test('keeps the original baseline when restaging and removes a reverted fix', () => {
    const host = [block('one', 'a')]
    const review = new WorkshopIssueReview()
    review.stage(host, [block('one', 'edit')], 'one')
    review.stage([block('one', 'external')], [block('one', 'another edit')], 'one')
    expect(review.apply([block('one', 'external')]).ok).toBe(false)
    review.stage(host, host, 'one')
    expect(review.size).toBe(0)
    expect(review.stage([host[0], host[0]], host, 'one')).toBe(false)
  })
})
