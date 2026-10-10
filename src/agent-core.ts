import type { PromptBlockDTO, PromptVariableValuesDTO, SpindlePresetEditorDraft, ToolSchemaDTO } from 'lumiverse-spindle-types'
import { buildReviewIssues, buildVariableIndex } from './workshop-core.js'

export const DRAFT_PATH = 'workshop://draft'
export interface AgentContext {
  values: PromptVariableValuesDTO
  mocks: PromptVariableValuesDTO
  preview: unknown
  changes: string[]
}
const schema = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): ToolSchemaDTO => ({ name, description, parameters: { type: 'object', properties: { path: { type: 'string', const: DRAFT_PATH }, ...properties }, required, additionalProperties: false } })
const str = { type: 'string' }
export const AGENT_TOOLS: ToolSchemaDTO[] = [
  schema('workshop_snapshot', 'Read the full mounted draft, settings, regex metadata, current selections, preview-only mocks, preview and local changes.'),
  schema('preset_audit', 'Read variable definitions, references and diagnostics in the current draft.'),
  schema('preset_list_blocks', 'List blocks in order, including categories, role, depth, enabled and locked state.'),
  schema('preset_show_block', 'Read one uniquely named block in full.', { name: str }, ['name']),
  schema('preset_get_block_lines', 'Read inclusive 1-based block lines.', { name: str, start_line: { type: 'integer', minimum: 1 }, end_line: { type: 'integer', minimum: 1 } }, ['name']),
  schema('preset_search', 'Literal, case-insensitive search across block content/names and serialized variable/category definitions. No regex evaluation.', { query: str, case_sensitive: { type: 'boolean' } }, ['query']),
  schema('preset_modify_block', 'Replace full block content in the local draft. Unified diffs are unsupported; read first and send complete content.', { name: str, content: str }, ['name', 'content']),
  schema('preset_rename_block', 'Rename a uniquely named unlocked block locally.', { old_name: str, new_name: str }, ['old_name', 'new_name']),
  schema('preset_toggle_block', 'Set block enabled state locally.', { name: str, enabled: { type: 'boolean' } }, ['name', 'enabled']),
  schema('workshop_update_block', 'Edit role or depth of an unlocked block locally.', { name: str, role: { enum: ['system', 'user', 'assistant', 'user_append', 'assistant_append'] }, depth: { type: 'integer', minimum: 0 } }, ['name']),
  schema('preset_insert_block', 'Insert a new prompt locally; optional before/after uniquely named block. No category creation.', { name: str, content: str, before: str, after: str, role: { enum: ['system', 'user', 'assistant'] }, position: { enum: ['pre_history', 'post_history'] }, enabled: { type: 'boolean' } }, ['name', 'content']),
  schema('preset_move_block', 'Move a uniquely named unlocked block before or after another block locally.', { name: str, before: str, after: str }, ['name']),
  schema('preset_delete_block', 'Delete a uniquely named unlocked block locally.', { name: str }, ['name']),
]
export const COMPATIBLE_TOOLS = new Set(AGENT_TOOLS.map(t => t.name).filter(name => name.startsWith('preset_')))

