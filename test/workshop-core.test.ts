import { describe, expect, test } from 'bun:test'
import type { PromptBlockDTO, PromptVariableDefDTO, PromptVariableValuesDTO } from 'lumiverse-spindle-types'
import {
  buildVariableIndex,
  computePromptGroups,
  describePromptVariableValue,
  overlaySelectedDraft,
  overlaySelectedDrafts,
  parsePromptVariableReferences,
  replaceUniqueBlock,
} from '../src/workshop-core.js'

function block(overrides: Partial<PromptBlockDTO> & Pick<PromptBlockDTO, 'id' | 'name'>): PromptBlockDTO {
  const { id, name, ...rest } = overrides
  return {
    content: '',
    role: 'system',
    enabled: true,
    position: 'pre_history',
    depth: 0,
    marker: null,
    isLocked: false,
    color: null,
    injectionTrigger: [],
    group: null,
    ...rest,
    id,
    name,
  }
}

const pov: PromptVariableDefDTO = {
  id: 'var-pov',
  name: 'pov',
  label: 'Narrative Perspective',
  type: 'select',
  defaultValue: 'third',
  description: 'Controls point of view.',
  options: [
    { id: 'first', label: 'First person', value: 'first person' },
    { id: 'third', label: 'Third person', value: 'third person limited' },
  ],
}

const traits: PromptVariableDefDTO = {
  id: 'var-traits',
  name: 'traits',
  label: 'Traits',
  type: 'multiselect',
  defaultValue: ['vivid'],
  separator: ' | ',
  options: [
    { id: 'vivid', label: 'Vivid', value: 'use vivid prose' },
    { id: 'short', label: 'Short', value: 'keep it short' },
  ],
}

describe('Workshop prompt-variable topology', () => {
  test('parses direct and conditional prompt variable macros without treating unrelated macros as variables', () => {
    const refs = parsePromptVariableReferences(
      'Write in {{var::pov}}. {{char}} Keep {{ var::traits::ison::vivid,short }} enabled.',
    )

    expect(refs).toHaveLength(2)
    expect(refs[0]).toMatchObject({ name: 'pov', raw: '{{var::pov}}', mode: null, arguments: [] })
    expect(refs[1]).toMatchObject({
      name: 'traits',
      raw: '{{ var::traits::ison::vivid,short }}',
      mode: 'ison',
      arguments: ['vivid,short'],
    })
  })

  test('attributes definitions to owning block titles and references to consuming blocks', () => {
    const blocks = [
      block({ id: 'controls', name: 'Narrative Controls', variables: [pov], content: '' }),
      block({ id: 'main', name: 'Main System', content: 'Use {{var::pov}}. Then reinforce {{var::pov}}.' }),
      block({ id: 'style', name: 'Style Guidance', content: 'Style remains {{var::pov}}.' }),
    ]
    const values: PromptVariableValuesDTO = { controls: { pov: 'first' } }
    const index = buildVariableIndex(blocks, values)
    const entry = index.byName.get('pov')

    expect(entry?.definitions).toHaveLength(1)
    expect(entry?.definitions[0]).toMatchObject({
      blockId: 'controls',
      blockName: 'Narrative Controls',
      displayValue: 'First person',
      resolvedValue: 'first person',
    })
    expect(entry?.references).toEqual([
      { blockId: 'main', blockName: 'Main System', count: 2, macros: ['{{var::pov}}'] },
      { blockId: 'style', blockName: 'Style Guidance', count: 1, macros: ['{{var::pov}}'] },
    ])
  })

  test('surfaces missing, duplicate, unused, and duplicate-block-id diagnostics', () => {
    const blocks = [
      block({ id: 'same', name: 'Controls A', variables: [pov] }),
      block({ id: 'same', name: 'Controls B', variables: [{ ...pov, id: 'var-pov-2' }] }),
      block({ id: 'unused-owner', name: 'Unused', variables: [{ ...traits, name: 'unused_traits' }] }),
      block({ id: 'consumer', name: 'Consumer', content: 'Hello {{var::pov}} and {{var::typo}}.' }),
    ]
    const index = buildVariableIndex(blocks, {})

    expect(index.byName.get('pov')?.duplicateDefinition).toBe(true)
    expect(index.byName.get('unused_traits')?.unused).toBe(true)
    expect(index.missing).toEqual([
      expect.objectContaining({ name: 'typo', macro: '{{var::typo}}' }),
    ])
    expect(index.duplicateBlockIds).toEqual(['same'])
  })

  test('describes select and multiselect storage using human labels and resolved option values', () => {
    expect(describePromptVariableValue(pov, 'third')).toEqual({
      display: 'Third person',
      resolved: 'third person limited',
    })
    expect(describePromptVariableValue(traits, ['vivid', 'short'])).toEqual({
      display: 'Vivid, Short',
      resolved: 'use vivid prose | keep it short',
    })
  })
})



