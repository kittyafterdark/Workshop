import { expect, test } from 'bun:test'
import type { SpindlePresetEditorDraft } from 'lumiverse-spindle-types'
import { PresetBackupStore, BACKUP_TTL_MS } from '../src/backup-core.js'
import { BackupManager } from '../src/backup-manager.js'
import { AutomaticBackups, DEFAULT_BACKUP_SETTINGS, isBackupSettings } from '../src/backup-settings.js'
import { isWorkshopBackupRequest, type WorkshopBackupCommand } from '../src/shared.js'

const preset = (id = 'p', name = 'Preset', content = 'one'): SpindlePresetEditorDraft => ({ id, name, blocks: [], parameters: { content }, prompts: {}, metadata: {}, createdAt: 1, updatedAt: 2 })
function fixture() {
  const files = new Map<string, string>(), preferences = new Map<string, string>()
  let now = 1000, sequence = 0, failure = false, deleted = false
  const store = new PresetBackupStore({
    async read(path) { if (!files.has(path)) throw Error('Missing'); return files.get(path)! },
    async write(path, data) { if (failure) throw Error('Full'); files.set(path, data) },
    async delete(path) { files.delete(path); deleted = true },
    async clearExpired() { let n = 0; for (const [path, data] of files) if (JSON.parse(data).expiresAt <= now) { files.delete(path); n++ } return n },
    async list(prefix = '') { return [...files.keys()].filter(p => p.startsWith(prefix)).map(p => p.slice(prefix.length)) },
  }, () => now, () => `id-${++sequence}`)
  const disk = {
    async exists(path: string, user?: string) { return preferences.has(`${user}:${path}`) },
    async read(path: string, user?: string) { return preferences.get(`${user}:${path}`)! },
    async write(path: string, data: string, user?: string) { preferences.set(`${user}:${path}`, data) },
  }
  const manager = new BackupManager(store, disk)
  const send = (command: WorkshopBackupCommand, user = 'u') => manager.handle({ ...command, requestId: 'request' }, user)
  return { send, store, files, preferences, remount: () => new BackupManager(store, disk), advance: (ms: number) => { now += ms }, fail: () => { failure = true }, deleted: () => deleted }
}

test('settings persist by user/preset, default off, and reject invalid intervals/counts at the boundary', async () => {
  const f = fixture()
  expect((await f.send({ type: 'workshop:backup-settings', presetId: 'p' })).settings).toEqual(DEFAULT_BACKUP_SETTINGS)
  const settings = { automatic: true, intervalMinutes: 5, keep: 3 }
  await f.send({ type: 'workshop:backup-settings', presetId: 'p', settings })
  expect((await f.remount().handle({ type: 'workshop:backup-settings', presetId: 'p', requestId: 'r' }, 'u')).settings).toEqual(settings)
  expect((await f.send({ type: 'workshop:backup-settings', presetId: 'other' })).settings).toEqual(DEFAULT_BACKUP_SETTINGS)
  expect((await f.send({ type: 'workshop:backup-settings', presetId: 'p' }, 'other-user')).settings).toEqual(DEFAULT_BACKUP_SETTINGS)
  f.preferences.set('u:backup-settings/p.json', '{corrupt')
  expect((await f.send({ type: 'workshop:backup-settings', presetId: 'p' })).error).toContain('unavailable')
  expect((await f.send({ type: 'workshop:backup-settings', presetId: 'p', settings })).settings).toEqual(settings)
  for (const invalid of [{ ...settings, keep: -1 }, { ...settings, keep: 1.5 }, { ...settings, intervalMinutes: 0 }, { ...settings, automatic: 'true' }]) {
    expect(isBackupSettings(invalid)).toBe(false)
    expect(isWorkshopBackupRequest({ type: 'workshop:backup-settings', presetId: 'p', requestId: 'r', settings: invalid })).toBe(false)
  }
})

test('count retention includes manual/pre-Apply/timed snapshots across renames, isolates ownership, and protects the new file', async () => {
  const f = fixture()
  await f.send({ type: 'workshop:backup-create', preset: preset('other'), kind: 'manual' })
  await f.send({ type: 'workshop:backup-create', preset: preset(), kind: 'manual' }, 'other-user')
  await f.send({ type: 'workshop:backup-create', preset: preset(), kind: 'manual' })
  f.advance(1)
  await f.send({ type: 'workshop:backup-create', preset: preset('p', 'Renamed'), kind: 'before-apply' })
  await f.send({ type: 'workshop:backup-settings', presetId: 'p', settings: { automatic: true, intervalMinutes: 1, keep: 1 } })
  expect((await f.store.list('p', 'u')).length).toBe(1)
  const result = await f.send({ type: 'workshop:backup-create', preset: preset('p', 'Renamed', 'new'), kind: 'automatic' })
  expect(result.error).toBeUndefined()
  expect((await f.store.list('p', 'u')).map(b => b.path)).toEqual([result.backup!.path])
  expect((await f.store.list('p', 'other-user')).length).toBe(1)
  expect((await f.store.list('other', 'u')).length).toBe(1)
  f.advance(BACKUP_TTL_MS)
  expect((await f.store.list('p', 'u')).length).toBe(0)
})

test('automatic snapshots opt in, coalesce concurrent unchanged saves, and retain recovery when writing fails', async () => {
  const f = fixture()
  expect((await f.send({ type: 'workshop:backup-create', preset: preset(), kind: 'automatic' })).backup).toBeUndefined()
  await f.send({ type: 'workshop:backup-settings', presetId: 'p', settings: { automatic: true, intervalMinutes: 1, keep: 1 } })
  await Promise.all([f.send({ type: 'workshop:backup-create', preset: preset(), kind: 'automatic' }), f.send({ type: 'workshop:backup-create', preset: preset(), kind: 'automatic' })])
  expect((await f.store.list('p', 'u')).length).toBe(1)
  expect((await f.send({ type: 'workshop:backup-create', preset: { ...preset(), updatedAt: 999 }, kind: 'automatic' })).backup).toBeUndefined()
  f.fail()
  expect((await f.send({ type: 'workshop:backup-create', preset: preset('p', 'Preset', 'changed'), kind: 'before-apply' })).error).toContain('unavailable')
  expect(f.deleted()).toBe(false)
  expect((await f.store.list('p', 'u')).length).toBe(1)
})

test('timer reconfiguration, in-flight work, disable and disposal never create overlapping or orphaned saves', async () => {
  let scheduled: (() => void) | null = null, delay = 0, saves = 0, release!: () => void
  const scheduler = new AutomaticBackups(async () => { saves++; await new Promise<void>(resolve => { release = resolve }) }, () => {},
    (fn, ms) => { scheduled = fn; delay = ms; return 1 as ReturnType<typeof setTimeout> }, () => { scheduled = null })
  scheduler.configure({ automatic: true, intervalMinutes: 2, keep: 0 })
  expect(delay).toBe(120000)
  scheduled!(); scheduled = null
  expect(saves).toBe(1)
  scheduler.configure({ automatic: true, intervalMinutes: 3, keep: 0 })
  expect(scheduled).toBeNull()
  release(); await new Promise(resolve => setTimeout(resolve, 0))
  expect(delay).toBe(180000)
  scheduler.configure(DEFAULT_BACKUP_SETTINGS)
  expect(scheduled).toBeNull()
  scheduler.configure({ automatic: true, intervalMinutes: 1, keep: 0 })
  const stale = scheduled!
  scheduler.destroy(); stale()
  expect(saves).toBe(1)
  expect(scheduled).toBeNull()
})
