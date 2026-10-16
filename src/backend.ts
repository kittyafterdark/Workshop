import { WorkshopAgentCoordinator } from './agent-backend.js'
import { WorkshopPreviewCoordinator } from './backend-core.js'
import { isWorkshopFrontendMessage } from './shared.js'
import { isWorkshopBackupRequest } from './shared.js'
import { PresetBackupStore } from './backup-core.js'
import { BackupManager } from './backup-manager.js'

declare const spindle: import('lumiverse-spindle-types').SpindleAPI

const previews = new WorkshopPreviewCoordinator({
  assemble: (input, userId) => spindle.assemble(input, userId),
  sendToFrontend: (payload, userId) => spindle.sendToFrontend(payload, userId),
})
const agents = new WorkshopAgentCoordinator(spindle)
const backups = new BackupManager(new PresetBackupStore(spindle.ephemeral), spindle.userStorage)
// Cleanup also runs on every backup operation; the host TTL survives extension reloads.
const prune = () => { void spindle.ephemeral.clearExpired().catch(() => {}) }
prune()
setInterval(prune, 60 * 60 * 1000)

spindle.onFrontendMessage((payload, userId) => {
  if (payload && typeof payload === 'object' && String((payload as { type?: unknown }).type).startsWith('workshop:agent-')) { void agents.handle(payload, userId); return }
  if (isWorkshopBackupRequest(payload)) {
    void backups.handle(payload, userId).then(response => spindle.sendToFrontend(response, userId))
    return
  }
  if (!isWorkshopFrontendMessage(payload)) return
  void previews.handle(payload, userId)
})

spindle.log.info('Workshop backend loaded')