describe('Workshop prompt grouping', () => {
  test('mirrors Loom category grouping and explicit group breakouts', () => {
    const groups = computePromptGroups([
      block({ id: 'loose', name: 'Loose' }),
      block({ id: 'cat-a', name: 'Category A', marker: 'category' }),
      block({ id: 'a1', name: 'A1', group: 'cat-a' }),
      block({ id: 'a2', name: 'A2', group: 'cat-a' }),
      block({ id: 'detached', name: 'Detached', group: 'other-category' }),
      block({ id: 'cat-b', name: 'Category B', marker: 'category' }),
      block({ id: 'b1', name: 'B1', group: 'cat-b' }),
    ])

    expect(groups.map((group) => ({
      category: group.categoryBlock?.id ?? null,
      children: group.children.map((entry) => entry.id),
    }))).toEqual([
      { category: null, children: ['loose'] },
      { category: 'cat-a', children: ['a1', 'a2'] },
      { category: null, children: ['detached'] },
      { category: 'cat-b', children: ['b1'] },
    ])
  })
})

describe('Workshop targeted graph writes', () => {
  test('replaces only the selected block in the latest host graph', () => {
    const current = [
      block({ id: 'a', name: 'A', content: 'host A' }),
      block({ id: 'b', name: 'B', content: 'host B changed elsewhere' }),
    ]
    const editorSnapshot = [
      block({ id: 'a', name: 'A', content: 'edited A' }),
      block({ id: 'b', name: 'B', content: 'stale B' }),
    ]

    const result = replaceUniqueBlock(current, editorSnapshot, 'a')

    expect(result.ok).toBe(true)
    expect(result.blocks.map((entry) => entry.content)).toEqual(['edited A', 'host B changed elsewhere'])
  })

  test('fails closed on missing or ambiguous source/target block identities', () => {
    const current = [block({ id: 'a', name: 'A' })]
    expect(replaceUniqueBlock(current, [], 'a').reason).toBe('missing_source')
    expect(replaceUniqueBlock(current, [block({ id: 'a', name: 'A1' }), block({ id: 'a', name: 'A2' })], 'a').reason)
      .toBe('ambiguous_source')
    expect(replaceUniqueBlock(current, [block({ id: 'b', name: 'B' })], 'b').reason).toBe('missing_target')
    expect(replaceUniqueBlock([block({ id: 'a', name: 'A1' }), block({ id: 'a', name: 'A2' })], [block({ id: 'a', name: 'A3' })], 'a').reason)
      .toBe('ambiguous_target')
  })

  test('overlays only the selected transient draft onto newer host state', () => {
    const host = {
      blocks: [
        block({ id: 'a', name: 'A', content: 'host A' }),
        block({ id: 'b', name: 'B', content: 'new host B' }),
      ],
      promptVariableValues: {
        a: { pov: 'third' },
        b: { external: 'new' },
      },
    }
    const draft = {
      blocks: [
        block({ id: 'a', name: 'A', content: 'draft A' }),
        block({ id: 'b', name: 'B', content: 'stale B' }),
      ],
      promptVariableValues: {
        a: { pov: 'first' },
        b: { external: 'stale' },
      },
    }

    const result = overlaySelectedDraft(host, draft, 'a')

    expect(result.blocks.map((entry) => entry.content)).toEqual(['draft A', 'new host B'])
    expect(result.promptVariableValues).toEqual({
      a: { pov: 'first' },
      b: { external: 'new' },
    })
  })

  test('overlays two independent transient drafts without replacing unrelated fresh host state', () => {
    const host = {
      blocks: [
        block({ id: 'a', name: 'A', content: 'host A' }),
        block({ id: 'b', name: 'B', content: 'host B' }),
        block({ id: 'c', name: 'C', content: 'fresh host C' }),
      ],
      promptVariableValues: {
        a: { pov: 'third' },
        b: { traits: ['vivid'] },
        c: { external: 'fresh' },
      },
    }
    const draftA = {
      blocks: [
        block({ id: 'a', name: 'A', content: 'draft A' }),
        block({ id: 'b', name: 'B', content: 'stale B in A snapshot' }),
        block({ id: 'c', name: 'C', content: 'stale C in A snapshot' }),
      ],
      promptVariableValues: { a: { pov: 'first' } },
    }
    const draftB = {
      blocks: [
        block({ id: 'a', name: 'A', content: 'stale A in B snapshot' }),
        block({ id: 'b', name: 'B', content: 'draft B' }),
        block({ id: 'c', name: 'C', content: 'stale C in B snapshot' }),
      ],
      promptVariableValues: { b: { traits: ['short'] } },
    }

    const result = overlaySelectedDrafts(host, [
      { selectedBlockId: 'a', value: draftA },
      { selectedBlockId: 'b', value: draftB },
    ])

    expect(result.blocks.map((entry) => entry.content)).toEqual(['draft A', 'draft B', 'fresh host C'])
    expect(result.promptVariableValues).toEqual({
      a: { pov: 'first' },
      b: { traits: ['short'] },
      c: { external: 'fresh' },
    })
  })

  test('drops an edited block value map when the transient draft removed it', () => {
    const host = {
      blocks: [block({ id: 'a', name: 'A' })],
      promptVariableValues: { a: { legacy: 'value' } },
    }
    const draft = {
      blocks: [block({ id: 'a', name: 'A' })],
      promptVariableValues: {},
    }

    expect(overlaySelectedDraft(host, draft, 'a').promptVariableValues).toEqual({})
  })
})
