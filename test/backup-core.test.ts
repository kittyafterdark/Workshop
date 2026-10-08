import { describe, expect, test } from 'bun:test'
import type { SpindlePresetEditorDraft } from 'lumiverse-spindle-types'
import { BACKUP_TTL_MS, PresetBackupStore, PresetRestoreDraft, backupFolder, presetFingerprint } from '../src/backup-core.js'

const preset = (id = 'one', name = 'My preset'): SpindlePresetEditorDraft => ({ id, name, blocks: [], parameters: { temperature: 1 }, prompts: {}, metadata: {}, createdAt: 1, updatedAt: 2 })
function fixture() {
  let now = Date.parse('2026-10-08T14:23:05.123Z')
  let sequence = 0
  const files = new Map<string, { text: string; expiry: number }>()
  const store = new PresetBackupStore({
    async read(path) { const file = files.get(path); if (!file) throw Error('Missing'); return file.text },
    async write(path, text, options) { files.set(path, { text, expiry: now + options.ttlMs }) },
    async list(prefix = '') { return [...files.keys()].filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length).replaceAll('/', '\\')) },
    async clearExpired() { let count = 0; for (const [path, file] of files) if (file.expiry <= now) { files.delete(path); count++ } return count },
  }, () => now, () => `unique-${++sequence}`)
  return { store, files, advance: (ms: number) => { now += ms } }
}
describe('Preset backups', () => {
  test('uses readable UTC filenames in safe preset-name folders and seven-day host TTL', async () => {
    const { store, files } = fixture()
    const source = preset()
    const backup = await store.create(source, 'manual', 'user')
    expect(backup.path).toBe('storage/My preset/backups/2026-10-08 14-23-05.123 UTC--unique-1.json')
    expect(files.get(backup.path)?.expiry).toBe(backup.expiresAt)
    expect(backup.expiresAt - backup.createdAt).toBe(BACKUP_TTL_MS)
    source.name = 'Caller mutation'
    expect((await store.read(backup.path, 'one', 'user')).preset.name).toBe('My preset')
    expect(backupFolder('../CON: /bad\\name')).not.toContain('../')
    expect(backupFolder('CON')).toBe('storage/_CON/backups/')
  })
  test('lists newest first across renames, isolates user and preset, and ignores corrupt entries', async () => {
    const { store, files, advance } = fixture()
    const first = await store.create(preset(), 'manual', 'user')
    advance(1)
    const second = await store.create(preset('one', 'Renamed'), 'before-apply', 'user')
    await store.create(preset('other'), 'manual', 'user')
    await store.create(preset(), 'manual', 'other-user')
    files.set('storage/Bad/backups/2026-10-08 14-23-05.123 UTC--corrupt.json', { text: '{', expiry: Infinity })
    expect((await store.list('one', 'user')).map(item => item.path)).toEqual([second.path, first.path])
    await expect(store.read(first.path, 'other', 'user')).rejects.toThrow()
    await expect(store.read(first.path, 'one', 'other-user')).rejects.toThrow()
    await expect(store.read('../outside.json', 'one', 'user')).rejects.toThrow()
  })
  test('expired snapshots cannot restore and are automatically deleted at seven days', async () => {
    const { store, files, advance } = fixture()
    const backup = await store.create(preset(), 'manual', 'user')
    advance(BACKUP_TTL_MS - 1)
    expect((await store.list('one', 'user')).length).toBe(1)
    advance(1)
    await expect(store.read(backup.path, 'one', 'user')).rejects.toThrow()
    expect(await store.list('one', 'user')).toEqual([])
    expect(files.size).toBe(0)
  })
  test('propagates storage failures rather than returning an imaginary saved backup', async () => {
    const store = new PresetBackupStore({ async read() { return '' }, async list() { return [] }, async clearExpired() { return 0 }, async write() { throw Error('Full') } })
    await expect(store.create(preset(), 'manual', 'user')).rejects.toThrow('Full')
  })
  test('whole preset restore stays detached, refuses changed settings, and preserves host timestamps', () => {
    const host = preset()
    const backup = { ...preset(), name: 'Earlier name', parameters: { temperature: 0.5 } }
    const restore = new PresetRestoreDraft(host, backup)
    backup.name = 'Mutated'
    expect(host.name).toBe('My preset')
    const result = restore.apply({ ...host, createdAt: 10, updatedAt: 20 })!
    expect(result.name).toBe('Earlier name')
    expect(result.createdAt).toBe(10)
    expect(result.updatedAt).toBe(20)
    expect(restore.apply({ ...host, parameters: { temperature: 2 } })).toBeNull()
    expect(() => new PresetRestoreDraft(host, preset('other'))).toThrow()
    expect(presetFingerprint({ ...host, parameters: { a: 1, b: 2 } })).toBe(presetFingerprint({ ...host, parameters: { b: 2, a: 1 } }))
  })
})
