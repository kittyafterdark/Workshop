import type {
  PromptBlockDTO,
  PromptVariableDefDTO,
  PromptVariableValueDTO,
  PromptVariableValuesDTO,
} from 'lumiverse-spindle-types'

export interface PromptVariableReference {
  name: string
  raw: string
  mode: string | null
  arguments: string[]
  start: number
  end: number
}

export interface VariableDefinitionRef {
  blockId: string
  blockName: string
  definition: PromptVariableDefDTO
  storedValue: PromptVariableValueDTO
  displayValue: string
  resolvedValue: string
}

export interface VariableBlockReference {
  blockId: string
  blockName: string
  count: number
  macros: string[]
}

export interface VariableIndexEntry {
  name: string
  macro: string
  definitions: VariableDefinitionRef[]
  references: VariableBlockReference[]
  duplicateDefinition: boolean
  unused: boolean
}

export interface MissingVariableReference {
  name: string
  macro: string
  references: VariableBlockReference[]
}

export interface WorkshopVariableIndex {
  variables: VariableIndexEntry[]
  byName: Map<string, VariableIndexEntry>
  missing: MissingVariableReference[]
  duplicateBlockIds: string[]
  definitionCount: number
  referenceCount: number
}

export function parsePromptVariableReferences(content: string): PromptVariableReference[] {
  const refs: PromptVariableReference[] = []
  let cursor = 0

  while (cursor < content.length) {
    const start = content.indexOf('{{', cursor)
    if (start < 0) break
    const close = content.indexOf('}}', start + 2)
    if (close < 0) break

    const raw = content.slice(start, close + 2)
    const body = content.slice(start + 2, close).trim()
    const parts = body.split('::').map((part) => part.trim())
    if (parts[0] === 'var' && parts[1]) {
      refs.push({
        name: parts[1],
        raw,
        mode: parts[2] || null,
        arguments: parts.slice(3).filter(Boolean),
        start,
        end: close + 2,
      })
    }
    cursor = close + 2
  }

  return refs
}

function valueForDefinition(
  blockId: string,
  definition: PromptVariableDefDTO,
  values: PromptVariableValuesDTO,
): PromptVariableValueDTO {
  const stored = values[blockId]?.[definition.name]
  return stored === undefined ? definition.defaultValue : stored
}

function optionLabel(definition: PromptVariableDefDTO, id: string): string {
  if (definition.type !== 'select' && definition.type !== 'multiselect') return id
  return definition.options.find((option) => option.id === id)?.label ?? id
}

function optionValue(definition: PromptVariableDefDTO, id: string): string {
  if (definition.type !== 'select' && definition.type !== 'multiselect') return id
  return definition.options.find((option) => option.id === id)?.value ?? id
}

export function describePromptVariableValue(
  definition: PromptVariableDefDTO,
  value: PromptVariableValueDTO,
): { display: string; resolved: string } {
  if (definition.type === 'select') {
    const id = typeof value === 'string' ? value : String(value)
    return { display: optionLabel(definition, id), resolved: optionValue(definition, id) }
  }

  if (definition.type === 'multiselect') {
    const ids = Array.isArray(value) ? value : []
    const separator = definition.separator ?? '\n\n'
    return {
      display: ids.map((id) => optionLabel(definition, id)).join(', ') || 'None selected',
      resolved: ids.map((id) => optionValue(definition, id)).join(separator),
    }
  }

  if (definition.type === 'switch') {
    const on = value === 1 || value === '1'
    return { display: on ? 'On' : 'Off', resolved: on ? '1' : '0' }
  }

  if (Array.isArray(value)) {
    const joined = value.join(', ')
    return { display: joined, resolved: joined }
  }

  const text = String(value ?? '')
  return { display: text || 'Empty', resolved: text }
}

