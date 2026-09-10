import type {
  AssembleResultDTO,
  PromptBlockDTO,
  PromptVariableValuesDTO,
} from 'lumiverse-spindle-types'

export interface WorkshopAssembleRequest {
  type: 'workshop:assemble'
  requestId: string
  chatId: string
  blocks: PromptBlockDTO[]
  promptVariables: PromptVariableValuesDTO
}

export interface WorkshopCancelRequest {
  type: 'workshop:cancel-preview'
  requestId?: string
}

export type WorkshopFrontendMessage = WorkshopAssembleRequest | WorkshopCancelRequest

export interface WorkshopAssembleResult {
  type: 'workshop:assembly-result'
  requestId: string
  result: AssembleResultDTO
}

export interface WorkshopAssembleError {
  type: 'workshop:assembly-error'
  requestId: string
  error: string
}

export type WorkshopBackendMessage = WorkshopAssembleResult | WorkshopAssembleError

export function isWorkshopFrontendMessage(value: unknown): value is WorkshopFrontendMessage {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  if (candidate.type === 'workshop:cancel-preview') {
    return candidate.requestId === undefined || typeof candidate.requestId === 'string'
  }
  return candidate.type === 'workshop:assemble'
    && typeof candidate.requestId === 'string'
    && typeof candidate.chatId === 'string'
    && Array.isArray(candidate.blocks)
    && !!candidate.promptVariables
    && typeof candidate.promptVariables === 'object'
}

export function isWorkshopBackendMessage(value: unknown): value is WorkshopBackendMessage {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  if (candidate.type === 'workshop:assembly-result') {
    return typeof candidate.requestId === 'string'
      && !!candidate.result
      && typeof candidate.result === 'object'
  }
  if (candidate.type === 'workshop:assembly-error') {
    return typeof candidate.requestId === 'string' && typeof candidate.error === 'string'
  }
  return false
}
