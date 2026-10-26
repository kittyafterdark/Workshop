import type { PromptBlockDTO } from 'lumiverse-spindle-types'
import { computePromptGroups } from './workshop-core.js'

// Public Loom marker identifiers and factory defaults (spindle types 0.6.31).
// Kept here rather than importing private host frontend modules.
export const PROMPT_MARKERS = [
  ['chat_history', 'Chat History'], ['world_info_before', 'World Info (Before)'],
  ['world_info_after', 'World Info (After)'], ['char_description', 'Char Description'],
  ['char_personality', 'Char Personality'], ['persona_description', 'User Persona'],
  ['scenario', 'Scenario'], ['dialogue_examples', 'Example Messages'],
  ['main_prompt', 'Main Prompt'], ['enhance_definitions', 'Enhance Definitions'],
  ['jailbreak', 'Post-History Instructions'], ['nsfw_prompt', 'NSFW Prompt'],
] as const
const structural = new Set<string>(PROMPT_MARKERS.slice(0, 8).map(([id]) => id))
export const structureProtected = (block: PromptBlockDTO): boolean => block.isLocked && !structural.has(block.marker ?? '')
const memberships = (blocks: readonly PromptBlockDTO[]) => new Map(computePromptGroups(blocks).flatMap(group =>
  group.children.map(block => [block.id, group.categoryBlock?.id ?? null] as const)))

