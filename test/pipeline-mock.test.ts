import { describe, expect, test } from 'bun:test'
import type { PromptBlockDTO, PromptVariableValuesDTO } from 'lumiverse-spindle-types'
import { overlaySelectedDraft, overlaySelectedDrafts, replaceUniqueBlock } from '../src/workshop-core.js'

function block(id: string, content: string): PromptBlockDTO {
  return {
    id,
    name: id.toUpperCase(),
    content,
    role: 'system',
    enabled: true,
    position: 'pre_history',
    depth: 0,
    marker: null,
    isLocked: false,
    color: null,
    injectionTrigger: [],
    group: null,
  }
}

describe('Workshop host/draft pipeline mock', () => {
  test('keeps unrelated fresh host state while previewing one transient selected-block draft', () => {
    const host = {
      blocks: [block('selected', 'host selected'), block('external', 'host changed elsewhere')],
      promptVariableValues: {
        selected: { mode: 'host' },
        external: { mode: 'fresh' },
      } satisfies PromptVariableValuesDTO,
    }
    const nativeDraft = {
      blocks: [block('selected', 'unsaved local edit'), block('external', 'stale editor snapshot')],
      promptVariableValues: {
        selected: { mode: 'draft' },
        external: { mode: 'stale' },
      } satisfies PromptVariableValuesDTO,
    }

    const preview = overlaySelectedDraft(host, nativeDraft, 'selected')

    expect(preview.blocks.map((entry) => entry.content)).toEqual([
      'unsaved local edit',
      'host changed elsewhere',
    ])
    expect(preview.promptVariableValues).toEqual({
      selected: { mode: 'draft' },
      external: { mode: 'fresh' },
    })
  })

  test('keeps two independent editor drafts while preserving a third externally refreshed block', () => {
    const host = {
      blocks: [block('a', 'host A'), block('b', 'host B'), block('c', 'external fresh C')],
      promptVariableValues: {
        a: { mode: 'host-a' },
        b: { mode: 'host-b' },
        c: { mode: 'fresh-c' },
      } satisfies PromptVariableValuesDTO,
    }
    const draftA = {
      blocks: [block('a', 'draft A'), block('b', 'stale B from A'), block('c', 'stale C from A')],
      promptVariableValues: { a: { mode: 'draft-a' } } satisfies PromptVariableValuesDTO,
    }
    const draftB = {
      blocks: [block('a', 'stale A from B'), block('b', 'draft B'), block('c', 'stale C from B')],
      promptVariableValues: { b: { mode: 'draft-b' } } satisfies PromptVariableValuesDTO,
    }

    const preview = overlaySelectedDrafts(host, [
      { selectedBlockId: 'a', value: draftA },
      { selectedBlockId: 'b', value: draftB },
    ])

    expect(preview.blocks.map((entry) => entry.content)).toEqual(['draft A', 'draft B', 'external fresh C'])
    expect(preview.promptVariableValues).toEqual({
      a: { mode: 'draft-a' },
      b: { mode: 'draft-b' },
      c: { mode: 'fresh-c' },
    })
  })

  test('fails closed when the selected block disappears instead of writing a stale snapshot', () => {
    const latestHost = [block('survivor', 'fresh host state')]
    const editorSnapshot = [block('removed', 'stale draft')]

    const commit = replaceUniqueBlock(latestHost, editorSnapshot, 'removed')

    expect(commit.ok).toBe(false)
    expect(commit.reason).toBe('missing_target')
    expect(commit.blocks).toEqual(latestHost)
  })

  test('falls back to host state when a transient draft can no longer be attributed uniquely', () => {
    const host = {
      blocks: [block('same', 'host one'), block('same', 'host two')],
      promptVariableValues: {},
    }
    const nativeDraft = {
      blocks: [block('same', 'draft')],
      promptVariableValues: {},
    }

    const preview = overlaySelectedDraft(host, nativeDraft, 'same')

    expect(preview.blocks.map((entry) => entry.content)).toEqual(['host one', 'host two'])
  })
})
