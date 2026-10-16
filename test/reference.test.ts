import { expect, test } from 'bun:test'
import type { SpindleAPI, UserPresetDTO } from 'lumiverse-spindle-types'
import { ReferenceReader, type ReferenceResult } from '../src/reference-backend.js'

test('reference listing pages public reads in the requesting user scope and exposes only names/IDs', async () => {
  const reads: unknown[] = [], sent: unknown[] = []
  const reader = new ReferenceReader({ list: async options => {
    reads.push(options)
    return { data: Array.from({ length: options?.offset ? 1 : 100 }, (_, i) => ({ id: String((options?.offset ?? 0) + i), name: 'Preset', metadata: { secret: 'hidden' } } as unknown as UserPresetDTO)), total: 101 }
  }, get: async () => { throw Error('Unexpected get') } }, (result, user) => sent.push({ result, user }))
  await reader.handle({ type: 'workshop:reference-list', requestId: 'list' }, 'alice')
  expect(reads).toEqual([{ limit: 100, offset: 0, userId: 'alice' }, { limit: 100, offset: 100, userId: 'alice' }])
  expect(JSON.stringify(sent)).not.toContain('hidden')
  expect(JSON.stringify(sent)).toContain('alice')
  expect((sent[0] as { result: ReferenceResult }).result.presets?.length).toBe(101)
})

test('reference get returns detached text/structure and has no write or macro-resolution boundary', async () => {
  const source = { id: 'second', name: 'Reference', prompt_order: [{ id: 'b', name: 'Block', content: '{{setchatvar::x::true}}<script>untrusted</script>', role: 'system', enabled: true, position: 'pre_history', depth: 0, marker: null, group: null, isLocked: false, color: null, injectionTrigger: [], sealedKey: 'hidden', variables: [{ private: 'hidden' }] }], metadata: { secret: 'hidden' } } as unknown as UserPresetDTO
  const reads: unknown[] = [], results: ReferenceResult[] = []
  const api = { get: async (id: string, user?: string) => { reads.push([id, user]); return source }, list: async () => { throw Error('Unexpected list') } } satisfies Pick<SpindleAPI['presets'], 'get' | 'list'>
  const reader = new ReferenceReader(api, result => results.push(result))
  await reader.handle({ type: 'workshop:reference-get', requestId: 'get', presetId: 'second' }, 'bob')
  expect(reads).toEqual([['second', 'bob']])
  expect(results[0].preset?.blocks[0].content).toBe(source.prompt_order[0].content)
  expect(JSON.stringify(results)).not.toContain('hidden')
  results[0].preset!.blocks[0].content = 'caller edit'
  expect(source.prompt_order[0].content).toContain('setchatvar')
})

test('missing, invalid, failed and mismatched reads produce errors without a partial reference', async () => {
  const results: ReferenceResult[] = []
  const reader = new ReferenceReader({ get: async () => null, list: async () => { throw Error('Unavailable') } }, result => results.push(result))
  for (const payload of [{ type: 'workshop:reference-get', requestId: '1', presetId: 'deleted' }, { type: 'workshop:reference-get', requestId: '2', presetId: '' }, { type: 'workshop:reference-list', requestId: '3' }, { type: 'workshop:reference-update', requestId: '4' }]) await reader.handle(payload, 'user')
  expect(results.length).toBe(4)
  expect(results.every(r => r.error && !r.preset && !r.presets)).toBe(true)
  await reader.handle({ type: 'workshop:reference-get', requestId: 4 })
  expect(results.length).toBe(4)
  const mismatch = new ReferenceReader({ get: async () => ({ id: 'wrong' } as UserPresetDTO), list: async () => ({ data: [], total: 1 }) }, result => results.push(result))
  await mismatch.handle({ type: 'workshop:reference-get', requestId: '5', presetId: 'second' })
  await mismatch.handle({ type: 'workshop:reference-list', requestId: '6' })
  expect(results.slice(4).every(r => r.error && !r.preset && !r.presets)).toBe(true)
})
