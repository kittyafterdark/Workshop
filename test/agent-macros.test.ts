import { expect, test } from 'bun:test'
import { AgentDraft } from '../src/agent-core.js'
import { loadMacroCatalogue, macroCatalogue, readMacroReference } from '../src/agent-macros.js'
import type { SpindlePresetEditorDraft } from 'lumiverse-spindle-types'

const catalogue = () => ({ categories: [{ category: 'Variables', macros: [
  { name: 'setvar', syntax: '{{setvar::key::value}}', description: 'Set a local variable', args: [{ name: 'key', optional: false }, { name: 'value', optional: false }], returns: 'string', handler: 'never expose' },
  { name: 'getchatvar', syntax: '{{getchatvar::key}}', description: 'Read chat-scoped persisted state', args: [{ name: 'key', optional: false }] },
] }] })

test('macro reference searches host syntax, topics and categories without executing or changing the draft', () => {
  const source = { id: 'p', blocks: [] } as unknown as SpindlePresetEditorDraft
  const draft = new AgentDraft(source, { values: {}, mocks: {}, preview: null, changes: [] }, catalogue())
  const result = draft.execute('workshop_macro_reference', { query: 'SETVAR' }) as { entries: Array<{ syntax: string }>; guidance: string }
  expect(result.entries.map(m => m.syntax)).toEqual(['{{setvar::key::value}}'])
  expect(result.guidance).toContain('does not create one of those controls')
  expect(result.guidance).toContain('not a persistent chat-variable assignment')
  expect(JSON.stringify(result)).not.toContain('never expose')
  expect((draft.execute('workshop_macro_reference', { query: 'persisted' }) as { total: number }).total).toBe(1)
  expect((draft.execute('workshop_macro_reference', { query: 'Variables' }) as { total: number }).total).toBe(2)
  expect((draft.execute('workshop_macro_reference', { query: '{{setvar::live::true}}' }) as { total: number }).total).toBe(0)
  expect(draft.snapshot()).toEqual(source)
  expect(() => draft.execute('workshop_macro_reference', { offset: -1 })).toThrow()
  expect(() => draft.execute('workshop_macro_reference', { resolve: '{{setvar::x::true}}' })).toThrow()
  expect(() => draft.execute('workshop_macro_reference', { path: '/resolve' })).toThrow()
})

test('catalogue pagination is complete and results are detached; unavailable docs are explicit', () => {
  const entries = Array.from({ length: 45 }, (_, i) => ({ name: `macro${i}`, syntax: `{{macro${i}}}`, description: 'Fixture', category: 'Fixture', args: [] }))
  const first = readMacroReference(entries) as { entries: typeof entries; nextOffset: number; total: number }
  expect(first.total).toBe(45)
  expect(first.entries.length).toBe(20)
  first.entries[0].name = 'mutated'
  expect(entries[0].name).toBe('macro0')
  expect((readMacroReference(entries, '', first.nextOffset) as { entries: typeof entries }).entries[0].name).toBe('macro20')
  expect((readMacroReference(entries, '', 40) as { nextOffset: null }).nextOffset).toBeNull()
  const missing = readMacroReference(null) as { source: string; entries: unknown[] }
  expect(missing.source).toContain('unavailable')
  expect(missing.entries).toEqual([])
  expect(macroCatalogue({ categories: [] })).toEqual([])
})

test('malformed and oversized host data cannot masquerade as a usable catalogue', () => {
  for (const value of [null, {}, { categories: [{}] }, { categories: [{ category: 'x', macros: [{ name: 'bad' }] }] }]) expect(macroCatalogue(value)).toBeNull()
  const input = catalogue(); input.categories[0].macros[0].description = 'x'.repeat(12001)
  expect(macroCatalogue(input)).toBeNull()
})

test('documentation loader performs only an authenticated same-origin GET and degrades on failure', async () => {
  const previous = globalThis.fetch
  const calls: Array<{ url: unknown; options: RequestInit | undefined }> = []
  try {
    globalThis.fetch = (async (url, options) => { calls.push({ url, options }); return Response.json(catalogue()) }) as typeof fetch
    expect(macroCatalogue(await loadMacroCatalogue())?.length).toBe(2)
    expect(calls[0].url).toBe('/api/v1/macros')
    expect(calls[0].options?.credentials).toBe('same-origin')
    expect(calls[0].options?.method).toBeUndefined()
    expect(calls[0].options?.body).toBeUndefined()
    globalThis.fetch = (async () => Response.json({}, { status: 403 })) as typeof fetch
    expect(await loadMacroCatalogue()).toBeUndefined()
    globalThis.fetch = (async () => { throw Error('Offline') }) as typeof fetch
    expect(await loadMacroCatalogue()).toBeUndefined()
  } finally { globalThis.fetch = previous }
})
