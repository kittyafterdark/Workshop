import { describe, expect, test } from 'bun:test'
import type { PromptBlockDTO, PromptVariableDefDTO } from 'lumiverse-spindle-types'
import { buildVariableIndex, WorkshopVariableSandbox } from '../src/workshop-core.js'

const definition: PromptVariableDefDTO = {
  id: 'pov', name: 'pov', label: 'Perspective', type: 'select', defaultValue: 'third',
  options: [{ id: 'first', label: 'First', value: 'first person' }, { id: 'third', label: 'Third', value: 'third person' }],
}
const block = (id: string, variables: PromptVariableDefDTO[] = [definition]): PromptBlockDTO => ({
  id, name: id, variables, content: '{{var::pov}}', role: 'system', enabled: true,
  position: 'pre_history', depth: 0, marker: null, isLocked: false, color: null, injectionTrigger: [], group: null,
})
const blocks = [block('controls')]
const entry = buildVariableIndex(blocks, {}).byName.get('pov')!

describe('Workshop variable sandbox', () => {
  test('overlays only preview values and reset returns to fresh host values', () => {
    const sandbox = new WorkshopVariableSandbox()
    const host = { controls: { pov: 'third', unrelated: 'keep' }, other: { value: 'fresh' } }
    expect(sandbox.set(entry, 'first')).toBe(true)
    expect(sandbox.overlay(blocks, host)).toEqual({ ...host, controls: { pov: 'first', unrelated: 'keep' } })
    expect(host.controls.pov).toBe('third')
    sandbox.reset('pov')
    expect(sandbox.overlay(blocks, { controls: { pov: 'first' } })).toEqual({ controls: { pov: 'first' } })
    expect(sandbox.size).toBe(0)
  })

  test('copies arrays on both input and output and supports empty multiselects', () => {
    const multi: PromptVariableDefDTO = { ...definition, type: 'multiselect', defaultValue: [] }
    const graph = [block('controls', [multi])]
    const item = buildVariableIndex(graph, {}).byName.get('pov')!
    const sandbox = new WorkshopVariableSandbox()
    const selection = ['first']
    expect(sandbox.set(item, selection)).toBe(true)
    selection.push('third')
    const result = sandbox.overlay(graph, {})
    expect(result.controls.pov).toEqual(['first'])
    ;(result.controls.pov as string[]).push('third')
    expect(sandbox.overlay(graph, {}).controls.pov).toEqual(['first'])
    sandbox.set(item, [])
    expect(sandbox.overlay(graph, {}).controls.pov).toEqual([])
    sandbox.reset()
    expect(sandbox.overlay(graph, {})).toEqual({})
  })

  test('rejects invalid types/options, nonfinite numbers and bounds, retains zero and empty text', () => {
    const sandbox = new WorkshopVariableSandbox()
    expect(sandbox.set(entry, 'unknown')).toBe(false)
    expect(sandbox.set(entry, 1)).toBe(false)
    const definitions: PromptVariableDefDTO[] = [
      { id: 'number', name: 'amount', label: 'Amount', type: 'number', defaultValue: 0, min: 0, max: 10 },
      { id: 'switch', name: 'on', label: 'On', type: 'switch', defaultValue: 0 },
      { id: 'text', name: 'text', label: 'Text', type: 'text', defaultValue: '' },
    ]
    const graph = [block('controls', definitions)]
    const index = buildVariableIndex(graph, {})
    for (const value of [NaN, Infinity, -1, 11, '2']) expect(sandbox.set(index.byName.get('amount')!, value)).toBe(false)
    expect(sandbox.set(index.byName.get('amount')!, 0)).toBe(true)
    expect(sandbox.set(index.byName.get('on')!, 0)).toBe(true)
    expect(sandbox.set(index.byName.get('on')!, 2)).toBe(false)
    expect(sandbox.set(index.byName.get('text')!, '')).toBe(true)
    expect(sandbox.overlay(graph, {}).controls).toEqual({ amount: 0, on: 0, text: '' })
  })

  test('drops overrides after deletion, definition edits, owner changes or ambiguous IDs', () => {
    const sandbox = new WorkshopVariableSandbox()
    const variants = [[], [block('controls', [{ ...definition, label: 'Changed' }])],
      [block('new-owner')], [...blocks, block('duplicate')], [...blocks, block('controls', [])]]
    for (const changed of variants) {
      sandbox.set(entry, 'first')
      expect(sandbox.overlay(changed, {})).toEqual({})
      expect(sandbox.size).toBe(0)
    }
  })
})
