import type { SpindlePresetEditorDraft } from 'lumiverse-spindle-types'

export const BACKUP_TTL_MS = 7 * 24 * 60 * 60 * 1000
export interface PresetBackup {
  version: 1
  path: string
  userId: string
  createdAt: number
  expiresAt: number
  kind: 'manual' | 'before-apply'
  preset: SpindlePresetEditorDraft
}
export type BackupSummary = Omit<PresetBackup, 'preset' | 'userId' | 'version'> & { name: string; blockCount: number }
export interface BackupDisk {
  read(path: string): Promise<string>
  write(path: string, data: string, options: { ttlMs: number }): Promise<void>
  list(prefix?: string): Promise<string[]>
  clearExpired(): Promise<number>
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export function isPresetSnapshot(value: unknown): value is SpindlePresetEditorDraft {
  if (!record(value)) return false
  return typeof value.id === 'string' && !!value.id && typeof value.name === 'string' && !!value.name.trim()
    && Array.isArray(value.blocks) && value.blocks.every(block => record(block)
      && typeof block.id === 'string' && typeof block.name === 'string' && typeof block.content === 'string'
      && typeof block.role === 'string')
    && record(value.parameters) && record(value.prompts) && record(value.metadata)
    && typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
    && typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
}

/** Compare editable data, ignoring host save timestamps and object-key ordering. */
export function presetFingerprint(preset: SpindlePresetEditorDraft): string {
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
    : record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value
  return JSON.stringify(stable({ id: preset.id, name: preset.name, blocks: preset.blocks,
    parameters: preset.parameters, prompts: preset.prompts, metadata: preset.metadata }))
}

export function backupFolder(name: string): string {
  let segment = name.normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100).trim()
  if (!segment || segment === '.' || segment === '..') segment = 'Untitled preset'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) segment = '_' + segment
  return `storage/${segment}/backups/`
}
const managedPath = (path: string) => !['.', '..'].includes(path.split('/')[1]) && /^storage\/[^/\\]+\/backups\/\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.\d{3} UTC--[a-zA-Z0-9-]+\.json$/.test(path)

/** The host ephemeral pool owns expiry; no private filesystem access or browser storage. */
export class PresetBackupStore {
  constructor(private disk: BackupDisk, private now = Date.now, private unique = () => crypto.randomUUID()) {}
  async create(preset: SpindlePresetEditorDraft, kind: PresetBackup['kind'], userId: string): Promise<PresetBackup> {
    if (!isPresetSnapshot(preset)) throw new Error('Invalid preset snapshot.')
    await this.disk.clearExpired()
    const createdAt = this.now()
    const stamp = new Date(createdAt).toISOString().replace('T', ' ').replace(/:/g, '-').replace('Z', ' UTC')
    const path = `${backupFolder(preset.name)}${stamp}--${this.unique()}.json`
    if (!managedPath(path)) throw new Error('Invalid backup path.')
    const backup: PresetBackup = { version: 1, path, userId, createdAt, expiresAt: createdAt + BACKUP_TTL_MS, kind, preset: structuredClone(preset) }
    await this.disk.write(path, JSON.stringify(backup, null, 2), { ttlMs: BACKUP_TTL_MS })
    return backup
  }
  async read(path: string, presetId: string, userId: string): Promise<PresetBackup> {
    if (!managedPath(path)) throw new Error('Invalid backup path.')
    const value: unknown = JSON.parse(await this.disk.read(path))
    if (!record(value) || value.version !== 1 || value.path !== path || value.userId !== userId
      || !isPresetSnapshot(value.preset) || value.preset.id !== presetId
      || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)
      || typeof value.expiresAt !== 'number' || value.expiresAt <= this.now()
      || value.expiresAt !== value.createdAt + BACKUP_TTL_MS
      || (value.kind !== 'manual' && value.kind !== 'before-apply')) throw new Error('Backup expired, belongs to another preset, or is invalid.')
    return value as unknown as PresetBackup
  }
  async list(presetId: string, userId: string): Promise<BackupSummary[]> {
    await this.disk.clearExpired()
    const summaries: BackupSummary[] = []
    // Scan all name folders so renaming a preset does not hide its previous backups.
    for (const entry of await this.disk.list('storage/')) {
      // The API lists paths relative to the requested directory, including Windows separators.
      const path = 'storage/' + entry.replace(/\\/g, '/')
      if (!managedPath(path)) continue
      try {
        const backup = await this.read(path, presetId, userId)
        summaries.push({ path, createdAt: backup.createdAt, expiresAt: backup.expiresAt, kind: backup.kind,
          name: backup.preset.name, blockCount: backup.preset.blocks.length })
      } catch { /* An expired, corrupt, or unrelated entry is never offered for restore. */ }
    }
    return summaries.sort((a, b) => b.createdAt - a.createdAt || b.path.localeCompare(a.path))
  }
}

/** A whole public preset restore, staged locally against the host snapshot at selection. */
export class PresetRestoreDraft {
  readonly baseline: string
  readonly preset: SpindlePresetEditorDraft
  constructor(host: SpindlePresetEditorDraft, backup: SpindlePresetEditorDraft) {
    if (host.id !== backup.id || !isPresetSnapshot(backup)) throw new Error('Backup belongs to another preset or is invalid.')
    this.baseline = presetFingerprint(host)
    this.preset = structuredClone(backup)
  }
  matches(host: SpindlePresetEditorDraft): boolean { return this.baseline === presetFingerprint(host) }
  apply(host: SpindlePresetEditorDraft): SpindlePresetEditorDraft | null {
    if (!this.matches(host)) return null
    return { ...structuredClone(this.preset), id: host.id, createdAt: host.createdAt, updatedAt: host.updatedAt }
  }
}