/** Detached structural edits. Every operation validates in memory before committing. */
export class PromptManagerDraft {
  private blocks: PromptBlockDTO[]
  constructor(blocks: readonly PromptBlockDTO[]) {
    if (blocks.some(block => !block.id) || new Set(blocks.map(block => block.id)).size !== blocks.length) throw Error('Prompt IDs are missing or duplicated. Repair them before managing the list.')
    this.blocks = structuredClone([...blocks])
  }
  snapshot(): PromptBlockDTO[] { return structuredClone(this.blocks) }
  private find(id: string): PromptBlockDTO {
    const block = this.blocks.find(block => block.id === id)
    if (!block) throw Error('The selected prompt no longer exists.')
    return block
  }
  private editable(id: string): PromptBlockDTO {
    const block = this.find(id)
    const parent = memberships(this.blocks).get(id)
    if (structureProtected(block) || (parent && structureProtected(this.find(parent)))) throw Error('Locked prompts and locked categories cannot be reorganized or deleted.')
    return block
  }
  private category(id: string | null): void {
    if (id === null) return
    const category = this.find(id)
    if (category.marker !== 'category') throw Error('Choose an existing category.')
    if (structureProtected(category)) throw Error('Locked categories cannot receive prompts.')
  }
  private end(blocks: PromptBlockDTO[], categoryId: string | null): number {
    if (categoryId === null) return blocks.length
    const group = computePromptGroups(blocks).find(group => group.categoryBlock?.id === categoryId)
    if (!group) throw Error('The target category no longer exists.')
    return blocks.indexOf(group.children.at(-1) ?? group.categoryBlock!) + 1
  }
  private reconcile(next: PromptBlockDTO[], expected: Map<string, string | null>): void {
    // Legacy blocks can inherit their category. Only make a boundary explicit when
    // this operation would otherwise change an unrelated block's membership.
    const actual = memberships(next)
    for (const block of next) {
      if (block.marker !== 'category' && actual.get(block.id) !== expected.get(block.id)) {
        block.group = expected.get(block.id) ?? null
      }
    }
    const result = memberships(next)
    if (next.some(block => block.marker !== 'category' && result.get(block.id) !== expected.get(block.id))) throw Error('That placement would split a category. Choose a category boundary.')
  }
  private commit(next: PromptBlockDTO[], expected: Map<string, string | null>): void {
    this.reconcile(next, expected)
    this.blocks = next
  }
  add(kind: 'prompt' | 'category' | 'marker', name: string, categoryId: string | null, marker?: string): string {
    if (!name.trim()) throw Error('Enter a title.')
    if (kind === 'category' && categoryId !== null) throw Error('Categories cannot be nested.')
    this.category(categoryId)
    if (kind === 'marker' && !PROMPT_MARKERS.some(([id]) => id === marker)) throw Error('Choose a supported marker.')
    const type = kind === 'category' ? 'category' : kind === 'marker' ? marker! : null
    const block: PromptBlockDTO = { id: crypto.randomUUID(), name: name.trim(), content: '', role: 'system',
      enabled: true, position: 'pre_history', depth: 0, marker: type, isLocked: structural.has(type ?? ''),
      color: null, injectionTrigger: [], characterTagTrigger: [], group: categoryId, categoryMode: null }
    const next = this.snapshot(), expected = memberships(this.blocks)
    next.splice(this.end(next, categoryId), 0, block)
    if (kind !== 'category') expected.set(block.id, categoryId)
    this.commit(next, expected)
    return block.id
  }
  moveTo(id: string, categoryId: string | null): void {
    this.moveManyTo([id], categoryId)
  }
  moveManyTo(ids: readonly string[], categoryId: string | null): void {
    if (!ids.length) return
    if (new Set(ids).size !== ids.length) throw Error('Select each prompt only once.')
    for (const id of ids) {
      if (this.editable(id).marker === 'category') throw Error('Move categories using the list or Move up/down.')
    }
    this.category(categoryId)
    const selected = new Set(ids), expected = memberships(this.blocks)
    const next = this.snapshot().filter(block => !selected.has(block.id))
    // Removing an explicit root breakout must not absorb inherited root items
    // into the destination category before its insertion boundary is computed.
    this.reconcile(next, expected)
    const moving = this.snapshot().filter(block => selected.has(block.id)).map(block => ({ ...block, group: categoryId }))
    for (const id of ids) expected.set(id, categoryId)
    next.splice(this.end(next, categoryId), 0, ...moving)
    this.commit(next, expected)
  }
  moveRelative(id: string, targetId: string, after: boolean): void {
    if (id === targetId) return
    const block = this.editable(id), target = this.find(targetId), expected = memberships(this.blocks)
    const group = computePromptGroups(this.blocks).find(group => group.categoryBlock?.id === id)
    const ids = new Set([id, ...(group?.children.map(child => child.id) ?? [])])
    if (ids.has(targetId)) throw Error('A category cannot be dropped inside itself.')
    if (group?.children.some(structureProtected)) throw Error('This category contains locked prompts and cannot be moved.')
    const next = this.snapshot().filter(block => !ids.has(block.id))
    let index = next.findIndex(block => block.id === targetId) + Number(after)
    const moving = this.snapshot().filter(block => ids.has(block.id))
    if (block.marker === 'category') {
      if (target.marker !== 'category' && expected.get(targetId) !== null) throw Error('Categories must be dropped between categories or ungrouped prompts.')
      if (target.marker === 'category' && after) index = this.end(next, target.id)
    } else {
      const parent = target.marker === 'category' ? (after ? target.id : null) : expected.get(targetId) ?? null
      this.category(parent)
      moving[0].group = parent
      expected.set(id, parent)
    }
    next.splice(index, 0, ...moving)
    this.commit(next, expected)
  }
  stepTarget(id: string, direction: -1 | 1): string | null {
    const block = this.find(id), groups = computePromptGroups(this.blocks)
    const parent = groups.find(group => group.children.some(child => child.id === id))
    const siblings = block.marker === 'category' || !parent?.categoryBlock
      ? groups.flatMap(group => group.categoryBlock ? [group.categoryBlock] : group.children)
      : parent.children
    return siblings[siblings.findIndex(block => block.id === id) + direction]?.id ?? null
  }
  step(id: string, direction: -1 | 1): void {
    const targetId = this.stepTarget(id, direction)
    if (!targetId) return
    const block = this.editable(id), target = this.find(targetId)
    if (block.marker !== 'category' && memberships(this.blocks).get(id) === null && target.marker === 'category' && direction === 1) {
      // Keyboard movement across a category skips the entire group; it does not
      // implicitly reparent a root prompt as a drop below the header would.
      const next = this.snapshot().filter(block => block.id !== id)
      next.splice(this.end(next, targetId), 0, { ...structuredClone(block), group: null })
      this.commit(next, memberships(this.blocks))
    } else this.moveRelative(id, targetId, direction === 1)
  }
  remove(id: string, children: 'keep' | 'delete' = 'keep'): void {
    const block = this.editable(id), next = this.snapshot(), expected = memberships(this.blocks)
    const group = block.marker === 'category' ? computePromptGroups(this.blocks).find(group => group.categoryBlock?.id === id) : null
    if (group?.children.some(structureProtected)) throw Error('This category contains locked prompts and cannot be deleted.')
    const removed = new Set([id, ...(children === 'delete' ? group?.children.map(child => child.id) ?? [] : [])])
    if (children === 'keep') for (const child of group?.children ?? []) expected.set(child.id, null)
    this.commit(next.filter(block => !removed.has(block.id)), expected)
  }
}
