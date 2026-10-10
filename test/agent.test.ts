import { expect, test } from 'bun:test'
import type { GenerationRequestDTO, SpindlePresetEditorDraft } from 'lumiverse-spindle-types'
import { AgentDraft, DRAFT_PATH } from '../src/agent-core.js'
import { WorkshopAgentCoordinator, type AgentRequest, type AgentResponse } from '../src/agent-backend.js'

const preset = (): SpindlePresetEditorDraft => ({ id: 'p', name: 'Preset', blocks: ['one', 'two'].map(id => ({ id, name: id, content: `{{var::${id}}}`, role: 'system', enabled: true, position: 'pre_history', depth: 0, marker: null, isLocked: false, color: null, injectionTrigger: [], group: null })), parameters: { temperature: 1 }, prompts: {}, metadata: { regex: ['read-only metadata'] }, createdAt: 0, updatedAt: 0 })
const context = () => ({ values: {}, mocks: {}, preview: { messages: [] }, changes: [] })
test('detached edits never mutate inputs; reads cover diagnostics/settings and local edits', () => {
  const source = preset(), draft = new AgentDraft(source, context())
  draft.execute('preset_modify_block', { name: 'one', content: 'fixed' })
  expect(source.blocks[0].content).toBe('{{var::one}}')
  expect(draft.snapshot().blocks[0].content).toBe('fixed')
  expect(JSON.stringify(draft.execute('preset_audit', {}))).toContain('two')
  expect(JSON.stringify(draft.execute('workshop_snapshot', {}))).toContain('read-only metadata')
  const snapshot = draft.snapshot(); snapshot.blocks[0].content = 'caller mutation'
  expect(draft.snapshot().blocks[0].content).toBe('fixed')
  draft.execute('preset_move_block', { name: 'two', before: 'one' })
  draft.execute('preset_insert_block', { name: 'new', content: 'new content', after: 'two' })
  expect(draft.snapshot().blocks.map(b => b.name)).toEqual(['two', 'new', 'one'])
  draft.execute('preset_delete_block', { name: 'new' })
  draft.execute('workshop_update_block', { name: 'two', role: 'assistant_append', depth: 2 })
  expect(draft.snapshot().blocks[0].depth).toBe(2)
})
test('file paths, unsupported writes, invalid args, ambiguous identities and locks fail closed', () => {
  const source = preset(), draft = new AgentDraft(source, context())
  for (const [name, args] of [
    ['preset_modify_block', { path: 'C:/live.json', name: 'one', content: 'bad' }],
    ['preset_save', {}], ['Apply', {}], ['preset_modify_block', { name: 'one', content: '@@ -1 +1 @@\n-bad\n+bad' }],
    ['preset_toggle_block', { name: 'one', enabled: 'false' }],
    ['workshop_update_block', { name: 'one', depth: -1 }],
    ['preset_modify_block', { name: 'one', content: 'bad', expected_revision: 'ignored?' }],
    ['preset_move_block', { name: 'one', before: 'one' }],
  ] as const) expect(() => draft.execute(name, args)).toThrow()
  expect(draft.snapshot()).toEqual(source)
  source.blocks[1].name = 'one'
  expect(() => new AgentDraft(source, context()).execute('preset_delete_block', { name: 'one' })).toThrow(/ambiguous/)
  source.blocks[1].name = 'two'; source.blocks[0].isLocked = true
  expect(() => new AgentDraft(source, context()).execute('preset_modify_block', { name: 'one', content: 'bad' })).toThrow(/Locked/)
  expect(draft.execute('preset_get_block_lines', { path: DRAFT_PATH, name: 'one', start_line: 1, end_line: 1 })).toEqual([{ line: 1, content: '{{var::one}}' }])
})
const request = (id = 'run'): AgentRequest => ({ type: 'workshop:agent-run', requestId: id, connectionId: 'connection', serverId: '', preset: preset(), context: context(), instruction: 'Fix one', history: [] })
function fixture(raw: (input: GenerationRequestDTO) => Promise<unknown>) {
  const output: Array<AgentResponse & { userId?: string }> = [], remoteCalls: string[] = []
  const coordinator = new WorkshopAgentCoordinator({ generate: { raw }, connections: { list: async () => [{ id: 'c', name: 'Connection', model: 'model', api_url: 'SECRET', metadata: { secret: true } }] }, mcp: {
    servers: { list: async () => ({ data: [{ id: 's', name: 'Preset tools', is_enabled: true, env_keys: ['SECRET'] }], total: 1 }), connect: async () => ({}) },
    tools: { list: async () => [{ name: 'preset_modify_block' }, { name: 'preset_save' }], call: async (name: string) => { remoteCalls.push(name); throw Error('Must never execute') } },
  }, sendToFrontend: (data: AgentResponse, userId?: string) => output.push({ ...data, userId }) } as never)
  return { coordinator, output, remoteCalls }
}
test('provider tool continuation preserves IDs and reasoning; MCP file tools translate locally', async () => {
  const inputs: GenerationRequestDTO[] = []
  const { coordinator, output, remoteCalls } = fixture(async input => {
    inputs.push(structuredClone({ ...input, signal: undefined }))
    return inputs.length === 1 ? { content: '', reasoning: 'provider reasoning', thinking_blocks: [{ type: 'thinking', thinking: 'opaque', signature: 'sig' }], tool_calls: [
      { name: 'preset_modify_block', args: { path: DRAFT_PATH, name: 'one', content: 'fixed' }, call_id: 'id1', thought_signature: 'opaque-signature' },
      { name: 'preset_save', args: {}, call_id: 'id2' },
    ] } : { content: 'Drafted the fix.' }
  })
  const source = request(); source.serverId = 's'
  await coordinator.handle(source, 'user')
  expect(remoteCalls).toEqual([])
  expect(source.preset.blocks[0].content).toBe('{{var::one}}')
  expect(output.at(-1)?.preset?.blocks[0].content).toBe('fixed')
  expect(output.every(p => p.userId === 'user')).toBe(true)
  const assistant = inputs[1].messages!.at(-2)!
  expect(assistant.reasoning_content).toBe('provider reasoning')
  expect(JSON.stringify(assistant.content)).toContain('opaque-signature')
  expect(JSON.stringify(inputs[1].messages!.at(-1))).toContain('id2')
  expect(JSON.stringify(inputs[1].messages!.at(-1))).toContain('Unsupported tool')
})
test('optional MCP and credential-free connection inventory do not require a model run', async () => {
  const { coordinator, output } = fixture(async () => { throw Error('No generation') })
  await coordinator.handle({ type: 'workshop:agent-config', requestId: 'config' }, 'user')
  expect(output[0].connections).toEqual([{ id: 'c', name: 'Connection', model: 'model' }])
  expect(JSON.stringify(output)).not.toContain('SECRET')
})
test('cancel suppresses late results and a newer run remains isolated', async () => {
  let release: ((value: unknown) => void) | undefined
  let calls = 0
  const { coordinator, output } = fixture(async () => ++calls === 1 ? new Promise(resolve => { release = resolve }) : { content: 'new run' })
  const first = coordinator.handle(request('first'), 'user')
  await Promise.resolve()
  await coordinator.handle({ type: 'workshop:agent-cancel', requestId: 'first' }, 'user')
  await coordinator.handle(request('second'), 'user')
  release?.({ content: 'late old result' }); await first
  expect(output.filter(p => p.type === 'workshop:agent-result').map(p => p.requestId)).toEqual(['second'])
})
test('provider failures never return partially edited snapshots', async () => {
  let calls = 0
  const { coordinator, output } = fixture(async () => { if (++calls > 1) throw Error('provider failed'); return { content: '', tool_calls: [{ name: 'preset_modify_block', args: { name: 'one', content: 'partial' }, call_id: 'one' }] } })
  await coordinator.handle(request(), 'user')
  expect(output.at(-1)?.error).toContain('provider failed')
  expect(output.at(-1)?.preset).toBeUndefined()
})
test('step limit stops repeated tool calls without exposing a partial draft', async () => {
  let calls = 0
  const { coordinator, output } = fixture(async () => ({ content: '', tool_calls: [{ name: 'preset_modify_block', args: { name: 'one', content: `partial ${++calls}` }, call_id: `call${calls}` }] }))
  await coordinator.handle(request(), 'user')
  expect(calls).toBe(8)
  expect(output.at(-1)?.error).toContain('step limit')
  expect(output.at(-1)?.preset).toBeUndefined()
})
test('an unavailable optional MCP discovery falls back to local tools', async () => {
  const output: AgentResponse[] = []
  const coordinator = new WorkshopAgentCoordinator({ generate: { raw: async () => ({ content: 'Built-in tools ready.' }) }, mcp: { servers: { connect: async () => { throw Error('Offline') } } }, sendToFrontend: (p: AgentResponse) => output.push(p) } as never)
  await coordinator.handle({ ...request(), serverId: 'offline' }, 'user')
  expect(output[0].content).toContain('Continuing with built-in')
  expect(output.at(-1)?.content).toBe('Built-in tools ready.')
})