function blockReferenceMap(blocks: readonly PromptBlockDTO[]): Map<string, VariableBlockReference[]> {
  const byVariable = new Map<string, Map<string, { blockName: string; count: number; macros: Set<string> }>>()

  for (const block of blocks) {
    for (const reference of parsePromptVariableReferences(block.content ?? '')) {
      let perBlock = byVariable.get(reference.name)
      if (!perBlock) {
        perBlock = new Map()
        byVariable.set(reference.name, perBlock)
      }
      const current = perBlock.get(block.id) ?? { blockName: block.name, count: 0, macros: new Set<string>() }
      current.count += 1
      current.macros.add(reference.raw)
      perBlock.set(block.id, current)
    }
  }

  return new Map([...byVariable.entries()].map(([name, perBlock]) => [
    name,
    [...perBlock.entries()].map(([blockId, value]) => ({
      blockId,
      blockName: value.blockName,
      count: value.count,
      macros: [...value.macros],
    })),
  ]))
}

export function buildVariableIndex(
  blocks: readonly PromptBlockDTO[],
  promptVariableValues: PromptVariableValuesDTO,
): WorkshopVariableIndex {
  const refsByVariable = blockReferenceMap(blocks)
  const definitionsByName = new Map<string, VariableDefinitionRef[]>()
  const blockIdCounts = new Map<string, number>()
  let definitionCount = 0

  for (const block of blocks) {
    blockIdCounts.set(block.id, (blockIdCounts.get(block.id) ?? 0) + 1)
    for (const definition of block.variables ?? []) {
      definitionCount += 1
      const storedValue = valueForDefinition(block.id, definition, promptVariableValues)
      const described = describePromptVariableValue(definition, storedValue)
      const list = definitionsByName.get(definition.name) ?? []
      list.push({
        blockId: block.id,
        blockName: block.name,
        definition,
        storedValue,
        displayValue: described.display,
        resolvedValue: described.resolved,
      })
      definitionsByName.set(definition.name, list)
    }
  }

  const names = new Set([...definitionsByName.keys(), ...refsByVariable.keys()])
  const variables: VariableIndexEntry[] = []
  const missing: MissingVariableReference[] = []

  for (const name of names) {
    const definitions = definitionsByName.get(name) ?? []
    const references = refsByVariable.get(name) ?? []
    if (definitions.length === 0) {
      missing.push({ name, macro: `{{var::${name}}}`, references })
      continue
    }
    variables.push({
      name,
      macro: `{{var::${name}}}`,
      definitions,
      references,
      duplicateDefinition: definitions.length > 1,
      unused: references.length === 0,
    })
  }

  variables.sort((a, b) => {
    const aOwner = a.definitions[0]?.blockName ?? ''
    const bOwner = b.definitions[0]?.blockName ?? ''
    return aOwner.localeCompare(bOwner) || a.name.localeCompare(b.name)
  })
  missing.sort((a, b) => a.name.localeCompare(b.name))

  return {
    variables,
    byName: new Map(variables.map((entry) => [entry.name, entry])),
    missing,
    duplicateBlockIds: [...blockIdCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([id]) => id),
    definitionCount,
    referenceCount: [...refsByVariable.values()]
      .flat()
      .reduce((sum, reference) => sum + reference.count, 0),
  }
}


export interface WorkshopPromptGroup {
  categoryBlock: PromptBlockDTO | null
  children: PromptBlockDTO[]
}

/** Mirror Loom's category grouping semantics, including explicit group breakouts. */
export function computePromptGroups(blocks: readonly PromptBlockDTO[]): WorkshopPromptGroup[] {
  if (blocks.length === 0) return []
  const result: WorkshopPromptGroup[] = []
  let currentGroup: WorkshopPromptGroup = { categoryBlock: null, children: [] }

  for (const block of blocks) {
    if (block.marker === 'category') {
      if (currentGroup.categoryBlock || currentGroup.children.length > 0) result.push(currentGroup)
      currentGroup = { categoryBlock: block, children: [] }
      continue
    }

    if (block.group !== undefined && block.group !== (currentGroup.categoryBlock?.id ?? null)) {
      if (currentGroup.categoryBlock || currentGroup.children.length > 0) result.push(currentGroup)
      currentGroup = { categoryBlock: null, children: [] }
    }
    currentGroup.children.push(block)
  }

  if (currentGroup.categoryBlock || currentGroup.children.length > 0) result.push(currentGroup)
  return result
}

export interface UniqueBlockPatchResult {
  ok: boolean
  blocks: PromptBlockDTO[]
  reason?: 'missing_source' | 'ambiguous_source' | 'missing_target' | 'ambiguous_target'
}

