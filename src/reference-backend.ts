import type { PromptBlockDTO, SpindleAPI } from 'lumiverse-spindle-types'

export interface ReferencePreset { id: string; name: string; blocks: PromptBlockDTO[] }
export interface ReferenceResult {
  type: 'workshop:reference-result'
  requestId: string
  presets?: Array<{ id: string; name: string }>
  preset?: ReferencePreset
  error?: string
}

/** Only public reads, explicitly scoped to the requesting Lumi user. */
export class ReferenceReader {
  constructor(private readonly presets: Pick<SpindleAPI['presets'], 'list' | 'get'>,
    private readonly send: (payload: ReferenceResult, userId?: string) => void) {}
  async handle(payload: unknown, userId?: string): Promise<void> {
    if (!payload || typeof payload !== 'object') return
    const p = payload as Record<string, unknown>
    if (typeof p.requestId !== 'string' || p.requestId.length > 200) return
    const result: ReferenceResult = { type: 'workshop:reference-result', requestId: p.requestId }
    try {
      if (p.type === 'workshop:reference-list') {
        result.presets = []
        for (let offset = 0; ; ) {
          const page = await this.presets.list({ limit: 100, offset, userId })
          result.presets.push(...page.data.map(({ id, name }) => ({ id, name })))
          offset += page.data.length
          if (offset >= page.total) break
          if (!page.data.length || offset >= 10000) throw Error('Could not finish loading the preset list.')
        }
      } else if (p.type === 'workshop:reference-get' && typeof p.presetId === 'string' && p.presetId.length > 0 && p.presetId.length <= 500) {
        const preset = await this.presets.get(p.presetId, userId)
        if (!preset || preset.id !== p.presetId) throw Error('This reference preset is no longer available.')
        // Do not transfer settings, credentials, sealed provenance or editable host handles.
        result.preset = { id: preset.id, name: preset.name, blocks: preset.prompt_order.map(b => ({
          id: b.id, name: b.name, content: b.content, role: b.role, enabled: b.enabled,
          position: b.position, depth: b.depth, marker: b.marker, group: b.group,
          isLocked: b.isLocked, color: b.color, injectionTrigger: b.injectionTrigger,
        })) }
      } else throw Error('Invalid reference request.')
    } catch (error) { delete result.presets; result.error = error instanceof Error ? error.message : 'Could not read reference presets.' }
    this.send(result, userId)
  }
}
