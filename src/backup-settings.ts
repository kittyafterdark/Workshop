export interface BackupSettings {
  automatic: boolean
  intervalMinutes: number
  keep: number
}
export const DEFAULT_BACKUP_SETTINGS: BackupSettings = { automatic: false, intervalMinutes: 15, keep: 0 }
export function isBackupSettings(value: unknown): value is BackupSettings {
  if (!value || typeof value !== 'object') return false
  const s = value as BackupSettings
  return typeof s.automatic === 'boolean' && Number.isInteger(s.intervalMinutes) && s.intervalMinutes >= 1 && s.intervalMinutes <= 1440
    && Number.isInteger(s.keep) && s.keep >= 0 && s.keep <= 10000
}

/** One timer per mounted workspace; async saves never overlap or survive disposal. */
export class AutomaticBackups {
  private timer: ReturnType<typeof setTimeout> | null = null
  private settings = { ...DEFAULT_BACKUP_SETTINGS }
  private disposed = false
  private busy = false
  constructor(private save: () => Promise<void>, private report: (error: unknown) => void,
    private schedule = (fn: () => void, ms: number) => setTimeout(fn, ms),
    private clear = (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer)) {}
  configure(settings: BackupSettings): void { this.settings = { ...settings }; this.arm() }
  private arm(): void {
    if (this.timer !== null) this.clear(this.timer)
    this.timer = null
    if (!this.disposed && !this.busy && this.settings.automatic) this.timer = this.schedule(() => { void this.tick() }, this.settings.intervalMinutes * 60000)
  }
  private async tick(): Promise<void> {
    this.timer = null
    if (this.disposed || this.busy || !this.settings.automatic) return
    this.busy = true
    try { await this.save() } catch (error) { if (!this.disposed) this.report(error) }
    finally { this.busy = false; this.arm() }
  }
  destroy(): void { this.disposed = true; this.arm() }
}
