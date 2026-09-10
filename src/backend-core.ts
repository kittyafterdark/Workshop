import type { AssembleRequestDTO, AssembleResultDTO } from 'lumiverse-spindle-types'
import type { WorkshopFrontendMessage } from './shared.js'

export interface WorkshopAssemblyHost {
  assemble(input: AssembleRequestDTO, userId?: string): Promise<AssembleResultDTO>
  sendToFrontend(payload: unknown, userId?: string): void
}

interface ActiveAssembly {
  requestId: string
  controller: AbortController
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return typeof error === 'string' ? error : 'Prompt assembly failed.'
}

export class WorkshopPreviewCoordinator {
  private readonly activeByUser = new Map<string, ActiveAssembly>()

  constructor(private readonly host: WorkshopAssemblyHost) {}

  async handle(message: WorkshopFrontendMessage, userId: string): Promise<void> {
    if (message.type === 'workshop:cancel-preview') {
      const active = this.activeByUser.get(userId)
      if (!active) return
      if (message.requestId && message.requestId !== active.requestId) return
      active.controller.abort()
      this.activeByUser.delete(userId)
      return
    }

    const previous = this.activeByUser.get(userId)
    previous?.controller.abort()

    const controller = new AbortController()
    const active: ActiveAssembly = { requestId: message.requestId, controller }
    this.activeByUser.set(userId, active)

    try {
      const result = await this.host.assemble({
        chatId: message.chatId,
        blocks: message.blocks,
        promptVariables: message.promptVariables,
        signal: controller.signal,
      }, userId)

      if (this.activeByUser.get(userId) !== active || controller.signal.aborted) return
      this.host.sendToFrontend({
        type: 'workshop:assembly-result',
        requestId: message.requestId,
        result,
      }, userId)
    } catch (error) {
      if (controller.signal.aborted || this.activeByUser.get(userId) !== active) return
      this.host.sendToFrontend({
        type: 'workshop:assembly-error',
        requestId: message.requestId,
        error: errorMessage(error),
      }, userId)
    } finally {
      if (this.activeByUser.get(userId) === active) this.activeByUser.delete(userId)
    }
  }

  dispose(): void {
    for (const active of this.activeByUser.values()) active.controller.abort()
    this.activeByUser.clear()
  }
}
