// src/backend-core.ts
function errorMessage(error) {
  if (error instanceof Error && error.message)
    return error.message;
  return typeof error === "string" ? error : "Prompt assembly failed.";
}

class WorkshopPreviewCoordinator {
  host;
  activeByUser = new Map;
  constructor(host) {
    this.host = host;
  }
  async handle(message, userId) {
    if (message.type === "workshop:cancel-preview") {
      const active = this.activeByUser.get(userId);
      if (!active)
        return;
      if (message.requestId && message.requestId !== active.requestId)
        return;
      active.controller.abort();
      this.activeByUser.delete(userId);
      return;
    }
    const previous = this.activeByUser.get(userId);
    previous?.controller.abort();
    const controller = new AbortController;
    const active = { requestId: message.requestId, controller };
    this.activeByUser.set(userId, active);
    try {
      const result = await this.host.assemble({
        chatId: message.chatId,
        blocks: message.blocks,
        promptVariables: message.promptVariables,
        signal: controller.signal
      }, userId);
      if (this.activeByUser.get(userId) !== active || controller.signal.aborted)
        return;
      this.host.sendToFrontend({
        type: "workshop:assembly-result",
        requestId: message.requestId,
        result
      }, userId);
    } catch (error) {
      if (controller.signal.aborted || this.activeByUser.get(userId) !== active)
        return;
      this.host.sendToFrontend({
        type: "workshop:assembly-error",
        requestId: message.requestId,
        error: errorMessage(error)
      }, userId);
    } finally {
      if (this.activeByUser.get(userId) === active)
        this.activeByUser.delete(userId);
    }
  }
  dispose() {
    for (const active of this.activeByUser.values())
      active.controller.abort();
    this.activeByUser.clear();
  }
}

// src/backup-core.ts
var BACKUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
var record = (value) => !!value && typeof value === "object" && !Array.isArray(value);
function isPresetSnapshot(value) {
  if (!record(value))
    return false;
  return typeof value.id === "string" && !!value.id && typeof value.name === "string" && !!value.name.trim() && Array.isArray(value.blocks) && value.blocks.every((block) => record(block) && typeof block.id === "string" && typeof block.name === "string" && typeof block.content === "string" && typeof block.role === "string") && record(value.parameters) && record(value.prompts) && record(value.metadata) && typeof value.createdAt === "number" && Number.isFinite(value.createdAt) && typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt);
}
function backupFolder(name) {
  let segment = name.normalize("NFKC").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").slice(0, 100).trim();
  if (!segment || segment === "." || segment === "..")
    segment = "Untitled preset";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))
    segment = "_" + segment;
  return `storage/${segment}/backups/`;
}
var managedPath = (path) => ![".", ".."].includes(path.split("/")[1]) && /^storage\/[^/\\]+\/backups\/\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.\d{3} UTC--[a-zA-Z0-9-]+\.json$/.test(path);

class PresetBackupStore {
  disk;
  now;
  unique;
  constructor(disk, now = Date.now, unique = () => crypto.randomUUID()) {
    this.disk = disk;
    this.now = now;
    this.unique = unique;
  }
  async create(preset, kind, userId) {
    if (!isPresetSnapshot(preset))
      throw new Error("Invalid preset snapshot.");
    await this.disk.clearExpired();
    const createdAt = this.now();
    const stamp = new Date(createdAt).toISOString().replace("T", " ").replace(/:/g, "-").replace("Z", " UTC");
    const path = `${backupFolder(preset.name)}${stamp}--${this.unique()}.json`;
    if (!managedPath(path))
      throw new Error("Invalid backup path.");
    const backup = { version: 1, path, userId, createdAt, expiresAt: createdAt + BACKUP_TTL_MS, kind, preset: structuredClone(preset) };
    await this.disk.write(path, JSON.stringify(backup, null, 2), { ttlMs: BACKUP_TTL_MS });
    return backup;
  }
  async read(path, presetId, userId) {
    if (!managedPath(path))
      throw new Error("Invalid backup path.");
    const value = JSON.parse(await this.disk.read(path));
    if (!record(value) || value.version !== 1 || value.path !== path || value.userId !== userId || !isPresetSnapshot(value.preset) || value.preset.id !== presetId || typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt) || typeof value.expiresAt !== "number" || value.expiresAt <= this.now() || value.expiresAt !== value.createdAt + BACKUP_TTL_MS || value.kind !== "manual" && value.kind !== "before-apply")
      throw new Error("Backup expired, belongs to another preset, or is invalid.");
    return value;
  }
  async list(presetId, userId) {
    await this.disk.clearExpired();
    const summaries = [];
    for (const entry of await this.disk.list("storage/")) {
      const path = "storage/" + entry.replace(/\\/g, "/");
      if (!managedPath(path))
        continue;
      try {
        const backup = await this.read(path, presetId, userId);
        summaries.push({
          path,
          createdAt: backup.createdAt,
          expiresAt: backup.expiresAt,
          kind: backup.kind,
          name: backup.preset.name,
          blockCount: backup.preset.blocks.length
        });
      } catch {}
    }
    return summaries.sort((a, b) => b.createdAt - a.createdAt || b.path.localeCompare(a.path));
  }
}

// src/shared.ts
function isWorkshopBackupRequest(value) {
  if (!value || typeof value !== "object")
    return false;
  const item = value;
  if (typeof item.requestId !== "string" || item.requestId.length > 200)
    return false;
  if (item.type === "workshop:backup-create")
    return isPresetSnapshot(item.preset) && (item.kind === "manual" || item.kind === "before-apply");
  return typeof item.presetId === "string" && (item.type === "workshop:backup-list" || item.type === "workshop:backup-read" && typeof item.path === "string");
}
function isWorkshopFrontendMessage(value) {
  if (!value || typeof value !== "object")
    return false;
  const candidate = value;
  if (candidate.type === "workshop:cancel-preview") {
    return candidate.requestId === undefined || typeof candidate.requestId === "string";
  }
  return candidate.type === "workshop:assemble" && typeof candidate.requestId === "string" && typeof candidate.chatId === "string" && Array.isArray(candidate.blocks) && !!candidate.promptVariables && typeof candidate.promptVariables === "object";
}

// src/backend.ts
var previews = new WorkshopPreviewCoordinator({
  assemble: (input, userId) => spindle.assemble(input, userId),
  sendToFrontend: (payload, userId) => spindle.sendToFrontend(payload, userId)
});
var backups = new PresetBackupStore(spindle.ephemeral);
var prune = () => {
  spindle.ephemeral.clearExpired().catch(() => {});
};
prune();
setInterval(prune, 60 * 60 * 1000);
spindle.onFrontendMessage((payload, userId) => {
  if (isWorkshopBackupRequest(payload)) {
    (async () => {
      const response = { type: "workshop:backup-result", requestId: payload.requestId };
      try {
        if (payload.type === "workshop:backup-create")
          response.backup = await backups.create(payload.preset, payload.kind, userId ?? "");
        else if (payload.type === "workshop:backup-list")
          response.backups = await backups.list(payload.presetId, userId ?? "");
        else
          response.backup = await backups.read(payload.path, payload.presetId, userId ?? "");
      } catch {
        response.error = "Backup storage is unavailable, full, or the backup has expired. Check Workshop’s transient-storage permission and pool allocation.";
      }
      spindle.sendToFrontend(response, userId);
    })();
    return;
  }
  if (!isWorkshopFrontendMessage(payload))
    return;
  previews.handle(payload, userId);
});
spindle.log.info("Workshop backend loaded");