/** A detached workspace. There is deliberately no persistence or host API here. */
export class AgentDraft {
  private value: SpindlePresetEditorDraft
  constructor(preset: SpindlePresetEditorDraft, private readonly context: AgentContext) { this.value = structuredClone(preset) }
  snapshot(): SpindlePresetEditorDraft { return structuredClone(this.value) }
  execute(name: string, args: Record<string, unknown>): unknown {
    const definition = AGENT_TOOLS.find(t => t.name === name)
    if (!definition) throw Error('Unsupported tool. Saving, applying, external files and arbitrary MCP calls are unavailable.')
    if (args.path !== undefined && args.path !== DRAFT_PATH) throw Error(`Only ${DRAFT_PATH} is available.`)
    const properties = definition.parameters.properties as Record<string, { type?: string; enum?: unknown[] }>
    for (const key of Object.keys(args)) {
      if (!Object.hasOwn(properties, key)) throw Error(`Unsupported argument: ${key}`)
      const spec = properties[key]
      if (spec.type && (spec.type === 'integer' ? !Number.isInteger(args[key]) || Number(args[key]) < 0 : typeof args[key] !== spec.type)) throw Error(`Invalid ${key}`)
      if (spec.enum && !spec.enum.includes(args[key])) throw Error(`Invalid ${key}`)
    }
    for (const key of definition.parameters.required as string[]) if (!(key in args)) throw Error(`Missing ${key}`)
    const text = (key: string) => args[key] as string
    const find = (label: string, blocks = this.value.blocks) => {
      const matches = blocks.filter(b => b.name === label)
      if (matches.length !== 1) throw Error('Block name is missing or ambiguous; inspect the block list first.')
      if (blocks.filter(b => b.id === matches[0].id).length !== 1) throw Error('Block identity is ambiguous.')
      return matches[0]
    }
    if (name === 'workshop_snapshot') return { path: DRAFT_PATH, preset: this.snapshot(), ...structuredClone(this.context) }
    if (name === 'preset_audit') return { diagnostics: buildReviewIssues(this.value.blocks, this.context.values), variables: buildVariableIndex(this.value.blocks, this.context.values) }
    if (name === 'preset_list_blocks') return this.value.blocks.map(({ content, ...block }, index) => ({ ...block, index, characters: content.length }))
    if (name === 'preset_show_block') return structuredClone(find(text('name')))
    if (name === 'preset_get_block_lines') {
      const lines = find(text('name')).content.split('\n'), start = Number(args.start_line ?? 1), end = Number(args.end_line ?? lines.length)
      if (start < 1 || end < start) throw Error('Invalid line range.')
      return lines.slice(start - 1, end).map((content, i) => ({ line: start + i, content }))
    }
    if (name === 'preset_search') {
      const normalize = (s: string) => args.case_sensitive ? s : s.toLowerCase()
      return this.value.blocks.filter(b => normalize(JSON.stringify(b)).includes(normalize(text('query')))).map(b => ({ name: b.name, id: b.id, content: b.content, variables: b.variables }))
    }
    const next = this.snapshot()
    let block: PromptBlockDTO | undefined
    if (name !== 'preset_insert_block') {
      block = find(text(name === 'preset_rename_block' ? 'old_name' : 'name'), next.blocks)
      if (block.isLocked || block.marker === 'category') throw Error('Locked blocks and category structure cannot be edited by these tools.')
    }
    if (name === 'preset_modify_block') {
      if (/^(?:--- |@@ )/m.test(text('content'))) throw Error('Unified diffs are unsupported. Send the complete replacement content.')
      block!.content = text('content')
    } else if (name === 'preset_rename_block') {
      if (!text('new_name').trim() || next.blocks.some(b => b !== block && b.name === text('new_name'))) throw Error('Choose a nonempty unique name.')
      block!.name = text('new_name')
    } else if (name === 'preset_toggle_block') block!.enabled = args.enabled as boolean
    else if (name === 'workshop_update_block') {
      if (args.role !== undefined) block!.role = args.role as PromptBlockDTO['role']
      if (args.depth !== undefined) block!.depth = args.depth as number
    } else if (name === 'preset_delete_block') next.blocks = next.blocks.filter(b => b !== block)
    else if (name === 'preset_insert_block' || name === 'preset_move_block') {
      if (args.before && args.after) throw Error('Choose before or after, not both.')
      if (name === 'preset_insert_block') {
        if (!text('name').trim() || next.blocks.some(b => b.name === text('name'))) throw Error('Choose a nonempty unique name.')
        block = { id: crypto.randomUUID(), name: text('name'), content: text('content'), role: (args.role ?? 'system') as PromptBlockDTO['role'], enabled: (args.enabled ?? true) as boolean, position: (args.position ?? 'pre_history') as PromptBlockDTO['position'], depth: 0, marker: null, isLocked: false, color: null, injectionTrigger: [], group: null }
      } else {
        if (!args.before && !args.after) throw Error('A move needs before or after.')
        next.blocks = next.blocks.filter(b => b !== block)
      }
      const anchor = args.before ?? args.after
      const index = anchor ? next.blocks.indexOf(find(anchor as string, next.blocks)) + (args.after ? 1 : 0) : next.blocks.length
      next.blocks.splice(index, 0, block!)
    }
    this.value = next
    return { ok: true, localDraftOnly: true, block: block?.name, diagnostics: buildReviewIssues(next.blocks, this.context.values) }
  }
}