/**
 * Replace exactly one block in a current host graph. This intentionally avoids
 * round-tripping an extension snapshot over unrelated host/profile changes.
 */
export function replaceUniqueBlock(
  currentBlocks: readonly PromptBlockDTO[],
  editedBlocks: readonly PromptBlockDTO[],
  blockId: string,
): UniqueBlockPatchResult {
  const sourceMatches = editedBlocks.filter((block) => block.id === blockId)
  if (sourceMatches.length === 0) return { ok: false, blocks: [...currentBlocks], reason: 'missing_source' }
  if (sourceMatches.length > 1) return { ok: false, blocks: [...currentBlocks], reason: 'ambiguous_source' }

  const targetIndexes: number[] = []
  currentBlocks.forEach((block, index) => {
    if (block.id === blockId) targetIndexes.push(index)
  })
  if (targetIndexes.length === 0) return { ok: false, blocks: [...currentBlocks], reason: 'missing_target' }
  if (targetIndexes.length > 1) return { ok: false, blocks: [...currentBlocks], reason: 'ambiguous_target' }

  const next = [...currentBlocks]
  next[targetIndexes[0]] = sourceMatches[0]
  return { ok: true, blocks: next }
}

export function promptBlockSearchText(block: PromptBlockDTO): string {
  return [
    block.name,
    block.content,
    block.role,
    ...(block.variables ?? []).flatMap((variable) => [variable.name, variable.label, variable.description ?? '']),
  ].join('\n').toLowerCase()
}

export function blockVariableStats(block: PromptBlockDTO): { definitions: number; references: number } {
  return {
    definitions: block.variables?.length ?? 0,
    references: new Set(parsePromptVariableReferences(block.content ?? '').map((ref) => ref.name)).size,
  }
}

/**
 * Overlay the native editor's transient selected-block draft onto the latest
 * host snapshot. Unrelated host blocks and prompt-variable values always win.
 */
export function overlaySelectedDraft(
  hostValue: { blocks: readonly PromptBlockDTO[]; promptVariableValues: PromptVariableValuesDTO },
  draftValue: { blocks: readonly PromptBlockDTO[]; promptVariableValues: PromptVariableValuesDTO } | null,
  selectedBlockId: string | null,
): { blocks: PromptBlockDTO[]; promptVariableValues: PromptVariableValuesDTO } {
  if (!draftValue || !selectedBlockId) {
    return {
      blocks: [...hostValue.blocks],
      promptVariableValues: { ...hostValue.promptVariableValues },
    }
  }

  const patched = replaceUniqueBlock(hostValue.blocks, draftValue.blocks, selectedBlockId)
  if (!patched.ok) {
    return {
      blocks: [...hostValue.blocks],
      promptVariableValues: { ...hostValue.promptVariableValues },
    }
  }

  const nextValues: PromptVariableValuesDTO = { ...hostValue.promptVariableValues }
  if (Object.prototype.hasOwnProperty.call(draftValue.promptVariableValues, selectedBlockId)) {
    nextValues[selectedBlockId] = { ...draftValue.promptVariableValues[selectedBlockId] }
  } else {
    delete nextValues[selectedBlockId]
  }

  return { blocks: patched.blocks, promptVariableValues: nextValues }
}

export interface WorkshopTransientDraft {
  selectedBlockId: string | null
  value: { blocks: readonly PromptBlockDTO[]; promptVariableValues: PromptVariableValuesDTO } | null
}

/** Overlay up to several independent native-editor drafts onto one fresh host graph. */
export function overlaySelectedDrafts(
  hostValue: { blocks: readonly PromptBlockDTO[]; promptVariableValues: PromptVariableValuesDTO },
  drafts: readonly WorkshopTransientDraft[],
): { blocks: PromptBlockDTO[]; promptVariableValues: PromptVariableValuesDTO } {
  let current = {
    blocks: [...hostValue.blocks],
    promptVariableValues: { ...hostValue.promptVariableValues },
  }

  for (const draft of drafts) {
    current = overlaySelectedDraft(current, draft.value, draft.selectedBlockId)
  }
  return current
}

