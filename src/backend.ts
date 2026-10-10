import { WorkshopAgentCoordinator } from './agent-backend.js'
import { WorkshopPreviewCoordinator } from './backend-core.js'
import { isWorkshopFrontendMessage } from './shared.js'
import { isWorkshopBackupRequest, type WorkshopBackupResponse } from './shared.js'
import { PresetBackupStore } from './backup-core.js'

declare const spindle: import('lumiverse-spindle-types').SpindleAPI

const previews = new WorkshopPreviewCoordinator({
  assemble: (input, userId) => spindle.assemble(input, userId),
  sendToFrontend: (payload, userId) => spindle.sendToFrontend(payload, userId),
})
const agents = new WorkshopAgentCoordinator(spindle)
const backups = new PresetBackupStore(spindle.ephemeral)
// Cleanup also runs on every backup operation; the host TTL survives extension reloads.
const prune = () => { void spindle.ephemeral.clearExpired().catch(() => {}) }
prune()
setInterval(prune, 60 * 60 * 1000)

spindle.onFrontendMessage((payload, userId) => {
  if (payload && typeof payload === 'object' && String((payload as { type?: unknown }).type).startsWith('workshop:agent-')) { void agents.handle(payload, userId); return }
  if (isWorkshopBackupRequest(payload)) {
    void (async () => {
      const response: WorkshopBackupResponse = { type: 'workshop:backup-result', requestId: payload.requestId }
      try {
        if (payload.type === 'workshop:backup-create') response.backup = await backups.create(payload.preset, payload.kind, userId ?? '')
        else if (payload.type === 'workshop:backup-list') response.backups = await backups.list(payload.presetId, userId ?? '')
        else response.backup = await backups.read(payload.path, payload.presetId, userId ?? '')
      } catch { response.error = 'Backup storage is unavailable, full, or the backup has expired. Check Workshop’s transient-storage permission and pool allocation.' }
      spindle.sendToFrontend(response, userId)
    })()
    return
  }
  if (!isWorkshopFrontendMessage(payload)) return
  void previews.handle(payload, userId)
})

spindle.log.info('Workshop backend loaded')
