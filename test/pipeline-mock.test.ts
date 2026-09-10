import { describe, expect, test } from 'bun:test'
import type { PromptBlockDTO, PromptVariableValuesDTO } from 'lumiverse-spindle-types'
import { overlaySelectedDraft, replaceUniqueBlock } from '../src/workshop-core.js'

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
