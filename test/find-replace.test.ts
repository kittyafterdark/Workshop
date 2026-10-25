import { describe, expect, test } from 'bun:test'
import type { PromptBlockDTO } from 'lumiverse-spindle-types'
import { previewReplacements } from '../src/find-replace.js'
import { WorkshopIssueReview } from '../src/workshop-core.js'

const block = (id: string, content: string): PromptBlockDTO => ({ id, name: id, content, role: 'system', enabled: true, position: 'pre_history', depth: 0, marker: null, isLocked: false, color: null, injectionTrigger: [], group: null })

describe('Preset find and replace', () => {
  test('uses literal case-sensitive non-overlapping matches and literal replacement strings', () => {
    const blocks = [block('one', 'a.* a.* A.*'), block('two', 'aaaa')]
    expect(previewReplacements(blocks, 'a.*', '$&')[0]).toEqual({ before: blocks[0], after: { ...blocks[0], content: '$& $& A.*' }, count: 2 })
    expect(previewReplacements(blocks, 'aa', 'b')[0].after.content).toBe('bb')
    expect(blocks[0].content).toBe('a.* a.* A.*')
  })
  test('handles deletion, multiline content, empty queries and no-op replacements', () => {
    const blocks = [block('one', 'a\nb a\nb')]
    expect(previewReplacements(blocks, 'a\nb', '')[0].after.content).toBe(' ')
    expect(previewReplacements(blocks, '', 'x')).toEqual([])
    expect(previewReplacements(blocks, 'a', 'a')).toEqual([])
    expect(previewReplacements(blocks, 'absent', 'x')).toEqual([])
  })
  test('covers disabled content while preserving metadata and excluding locked blocks', () => {
    const blocks = [{ ...block('one', 'old'), enabled: false }, { ...block('two', 'old'), isLocked: true }, block('old', 'unchanged')]
    const changes = previewReplacements(blocks, 'old', 'new')
    expect(changes).toHaveLength(1)
    expect(changes[0].after).toEqual({ ...blocks[0], content: 'new' })
    changes[0].before.content = 'mutated snapshot'
    expect(blocks[0].content).toBe('old')
  })
  test('joins existing drafts and preserves unrelated host changes; Apply refuses conflicts atomically', () => {
    const host = [block('one', 'old'), block('two', 'old'), block('other', 'untouched')]
    const drafts = new WorkshopIssueReview()
    drafts.stage(host, [{ ...host[0], content: 'old draft' }], 'one')
    for (const change of previewReplacements(drafts.overlay(host), 'old', 'new')) drafts.stage(host, [change.after], change.before.id)
    expect(drafts.overlay(host)[0].content).toBe('new draft')
    expect(drafts.apply([host[0], host[1], block('other', 'external')]).blocks.map(b => b.content)).toEqual(['new draft', 'new', 'external'])
    const conflict = [host[0], block('two', 'external'), host[2]]
    expect(drafts.apply(conflict)).toEqual({ ok: false, blocks: conflict, conflict: 'two' })
  })
})
