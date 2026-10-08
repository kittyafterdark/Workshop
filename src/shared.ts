import type {
  AssembleResultDTO,
  PromptBlockDTO,
  PromptVariableValuesDTO,
} from 'lumiverse-spindle-types'
import { isPresetSnapshot, type BackupSummary, type PresetBackup } from './backup-core.js'
import type { SpindlePresetEditorDraft } from 'lumiverse-spindle-types'

export type WorkshopBackupCommand =
  | { type: 'workshop:backup-create'; preset: SpindlePresetEditorDraft; kind: PresetBackup['kind'] }
  | { type: 'workshop:backup-list'; presetId: string }
  | { type: 'workshop:backup-read'; presetId: string; path: string }
export type WorkshopBackupRequest = WorkshopBackupCommand & { requestId: string }
export interface WorkshopBackupResponse {
  type: 'workshop:backup-result'
  requestId: string
  error?: string
  backup?: PresetBackup
  backups?: BackupSummary[]
}
export function isWorkshopBackupRequest(value: unknown): value is WorkshopBackupRequest {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  if (typeof item.requestId !== 'string' || item.requestId.length > 200) return false
  if (item.type === 'workshop:backup-create') return isPresetSnapshot(item.preset) && (item.kind === 'manual' || item.kind === 'before-apply')
  return typeof item.presetId === 'string' && (item.type === 'workshop:backup-list'
    || (item.type === 'workshop:backup-read' && typeof item.path === 'string'))
}
export function isWorkshopBackupResponse(value: unknown): value is WorkshopBackupResponse {
  return !!value && typeof value === 'object' && (value as WorkshopBackupResponse).type === 'workshop:backup-result'
    && typeof (value as WorkshopBackupResponse).requestId === 'string'
}

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
