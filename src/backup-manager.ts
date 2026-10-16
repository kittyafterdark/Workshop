import { PresetBackupStore, presetFingerprint } from './backup-core.js'
import { DEFAULT_BACKUP_SETTINGS, isBackupSettings, type BackupSettings } from './backup-settings.js'
import type { WorkshopBackupRequest, WorkshopBackupResponse } from './shared.js'

interface PreferencesDisk {
  exists(path: string, userId?: string): Promise<boolean>
  read(path: string, userId?: string): Promise<string>
  write(path: string, data: string, userId?: string): Promise<void>
}
/** Serialize retention and settings per user/preset, including concurrent browser windows. */
export class BackupManager {
  private pending = new Map<string, Promise<unknown>>()
  constructor(private store: PresetBackupStore, private preferences: PreferencesDisk) {}
  async handle(request: WorkshopBackupRequest, userId?: string): Promise<WorkshopBackupResponse> {
    const presetId = request.type === 'workshop:backup-create' ? request.preset.id : request.presetId
    const key = JSON.stringify([userId ?? '', presetId])
    const task = (this.pending.get(key) ?? Promise.resolve()).catch(() => {}).then(() => this.execute(request, presetId, userId))
    this.pending.set(key, task)
    try { return await task } finally { if (this.pending.get(key) === task) this.pending.delete(key) }
  }
  private async execute(request: WorkshopBackupRequest, presetId: string, userId?: string): Promise<WorkshopBackupResponse> {
    const response: WorkshopBackupResponse = { type: 'workshop:backup-result', requestId: request.requestId }
    try {
      const path = `backup-settings/${encodeURIComponent(presetId)}.json`
      let settings: BackupSettings = { ...DEFAULT_BACKUP_SETTINGS }
      if (!(request.type === 'workshop:backup-settings' && request.settings) && await this.preferences.exists(path, userId)) {
        const saved: unknown = JSON.parse(await this.preferences.read(path, userId))
        if (!isBackupSettings(saved)) throw Error('Invalid backup settings.')
        settings = saved
      }
      if (request.type === 'workshop:backup-settings') {
        if (request.settings) {
          settings = request.settings
          await this.preferences.write(path, JSON.stringify(settings), userId)
          response.settings = settings
          await this.store.prune(presetId, userId ?? '', settings.keep)
        }
        response.settings = settings
      } else if (request.type === 'workshop:backup-create') {
        // Automatic requests are opt-in and coalesce unchanged snapshots across windows.
        if (request.kind === 'automatic') {
          if (!settings.automatic) return response
          const newest = (await this.store.list(presetId, userId ?? ''))[0]
          if (newest && presetFingerprint((await this.store.read(newest.path, presetId, userId ?? '')).preset) === presetFingerprint(request.preset)) return response
        }
        response.backup = await this.store.create(request.preset, request.kind, userId ?? '')
        await this.store.prune(presetId, userId ?? '', settings.keep, response.backup.path)
      } else if (request.type === 'workshop:backup-list') response.backups = await this.store.list(presetId, userId ?? '')
      else response.backup = await this.store.read(request.path, presetId, userId ?? '')
    } catch {
      response.error = response.settings ? 'Settings saved, but old backups could not be removed. Check transient-storage access and retry.'
        : 'Backup storage is unavailable, full, expired, or its settings are invalid. Check Workshop’s transient-storage permission and pool allocation.'
    }
    return response
  }
}
