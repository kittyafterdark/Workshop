// src/backup-core.ts
var BACKUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
var record = (value) => !!value && typeof value === "object" && !Array.isArray(value);
function isPresetSnapshot(value) {
  if (!record(value))
    return false;
  return typeof value.id === "string" && !!value.id && typeof value.name === "string" && !!value.name.trim() && Array.isArray(value.blocks) && value.blocks.every((block) => record(block) && typeof block.id === "string" && typeof block.name === "string" && typeof block.content === "string" && typeof block.role === "string") && record(value.parameters) && record(value.prompts) && record(value.metadata) && typeof value.createdAt === "number" && Number.isFinite(value.createdAt) && typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt);
}
function presetFingerprint(preset) {
  const stable = (value) => Array.isArray(value) ? value.map(stable) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
  return JSON.stringify(stable({
    id: preset.id,
    name: preset.name,
    blocks: preset.blocks,
    parameters: preset.parameters,
    prompts: preset.prompts,
    metadata: preset.metadata
  }));
}
class PresetRestoreDraft {
  baseline;
  preset;
  constructor(host, backup) {
    if (host.id !== backup.id || !isPresetSnapshot(backup))
      throw new Error("Backup belongs to another preset or is invalid.");
    this.baseline = presetFingerprint(host);
    this.preset = structuredClone(backup);
  }
  matches(host) {
    return this.baseline === presetFingerprint(host);
  }
  apply(host) {
    if (!this.matches(host))
      return null;
    return { ...structuredClone(this.preset), id: host.id, createdAt: host.createdAt, updatedAt: host.updatedAt };
  }
}

// src/backup-settings.ts
var DEFAULT_BACKUP_SETTINGS = { automatic: false, intervalMinutes: 15, keep: 0 };
function isBackupSettings(value) {
  if (!value || typeof value !== "object")
    return false;
  const s = value;
  return typeof s.automatic === "boolean" && Number.isInteger(s.intervalMinutes) && s.intervalMinutes >= 1 && s.intervalMinutes <= 1440 && Number.isInteger(s.keep) && s.keep >= 0 && s.keep <= 1e4;
}

class AutomaticBackups {
  save;
  report;
  schedule;
  clear;
  timer = null;
  settings = { ...DEFAULT_BACKUP_SETTINGS };
  disposed = false;
  busy = false;
  constructor(save, report, schedule = (fn, ms) => setTimeout(fn, ms), clear = (timer) => clearTimeout(timer)) {
    this.save = save;
    this.report = report;
    this.schedule = schedule;
    this.clear = clear;
  }
  configure(settings) {
    this.settings = { ...settings };
    this.arm();
  }
  arm() {
    if (this.timer !== null)
      this.clear(this.timer);
    this.timer = null;
    if (!this.disposed && !this.busy && this.settings.automatic)
      this.timer = this.schedule(() => {
        this.tick();
      }, this.settings.intervalMinutes * 60000);
  }
  async tick() {
    this.timer = null;
    if (this.disposed || this.busy || !this.settings.automatic)
      return;
    this.busy = true;
    try {
      await this.save();
    } catch (error) {
      if (!this.disposed)
        this.report(error);
    } finally {
      this.busy = false;
      this.arm();
    }
  }
  destroy() {
    this.disposed = true;
    this.arm();
  }
}

// src/shared.ts
function isWorkshopBackupResponse(value) {
  return !!value && typeof value === "object" && value.type === "workshop:backup-result" && typeof value.requestId === "string";
}
function isWorkshopBackendMessage(value) {
  if (!value || typeof value !== "object")
    return false;
  const candidate = value;
  if (candidate.type === "workshop:assembly-result") {
    return typeof candidate.requestId === "string" && !!candidate.result && typeof candidate.result === "object";
  }
  if (candidate.type === "workshop:assembly-error") {
    return typeof candidate.requestId === "string" && typeof candidate.error === "string";
  }
  return false;
}

// src/workshop-core.ts
function parsePromptVariableReferences(content) {
  const refs = [];
  const opener = /\{\{\s*var\s*::/gi;
  for (const match of content.matchAll(opener)) {
    const start = match.index ?? -1;
    if (start < 0)
      continue;
    const close = content.indexOf("}}", start + match[0].length);
    if (close < 0)
      continue;
    const raw = content.slice(start, close + 2);
    const body = content.slice(start + 2, close).trim();
    const parts = body.split("::").map((part) => part.trim());
    if (parts[0]?.toLowerCase() !== "var" || !parts[1])
      continue;
    refs.push({
      name: parts[1],
      raw,
      mode: parts[2] || null,
      arguments: parts.slice(3).filter(Boolean),
      start,
      end: close + 2
    });
  }
  return refs;
}
function valueForDefinition(blockId, definition, values) {
  const stored = values[blockId]?.[definition.name];
  return stored === undefined ? definition.defaultValue : stored;
}
function optionLabel(definition, id) {
  if (definition.type !== "select" && definition.type !== "multiselect")
    return id;
  return definition.options.find((option) => option.id === id)?.label ?? id;
}
function optionValue(definition, id) {
  if (definition.type !== "select" && definition.type !== "multiselect")
    return id;
  return definition.options.find((option) => option.id === id)?.value ?? id;
}
function describePromptVariableValue(definition, value) {
  if (definition.type === "select") {
    const id = typeof value === "string" ? value : String(value);
    return { display: optionLabel(definition, id), resolved: optionValue(definition, id) };
  }
  if (definition.type === "multiselect") {
    const ids = Array.isArray(value) ? value : [];
    const separator = definition.separator ?? `

`;
    return {
      display: ids.map((id) => optionLabel(definition, id)).join(", ") || "None selected",
      resolved: ids.map((id) => optionValue(definition, id)).join(separator)
    };
  }
  if (definition.type === "switch") {
    const on = value === 1 || value === "1";
    return { display: on ? "On" : "Off", resolved: on ? "1" : "0" };
  }
  if (Array.isArray(value)) {
    const joined = value.join(", ");
    return { display: joined, resolved: joined };
  }
  const text = String(value ?? "");
  return { display: text || "Empty", resolved: text };
}
function blockReferenceMap(blocks) {
  const byVariable = new Map;
  for (const block of blocks) {
    for (const reference of parsePromptVariableReferences(block.content ?? "")) {
      let perBlock = byVariable.get(reference.name);
      if (!perBlock) {
        perBlock = new Map;
        byVariable.set(reference.name, perBlock);
      }
      const current = perBlock.get(block.id) ?? { blockName: block.name, count: 0, macros: new Set };
      current.count += 1;
      current.macros.add(reference.raw);
      perBlock.set(block.id, current);
    }
  }
  return new Map([...byVariable.entries()].map(([name, perBlock]) => [
    name,
    [...perBlock.entries()].map(([blockId, value]) => ({
      blockId,
      blockName: value.blockName,
      count: value.count,
      macros: [...value.macros]
    }))
  ]));
}
function buildVariableIndex(blocks, promptVariableValues) {
  const refsByVariable = blockReferenceMap(blocks);
  const definitionsByName = new Map;
  const blockIdCounts = new Map;
  let definitionCount = 0;
  for (const block of blocks) {
    blockIdCounts.set(block.id, (blockIdCounts.get(block.id) ?? 0) + 1);
    for (const definition of block.variables ?? []) {
      definitionCount += 1;
      const storedValue = valueForDefinition(block.id, definition, promptVariableValues);
      const described = describePromptVariableValue(definition, storedValue);
      const list = definitionsByName.get(definition.name) ?? [];
      list.push({
        blockId: block.id,
        blockName: block.name,
        definition,
        storedValue,
        displayValue: described.display,
        resolvedValue: described.resolved
      });
      definitionsByName.set(definition.name, list);
    }
  }
  const names = new Set([...definitionsByName.keys(), ...refsByVariable.keys()]);
  const variables = [];
  const missing = [];
  for (const name of names) {
    const definitions = definitionsByName.get(name) ?? [];
    const references = refsByVariable.get(name) ?? [];
    if (definitions.length === 0) {
      missing.push({ name, macro: `{{var::${name}}}`, references });
      continue;
    }
    variables.push({
      name,
      macro: `{{var::${name}}}`,
      definitions,
      references,
      duplicateDefinition: definitions.length > 1,
      unused: references.length === 0
    });
  }
  variables.sort((a, b) => {
    const aOwner = a.definitions[0]?.blockName ?? "";
    const bOwner = b.definitions[0]?.blockName ?? "";
    return aOwner.localeCompare(bOwner) || a.name.localeCompare(b.name);
  });
  missing.sort((a, b) => a.name.localeCompare(b.name));
  return {
    variables,
    byName: new Map(variables.map((entry) => [entry.name, entry])),
    missing,
    duplicateBlockIds: [...blockIdCounts.entries()].filter(([, count]) => count > 1).map(([id]) => id),
    definitionCount,
    referenceCount: [...refsByVariable.values()].flat().reduce((sum, reference) => sum + reference.count, 0)
  };
}

class WorkshopVariableSandbox {
  overrides = new Map;
  signature(entry) {
    return entry.definitions.length === 1 ? JSON.stringify([entry.definitions[0].blockId, entry.definitions[0].definition]) : null;
  }
  set(entry, value) {
    const signature = this.signature(entry);
    if (!signature)
      return false;
    const definition = entry.definitions[0].definition;
    let valid = false;
    switch (definition.type) {
      case "text":
      case "textarea":
        valid = typeof value === "string";
        break;
      case "switch":
        valid = value === 0 || value === 1;
        break;
      case "select":
        valid = typeof value === "string" && definition.options.some((option) => option.id === value);
        break;
      case "multiselect":
        valid = Array.isArray(value) && value.every((id) => definition.options.some((option) => option.id === id));
        break;
      case "number":
      case "slider":
        valid = typeof value === "number" && Number.isFinite(value) && (definition.min === undefined || value >= definition.min) && (definition.max === undefined || value <= definition.max);
        break;
    }
    if (!valid)
      return false;
    this.overrides.set(entry.name, { signature, value: Array.isArray(value) ? [...value] : value });
    return true;
  }
  reset(name) {
    if (name === undefined)
      this.overrides.clear();
    else
      this.overrides.delete(name);
  }
  has(name) {
    return this.overrides.has(name);
  }
  get size() {
    return this.overrides.size;
  }
  overlay(blocks, values) {
    const index = buildVariableIndex(blocks, values);
    const result = { ...values };
    for (const [name, override] of this.overrides) {
      const entry = index.byName.get(name);
      if (!entry || this.signature(entry) !== override.signature || index.duplicateBlockIds.includes(entry.definitions[0].blockId)) {
        this.overrides.delete(name);
        continue;
      }
      const blockId = entry.definitions[0].blockId;
      result[blockId] = { ...result[blockId], [name]: Array.isArray(override.value) ? [...override.value] : override.value };
    }
    return result;
  }
}
function computePromptGroups(blocks) {
  if (blocks.length === 0)
    return [];
  const result = [];
  let currentGroup = { categoryBlock: null, children: [] };
  for (const block of blocks) {
    if (block.marker === "category") {
      if (currentGroup.categoryBlock || currentGroup.children.length > 0)
        result.push(currentGroup);
      currentGroup = { categoryBlock: block, children: [] };
      continue;
    }
    if (block.group !== undefined && block.group !== (currentGroup.categoryBlock?.id ?? null)) {
      if (currentGroup.categoryBlock || currentGroup.children.length > 0)
        result.push(currentGroup);
      currentGroup = { categoryBlock: null, children: [] };
    }
    currentGroup.children.push(block);
  }
  if (currentGroup.categoryBlock || currentGroup.children.length > 0)
    result.push(currentGroup);
  return result;
}
function replaceUniqueBlock(currentBlocks, editedBlocks, blockId) {
  const sourceMatches = editedBlocks.filter((block) => block.id === blockId);
  if (sourceMatches.length === 0)
    return { ok: false, blocks: [...currentBlocks], reason: "missing_source" };
  if (sourceMatches.length > 1)
    return { ok: false, blocks: [...currentBlocks], reason: "ambiguous_source" };
  const targetIndexes = [];
  currentBlocks.forEach((block, index) => {
    if (block.id === blockId)
      targetIndexes.push(index);
  });
  if (targetIndexes.length === 0)
    return { ok: false, blocks: [...currentBlocks], reason: "missing_target" };
  if (targetIndexes.length > 1)
    return { ok: false, blocks: [...currentBlocks], reason: "ambiguous_target" };
  const next = [...currentBlocks];
  next[targetIndexes[0]] = sourceMatches[0];
  return { ok: true, blocks: next };
}
function promptBlockSearchText(block) {
  return [
    block.name,
    block.content,
    block.role,
    ...(block.variables ?? []).flatMap((variable) => [variable.name, variable.label, variable.description ?? ""])
  ].join(`
`).toLowerCase();
}
function blockVariableStats(block) {
  return {
    definitions: block.variables?.length ?? 0,
    references: new Set(parsePromptVariableReferences(block.content ?? "").map((ref) => ref.name)).size
  };
}
function overlaySelectedDraft(hostValue, draftValue, selectedBlockId) {
  if (!draftValue || !selectedBlockId) {
    return {
      blocks: [...hostValue.blocks],
      promptVariableValues: { ...hostValue.promptVariableValues }
    };
  }
  const patched = replaceUniqueBlock(hostValue.blocks, draftValue.blocks, selectedBlockId);
  if (!patched.ok) {
    return {
      blocks: [...hostValue.blocks],
      promptVariableValues: { ...hostValue.promptVariableValues }
    };
  }
  const nextValues = { ...hostValue.promptVariableValues };
  if (Object.prototype.hasOwnProperty.call(draftValue.promptVariableValues, selectedBlockId)) {
    nextValues[selectedBlockId] = { ...draftValue.promptVariableValues[selectedBlockId] };
  } else {
    delete nextValues[selectedBlockId];
  }
  return { blocks: patched.blocks, promptVariableValues: nextValues };
}
function draftSlotsDiscardedBySelection(state, slot, blockId) {
  if (slot === "primary") {
    if (blockId === state.primaryBlockId)
      return [];
    const discarded = [];
    if (state.primaryDirty && state.primaryBlockId)
      discarded.push("primary");
    if (blockId && blockId === state.secondaryBlockId && state.secondaryDirty && state.secondaryBlockId) {
      discarded.push("secondary");
    }
    return discarded;
  }
  if (blockId === state.secondaryBlockId)
    return [];
  return state.secondaryDirty && state.secondaryBlockId ? ["secondary"] : [];
}
function overlaySelectedDrafts(hostValue, drafts) {
  let current = {
    blocks: [...hostValue.blocks],
    promptVariableValues: { ...hostValue.promptVariableValues }
  };
  for (const draft of drafts) {
    current = overlaySelectedDraft(current, draft.value, draft.selectedBlockId);
  }
  return current;
}
function buildReviewIssues(blocks, values) {
  const index = buildVariableIndex(blocks, values);
  const issues = [];
  const add = (kind, name, blockId, title, message) => {
    if (issues.some((issue) => issue.key === JSON.stringify([kind, name, blockId])))
      return;
    issues.push({
      key: JSON.stringify([kind, name, blockId]),
      blockId,
      title,
      message,
      editable: blocks.filter((block) => block.id === blockId).length === 1
    });
  };
  for (const missing of index.missing)
    for (const ref of missing.references) {
      add("missing", missing.name, ref.blockId, "Unknown " + missing.macro, "This prompt references a variable with no definition. Correct the reference or add a definition.");
    }
  for (const entry of index.variables) {
    if (entry.duplicateDefinition)
      for (const owner of entry.definitions) {
        add("duplicate", entry.name, owner.blockId, "Duplicate " + entry.macro, "Defined by " + entry.definitions.map((definition) => definition.blockName).join(", ") + ". Rename or remove the unintended definition.");
      }
    else if (entry.unused)
      for (const owner of entry.definitions) {
        add("unused", entry.name, owner.blockId, "Unused " + entry.macro, "No prompt references this variable. This may be intentional; keep it, reference it, or remove it.");
      }
  }
  for (const id of index.duplicateBlockIds) {
    add("block-id", id, id, "Duplicate block id: " + id, "This prompt identity is ambiguous. Repair its ID outside this review before editing it here.");
  }
  return issues;
}

class WorkshopIssueReview {
  patches = new Map;
  get size() {
    return this.patches.size;
  }
  get blockIds() {
    return [...this.patches.keys()];
  }
  clear() {
    this.patches.clear();
  }
  stage(host, source, id) {
    const original = host.filter((block) => block.id === id);
    const edited = source.filter((block) => block.id === id);
    if (original.length !== 1 || edited.length !== 1)
      return false;
    const baseline = this.patches.get(id)?.baseline ?? JSON.stringify(original[0]);
    if (JSON.stringify(edited[0]) === baseline)
      this.patches.delete(id);
    else
      this.patches.set(id, { baseline, block: structuredClone(edited[0]) });
    return true;
  }
  overlay(host) {
    let next = [...host];
    for (const [id, patch] of this.patches) {
      const result = replaceUniqueBlock(next, [structuredClone(patch.block)], id);
      if (result.ok)
        next = result.blocks;
    }
    return next;
  }
  apply(host) {
    for (const [id, patch] of this.patches) {
      const matches = host.filter((block) => block.id === id);
      if (matches.length !== 1 || JSON.stringify(matches[0]) !== patch.baseline) {
        return { ok: false, blocks: [...host], conflict: id };
      }
    }
    return { ok: true, blocks: this.overlay(host), conflict: null };
  }
}

// src/find-replace.ts
function previewReplacements(blocks, find, replacement) {
  if (!find || find === replacement)
    return [];
  return blocks.flatMap((block) => {
    if (block.isLocked)
      return [];
    const parts = (block.content ?? "").split(find);
    if (parts.length === 1)
      return [];
    return [{ before: structuredClone(block), after: { ...structuredClone(block), content: parts.join(replacement) }, count: parts.length - 1 }];
  });
}
var FIND_REPLACE_CSS = `
.workshop-find-dialog { box-sizing: border-box; width: min(760px, calc(100vw - 24px)); max-height: calc(var(--app-interactive-viewport-height, 100dvh) - 24px); margin: auto; top: var(--app-interactive-safe-top, 0px); padding: 20px; border: 1px solid var(--lumiverse-border); border-radius: 12px; background: var(--lumiverse-bg, #17171e); color: var(--lumiverse-text); overflow: auto; }
.workshop-find-dialog::backdrop { background: rgba(0,0,0,.65); }
.workshop-find-dialog h2 { font-size: 18px; margin: 0 0 10px; }
.workshop-find-dialog p { color: var(--lumiverse-text-muted, #aaa); font-size: 12px; }
.workshop-find-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.workshop-find-fields label { display: grid; gap: 6px; font-size: 13px; }
.workshop-find-fields textarea { box-sizing: border-box; width: 100%; min-height: 80px; resize: vertical; padding: 8px; border: 1px solid var(--lumiverse-border); border-radius: 6px; background: var(--lumiverse-bg-deep, #101014); color: inherit; font: inherit; }
.workshop-find-results { list-style: none; padding: 0; max-height: 38vh; overflow: auto; }
.workshop-find-results li { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 8px; margin-bottom: 8px; padding: 10px; border: 1px solid var(--lumiverse-border); border-radius: 6px; }
.workshop-find-choice { margin: 3px 0 0; cursor: pointer; }
.workshop-find-results summary { cursor: pointer; overflow-wrap: anywhere; }
.workshop-find-results pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; max-height: 180px; overflow: auto; }
.workshop-find-results mark { color: inherit; border-radius: 2px; }
.workshop-find-results .workshop-find-removed { color: #ffc1c1; background: #692929; }
.workshop-find-results .workshop-find-added { color: #baf5c8; background: #205331; }
.workshop-find-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
@media (max-width: 600px) { .workshop-find-fields { grid-template-columns: 1fr; } .workshop-find-dialog { padding: 14px; } }
`;
function openFindReplace(root, blocks, stage, onClose) {
  const returnFocus = document.activeElement;
  const dialog = document.createElement("dialog");
  dialog.className = "workshop-find-dialog";
  dialog.setAttribute("aria-label", "Preset find and replace");
  dialog.innerHTML = `<h2>Preset find and replace</h2><p>Replace literal, case-sensitive text in prompt content across this preset, including disabled prompts. Locked prompts are excluded. Names and variable definitions stay unchanged.</p><div class="workshop-find-fields"><label>Find<textarea data-find="find" spellcheck="false"></textarea></label><label>Replace with<textarea data-find="replace" spellcheck="false"></textarea></label></div><p>Leave Replace with empty to remove matching text. Check prompts to replace only those; leave all unchecked to replace all matches. Replacements stay local until you Apply in Workshop.</p><p data-find="status" role="status"></p><ul class="workshop-find-results" aria-label="Affected prompts"></ul><p data-find="error" role="alert"></p><div class="workshop-find-actions"><button type="button" class="workshop-text-button" data-find="refresh">Refresh preview</button><button type="button" class="workshop-text-button" data-find="cancel">Cancel</button><button type="button" class="workshop-text-button" data-find="stage" disabled>Replace all</button></div>`;
  const find = dialog.querySelector('[data-find="find"]');
  const replacement = dialog.querySelector('[data-find="replace"]');
  const apply = dialog.querySelector('[data-find="stage"]');
  const error = dialog.querySelector('[data-find="error"]');
  const list = dialog.querySelector("ul");
  let changes = [];
  const selected = new Set;
  let ambiguousIds = new Set;
  const targets = () => selected.size ? changes.filter((change) => selected.has(change.before.id)) : changes;
  const updateAction = () => {
    apply.textContent = selected.size ? `Replace (${selected.size})` : "Replace all";
    apply.disabled = !changes.length || targets().some((change) => ambiguousIds.has(change.before.id));
  };
  let closed = false;
  const finish = () => {
    if (closed)
      return;
    closed = true;
    dialog.close();
    dialog.remove();
    onClose();
    if (returnFocus?.isConnected)
      returnFocus.focus();
  };
  const preview = () => {
    const current = blocks();
    changes = previewReplacements(current, find.value, replacement.value);
    for (const id of selected)
      if (!changes.some((change) => change.before.id === id))
        selected.delete(id);
    ambiguousIds = new Set(changes.filter((change) => current.filter((block) => block.id === change.before.id).length !== 1).map((change) => change.before.id));
    error.textContent = ambiguousIds.size ? "Some matching prompts have duplicate IDs. Select uniquely identified prompts or repair the duplicates before replacing all." : "";
    updateAction();
    const count = changes.reduce((sum, change) => sum + change.count, 0);
    dialog.querySelector('[data-find="status"]').textContent = !find.value ? "Enter text to find." : find.value === replacement.value ? "Find and replacement text are identical." : `${count} replacement${count === 1 ? "" : "s"} in ${changes.length} prompt${changes.length === 1 ? "" : "s"}.`;
    list.replaceChildren();
    for (const change of changes) {
      const item = document.createElement("li");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "workshop-find-choice";
      checkbox.setAttribute("aria-label", `Include prompt ${change.before.name}`);
      checkbox.checked = selected.has(change.before.id);
      checkbox.disabled = ambiguousIds.has(change.before.id);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked)
          selected.add(change.before.id);
        else
          selected.delete(change.before.id);
        updateAction();
      });
      item.append(checkbox);
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = `${change.before.name} — ${change.count} replacement${change.count === 1 ? "" : "s"}`;
      details.append(summary);
      const parts = change.before.content.split(find.value);
      for (const label of ["Before", "After"]) {
        const heading = document.createElement("h3");
        heading.textContent = label;
        const text = document.createElement("pre");
        parts.forEach((part, index) => {
          if (index > 0) {
            const value = label === "Before" ? find.value : replacement.value;
            if (value) {
              const highlight = document.createElement("mark");
              highlight.className = label === "Before" ? "workshop-find-removed" : "workshop-find-added";
              highlight.textContent = value;
              text.append(highlight);
            }
          }
          text.append(document.createTextNode(part));
        });
        details.append(heading, text);
      }
      item.append(details);
      list.append(item);
    }
  };
  find.addEventListener("input", preview);
  replacement.addEventListener("input", preview);
  dialog.querySelector('[data-find="refresh"]').addEventListener("click", preview);
  dialog.querySelector('[data-find="cancel"]').addEventListener("click", finish);
  apply.addEventListener("click", () => {
    const failure = stage(targets());
    if (failure) {
      error.textContent = failure;
      apply.disabled = true;
    } else
      finish();
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finish();
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape")
      event.stopPropagation();
  });
  root.append(dialog);
  preview();
  dialog.showModal();
  find.focus();
  return finish;
}

// src/prompt-manager-core.ts
var PROMPT_MARKERS = [
  ["chat_history", "Chat History"],
  ["world_info_before", "World Info (Before)"],
  ["world_info_after", "World Info (After)"],
  ["char_description", "Char Description"],
  ["char_personality", "Char Personality"],
  ["persona_description", "User Persona"],
  ["scenario", "Scenario"],
  ["dialogue_examples", "Example Messages"],
  ["main_prompt", "Main Prompt"],
  ["enhance_definitions", "Enhance Definitions"],
  ["jailbreak", "Post-History Instructions"],
  ["nsfw_prompt", "NSFW Prompt"]
];
var structural = new Set(PROMPT_MARKERS.slice(0, 8).map(([id]) => id));
var structureProtected = (block) => block.isLocked && !structural.has(block.marker ?? "");
var memberships = (blocks) => new Map(computePromptGroups(blocks).flatMap((group) => group.children.map((block) => [block.id, group.categoryBlock?.id ?? null])));

class PromptManagerDraft {
  blocks;
  constructor(blocks) {
    if (blocks.some((block) => !block.id) || new Set(blocks.map((block) => block.id)).size !== blocks.length)
      throw Error("Prompt IDs are missing or duplicated. Repair them before managing the list.");
    this.blocks = structuredClone([...blocks]);
  }
  snapshot() {
    return structuredClone(this.blocks);
  }
  find(id) {
    const block = this.blocks.find((block) => block.id === id);
    if (!block)
      throw Error("The selected prompt no longer exists.");
    return block;
  }
  editable(id) {
    const block = this.find(id);
    const parent = memberships(this.blocks).get(id);
    if (structureProtected(block) || parent && structureProtected(this.find(parent)))
      throw Error("Locked prompts and locked categories cannot be reorganized or deleted.");
    return block;
  }
  category(id) {
    if (id === null)
      return;
    const category = this.find(id);
    if (category.marker !== "category")
      throw Error("Choose an existing category.");
    if (structureProtected(category))
      throw Error("Locked categories cannot receive prompts.");
  }
  end(blocks, categoryId) {
    if (categoryId === null)
      return blocks.length;
    const group = computePromptGroups(blocks).find((group) => group.categoryBlock?.id === categoryId);
    if (!group)
      throw Error("The target category no longer exists.");
    return blocks.indexOf(group.children.at(-1) ?? group.categoryBlock) + 1;
  }
  reconcile(next, expected) {
    const actual = memberships(next);
    for (const block of next) {
      if (block.marker !== "category" && actual.get(block.id) !== expected.get(block.id)) {
        block.group = expected.get(block.id) ?? null;
      }
    }
    const result = memberships(next);
    if (next.some((block) => block.marker !== "category" && result.get(block.id) !== expected.get(block.id)))
      throw Error("That placement would split a category. Choose a category boundary.");
  }
  commit(next, expected) {
    this.reconcile(next, expected);
    this.blocks = next;
  }
  add(kind, name, categoryId, marker) {
    if (!name.trim())
      throw Error("Enter a title.");
    if (kind === "category" && categoryId !== null)
      throw Error("Categories cannot be nested.");
    this.category(categoryId);
    if (kind === "marker" && !PROMPT_MARKERS.some(([id]) => id === marker))
      throw Error("Choose a supported marker.");
    const type = kind === "category" ? "category" : kind === "marker" ? marker : null;
    const block = {
      id: crypto.randomUUID(),
      name: name.trim(),
      content: "",
      role: "system",
      enabled: true,
      position: "pre_history",
      depth: 0,
      marker: type,
      isLocked: structural.has(type ?? ""),
      color: null,
      injectionTrigger: [],
      characterTagTrigger: [],
      group: categoryId,
      categoryMode: null
    };
    const next = this.snapshot(), expected = memberships(this.blocks);
    next.splice(this.end(next, categoryId), 0, block);
    if (kind !== "category")
      expected.set(block.id, categoryId);
    this.commit(next, expected);
    return block.id;
  }
  moveTo(id, categoryId) {
    this.moveManyTo([id], categoryId);
  }
  moveManyTo(ids, categoryId) {
    if (!ids.length)
      return;
    if (new Set(ids).size !== ids.length)
      throw Error("Select each prompt only once.");
    for (const id of ids) {
      if (this.editable(id).marker === "category")
        throw Error("Move categories using the list or Move up/down.");
    }
    this.category(categoryId);
    const selected = new Set(ids), expected = memberships(this.blocks);
    const next = this.snapshot().filter((block) => !selected.has(block.id));
    this.reconcile(next, expected);
    const moving = this.snapshot().filter((block) => selected.has(block.id)).map((block) => ({ ...block, group: categoryId }));
    for (const id of ids)
      expected.set(id, categoryId);
    next.splice(this.end(next, categoryId), 0, ...moving);
    this.commit(next, expected);
  }
  moveRelative(id, targetId, after) {
    if (id === targetId)
      return;
    const block = this.editable(id), target = this.find(targetId), expected = memberships(this.blocks);
    const group = computePromptGroups(this.blocks).find((group) => group.categoryBlock?.id === id);
    const ids = new Set([id, ...group?.children.map((child) => child.id) ?? []]);
    if (ids.has(targetId))
      throw Error("A category cannot be dropped inside itself.");
    if (group?.children.some(structureProtected))
      throw Error("This category contains locked prompts and cannot be moved.");
    const next = this.snapshot().filter((block) => !ids.has(block.id));
    let index = next.findIndex((block) => block.id === targetId) + Number(after);
    const moving = this.snapshot().filter((block) => ids.has(block.id));
    if (block.marker === "category") {
      if (target.marker !== "category" && expected.get(targetId) !== null)
        throw Error("Categories must be dropped between categories or ungrouped prompts.");
      if (target.marker === "category" && after)
        index = this.end(next, target.id);
    } else {
      const parent = target.marker === "category" ? after ? target.id : null : expected.get(targetId) ?? null;
      this.category(parent);
      moving[0].group = parent;
      expected.set(id, parent);
    }
    next.splice(index, 0, ...moving);
    this.commit(next, expected);
  }
  stepTarget(id, direction) {
    const block = this.find(id), groups = computePromptGroups(this.blocks);
    const parent = groups.find((group) => group.children.some((child) => child.id === id));
    const siblings = block.marker === "category" || !parent?.categoryBlock ? groups.flatMap((group) => group.categoryBlock ? [group.categoryBlock] : group.children) : parent.children;
    return siblings[siblings.findIndex((block) => block.id === id) + direction]?.id ?? null;
  }
  step(id, direction) {
    const targetId = this.stepTarget(id, direction);
    if (!targetId)
      return;
    const block = this.editable(id), target = this.find(targetId);
    if (block.marker !== "category" && memberships(this.blocks).get(id) === null && target.marker === "category" && direction === 1) {
      const next = this.snapshot().filter((block) => block.id !== id);
      next.splice(this.end(next, targetId), 0, { ...structuredClone(block), group: null });
      this.commit(next, memberships(this.blocks));
    } else
      this.moveRelative(id, targetId, direction === 1);
  }
  remove(id, children = "keep") {
    const block = this.editable(id), next = this.snapshot(), expected = memberships(this.blocks);
    const group = block.marker === "category" ? computePromptGroups(this.blocks).find((group) => group.categoryBlock?.id === id) : null;
    if (group?.children.some(structureProtected))
      throw Error("This category contains locked prompts and cannot be deleted.");
    const removed = new Set([id, ...children === "delete" ? group?.children.map((child) => child.id) ?? [] : []]);
    if (children === "keep")
      for (const child of group?.children ?? [])
        expected.set(child.id, null);
    this.commit(next.filter((block) => !removed.has(block.id)), expected);
  }
}

// src/prompt-manager.ts
var PROMPT_MANAGER_CSS = `
.workshop-manage { box-sizing:border-box; width:min(900px,calc(100vw - 24px)); height: min(780px,calc(var(--app-interactive-viewport-height,100dvh) - 24px)); max-height:calc(var(--app-interactive-viewport-height,100dvh) - 24px); top:var(--app-interactive-safe-top,0px); margin:auto; padding:18px; border:1px solid var(--lumiverse-border,#444); border-radius:12px; background:var(--lumiverse-bg,#17171e); color:var(--lumiverse-text,#eee); overflow:auto; }
.workshop-manage[open] { display:flex; flex-direction:column; gap:8px; }
.workshop-manage::backdrop { background:rgba(0,0,0,.65); }
.workshop-manage * { box-sizing:border-box; }
.workshop-manage h2 { margin:0; font-size:18px; }
.workshop-manage p { margin:0; font-size:12px; color:var(--lumiverse-text-muted,#aaa); line-height:1.5; }
.workshop-manage header,.workshop-manage footer,.workshop-manage-tools { display:flex; gap:8px; align-items:center; flex-wrap:wrap; flex-shrink:0; }
.workshop-manage header { justify-content:space-between; }
.workshop-manage footer { justify-content:flex-end; }
.workshop-manage [aria-label="Add items"] { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); }
.workshop-manage p:empty { display:none; }
.workshop-manage-search-row { display:flex; align-items:center; gap:10px; flex-shrink:0; }
.workshop-manage-search-row .workshop-manage-search { flex:1; width:0; }
.workshop-manage .workshop-manage-check { display:inline-flex; align-items:center; gap:6px; white-space:nowrap; }
.workshop-manage input[type=checkbox] { width:16px; height:16px; min-height:0; flex-shrink:0; padding:0; margin:0; accent-color:var(--lumiverse-primary,#a6a6ff); }
.workshop-manage button,.workshop-manage input,.workshop-manage select { font:inherit; font-size:12px; color:inherit; border:1px solid var(--lumiverse-border,#444); border-radius:6px; background:var(--lumiverse-bg-deep,#101014); padding:8px 10px; min-height:36px; min-width:0; }
.workshop-manage button { cursor:pointer; }
.workshop-manage button:disabled { opacity:.45; cursor:default; }
.workshop-manage :focus-visible { outline:2px solid var(--lumiverse-primary,#a6a6ff); outline-offset:2px; }
.workshop-manage .primary { background:var(--lumiverse-primary-020,#30304b); border-color:var(--lumiverse-primary,#a6a6ff); }
.workshop-manage .danger { color:var(--lumiverse-danger,#ffb4b4); }
.workshop-manage label { display:grid; gap:5px; min-width:0; font-size:12px; }
.workshop-manage form { display:flex; flex-wrap:wrap; gap:8px; align-items:end; padding:12px; border:1px solid var(--lumiverse-border,#444); border-radius:8px; flex-shrink:0; }
.workshop-manage form label { flex:1 1 140px; }
.workshop-manage form[hidden],.workshop-manage [hidden] { display:none!important; }
.workshop-manage-search { width:100%; flex-shrink:0; }
.workshop-manage-list { padding:0; margin:0; list-style:none; overflow:auto; flex:1; min-height:80px; overscroll-behavior:contain; border:1px solid var(--lumiverse-border,#444); border-radius:8px; }
.workshop-manage-row { display:flex; align-items:center; gap:6px; padding:0 6px; border-top:2px solid transparent; border-bottom:2px solid transparent; }
.workshop-manage-row.child { padding-left:30px; }
.workshop-manage-row.category { background:var(--lumiverse-fill-subtle,rgba(255,255,255,.05)); }
.workshop-manage-row.selected { background:var(--lumiverse-primary-010,rgba(130,130,255,.12)); }
.workshop-manage-row.drop-before { border-top-color:var(--lumiverse-primary,#a6a6ff); }
.workshop-manage-row.drop-after { border-bottom-color:var(--lumiverse-primary,#a6a6ff); }
.workshop-manage .workshop-manage-select { flex:1; text-align:left; display:flex; gap:8px; align-items:center; border-color:transparent; background:transparent; }
.workshop-manage-select span { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.workshop-manage-select small { font-size:10px; color:var(--lumiverse-text-muted,#aaa); flex-shrink:0; }
.workshop-manage .workshop-manage-grip { cursor:grab; border-color:transparent; background:transparent; touch-action:pan-y; }
.workshop-manage-root { padding:6px; text-align:center; font-size:11px; color:var(--lumiverse-text-muted,#aaa); border:1px dashed var(--lumiverse-border,#444); border-radius:6px; }
.workshop-manage-root.drop-after { border-color:var(--lumiverse-primary,#a6a6ff); }
.workshop-manage-selection { padding:8px 0 0; border-top:1px solid var(--lumiverse-border,#444); display:grid; gap:6px; flex-shrink:0; }
.workshop-manage-selection strong { font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.workshop-manage-selection [data-manage=move-label] { display:flex; align-items:center; gap:8px; flex:1; white-space:nowrap; }
.workshop-manage-selection select { flex:1; width:0; }
.workshop-manage-confirm { display:grid; gap:8px; border-top:1px solid var(--lumiverse-border,#444); padding-top:10px; }
.workshop-manage [role=alert] { color:var(--lumiverse-warning,#e8b04c); }
@media(max-width:600px) { .workshop-manage { padding:12px; gap:8px; } .workshop-manage[open] { gap:8px; } .workshop-manage button { min-height:44px; } .workshop-manage-row { padding-inline:3px; } .workshop-manage-row.child { padding-left:16px; } .workshop-manage-selection .workshop-manage-tools { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); } .workshop-manage [data-manage=move-label] { grid-column:1/-1; } .workshop-manage-selection select { width:0; } .workshop-manage-search-row { flex-wrap:wrap; gap:6px 10px; } .workshop-manage-search-row .workshop-manage-search { flex-basis:100%; width:100%; } .workshop-manage-search-row [data-manage=clear-selection] { margin-left:auto; } .workshop-manage form { max-height:35vh; overflow:auto; } }
`;
function openPromptManager(root, blocks, stage, onClose) {
  const model = new PromptManagerDraft(blocks);
  const baseline = JSON.stringify(blocks);
  const returnFocus = document.activeElement;
  const dialog = document.createElement("dialog");
  dialog.className = "workshop-manage";
  const headingId = `workshop-manage-${crypto.randomUUID()}`;
  dialog.setAttribute("aria-labelledby", headingId);
  dialog.innerHTML = `<header><h2>Manage prompts</h2><span data-manage="count"></span></header>
    <p>Add, organize, or delete items. Drag by the handle, select a title to organize it, or check multiple prompts to move them together. Done keeps changes local until Apply in Workshop.</p>
    <div class="workshop-manage-tools" role="group" aria-label="Add items"><button type="button" data-add="prompt">Add prompt</button><button type="button" data-add="marker">Add marker</button><button type="button" data-add="category">Add category</button></div>
    <form hidden><label>Title<input name="title" required maxlength="500" autocomplete="off"></label><label data-manage="marker-label" hidden>Marker type<select name="marker"></select></label><label data-manage="category-label">Category<select name="category"></select></label><button type="submit" class="primary">Add</button><button type="button" data-manage="cancel-add">Cancel add</button></form>
    <div class="workshop-manage-search-row"><input type="search" class="workshop-manage-search" aria-label="Search prompt titles" placeholder="Search titles…"><label class="workshop-manage-check"><input type="checkbox" data-manage="select-visible">Select visible prompts</label><button type="button" data-manage="clear-selection" disabled>Clear selection</button></div>
    <ul class="workshop-manage-list" aria-label="Prompt order"></ul>
    <div class="workshop-manage-root" data-manage="root-drop">Ungrouped · drop here to move to the end</div>
    <section class="workshop-manage-selection" aria-label="Selected item" hidden><strong data-manage="selected-title"></strong><div class="workshop-manage-tools"><button type="button" data-manage="up">Move up</button><button type="button" data-manage="down">Move down</button><label data-manage="move-label">Move to<select data-manage="destination"></select></label><button type="button" data-manage="move">Move</button><button type="button" class="danger" data-manage="delete">Delete</button></div>
    <div class="workshop-manage-confirm" hidden><p data-manage="delete-copy"></p><div class="workshop-manage-tools"><button type="button" data-manage="keep">Keep prompts ungrouped</button><button type="button" class="danger" data-manage="remove">Delete item</button><button type="button" data-manage="cancel-delete">Cancel deletion</button></div></div></section>
    <p data-manage="status" role="status"></p><p data-manage="error" role="alert"></p>
    <footer><button type="button" data-manage="cancel">Cancel</button><button type="button" class="primary" data-manage="done">Done</button></footer>`;
  dialog.querySelector("h2").id = headingId;
  const el = (name) => dialog.querySelector(`[data-manage="${name}"]`);
  const button = (name) => el(name);
  const list = dialog.querySelector("ul");
  const search = dialog.querySelector("input[type=search]");
  const form = dialog.querySelector("form");
  form.id = `${headingId}-add`;
  const confirmation = dialog.querySelector(".workshop-manage-confirm");
  confirmation.id = `${headingId}-delete`;
  button("delete").setAttribute("aria-controls", confirmation.id);
  const title = form.elements.namedItem("title");
  const marker = form.elements.namedItem("marker");
  const parent = form.elements.namedItem("category");
  let kind = "prompt";
  let selectedId = null, createdId = null, dragId = null;
  const checked = new Set;
  let visibleSelectable = [];
  let closed = false;
  const selected = () => model.snapshot().find((block) => block.id === selectedId);
  const finish = () => {
    if (closed)
      return;
    closed = true;
    dialog.close();
    dialog.remove();
    onClose();
    if (returnFocus?.isConnected)
      returnFocus.focus({ preventScroll: true });
  };
  const run = (operation, message) => {
    try {
      operation();
      el("error").textContent = "";
      render();
      el("status").textContent = message;
    } catch (error) {
      el("error").textContent = error instanceof Error ? error.message : "Could not change the prompt list.";
    }
  };
  const categories = (select, value) => {
    select.replaceChildren(new Option("Ungrouped", ""));
    for (const block of model.snapshot().filter((block) => block.marker === "category")) {
      const option = new Option(block.name || "(Untitled category)", block.id);
      option.disabled = structureProtected(block);
      select.add(option);
    }
    select.value = value;
    if (select.selectedIndex === -1)
      select.value = "";
  };
  const renderSelection = () => {
    const block = selected();
    el("selected-title").textContent = checked.size ? `${checked.size} prompts selected` : block?.name || "(Untitled item)";
    dialog.querySelector(".workshop-manage-selection").hidden = !block && !checked.size || !form.hidden;
    confirmation.hidden = true;
    button("delete").setAttribute("aria-expanded", "false");
    const bulk = checked.size > 0;
    for (const name of ["up", "down", "delete"])
      button(name).hidden = bulk;
    button("move").textContent = bulk ? "Move selected" : "Move";
    if (bulk) {
      el("move-label").hidden = button("move").hidden = false;
      button("move").disabled = el("destination").disabled = false;
      const parents = new Set(computePromptGroups(model.snapshot()).flatMap((group) => group.children.filter((child) => checked.has(child.id)).map(() => group.categoryBlock?.id ?? "")));
      categories(el("destination"), parents.size === 1 ? [...parents][0] : "");
      return;
    }
    if (!block)
      return;
    const group = computePromptGroups(model.snapshot()).find((group) => group.children.some((child) => child.id === block.id));
    const protectedItem = structureProtected(block) || Boolean(group?.categoryBlock && structureProtected(group.categoryBlock));
    button("up").disabled = protectedItem || !model.stepTarget(block.id, -1);
    button("down").disabled = protectedItem || !model.stepTarget(block.id, 1);
    for (const name of ["up", "down", "delete"])
      button(name).setAttribute("aria-label", `${name === "up" ? "Move up" : name === "down" ? "Move down" : "Delete"} ${block.name || "untitled item"}`);
    button("delete").disabled = protectedItem;
    el("move-label").hidden = button("move").hidden = block.marker === "category";
    button("move").disabled = protectedItem;
    el("destination").disabled = protectedItem;
    categories(el("destination"), group?.categoryBlock?.id ?? "");
  };
  const clearDrop = () => dialog.querySelectorAll(".drop-before,.drop-after").forEach((row) => row.classList.remove("drop-before", "drop-after"));
  const render = () => {
    const scroll = list.scrollTop;
    const all = model.snapshot(), query = search.value.trim().toLowerCase();
    const groups = computePromptGroups(all);
    list.replaceChildren();
    for (const id of checked)
      if (!all.some((block) => block.id === id))
        checked.delete(id);
    visibleSelectable = [];
    let count = 0;
    for (const group of groups) {
      const categoryMatches = group.categoryBlock?.name.toLowerCase().includes(query);
      const children = query && !categoryMatches ? group.children.filter((block) => block.name.toLowerCase().includes(query)) : group.children;
      if (query && !categoryMatches && !children.length)
        continue;
      for (const block of [...group.categoryBlock ? [group.categoryBlock] : [], ...children]) {
        count++;
        const row = document.createElement("li");
        const child = block.marker !== "category" && Boolean(group.categoryBlock);
        row.className = `workshop-manage-row${child ? " child" : ""}${block.marker === "category" ? " category" : ""}${selectedId === block.id || checked.has(block.id) ? " selected" : ""}`;
        row.dataset.manageId = block.id;
        const grip = document.createElement("button");
        grip.type = "button";
        grip.className = "workshop-manage-grip";
        grip.textContent = "⠿";
        grip.setAttribute("aria-label", `Reorder ${block.name || "untitled item"}`);
        grip.disabled = structureProtected(block) || Boolean(child && group.categoryBlock && structureProtected(group.categoryBlock)) || Boolean(query) || checked.size > 0;
        grip.draggable = !grip.disabled;
        grip.addEventListener("dragstart", (event) => {
          dragId = block.id;
          if (event.dataTransfer) {
            event.dataTransfer.setData("text/plain", block.id);
            event.dataTransfer.effectAllowed = "move";
          }
        });
        grip.addEventListener("dragend", () => {
          dragId = null;
          clearDrop();
        });
        grip.addEventListener("click", () => {
          selectedId = block.id;
          render();
          const action = !button("up").disabled ? button("up") : !button("down").disabled ? button("down") : !button("move").hidden && !button("move").disabled ? button("move") : null;
          if (action)
            action.focus();
          else
            list.querySelector(`[data-manage-id="${CSS.escape(block.id)}"] .workshop-manage-select`)?.focus();
        });
        row.addEventListener("dragover", (event) => {
          if (!dragId || query)
            return;
          event.preventDefault();
          clearDrop();
          row.classList.add(event.clientY > row.getBoundingClientRect().top + row.clientHeight / 2 ? "drop-after" : "drop-before");
          const bounds = list.getBoundingClientRect();
          if (event.clientY < bounds.top + 40)
            list.scrollTop -= 24;
          if (event.clientY > bounds.bottom - 40)
            list.scrollTop += 24;
        });
        row.addEventListener("drop", (event) => {
          if (!dragId || query)
            return;
          event.preventDefault();
          const id = dragId, after = event.clientY > row.getBoundingClientRect().top + row.clientHeight / 2;
          dragId = null;
          clearDrop();
          selectedId = id;
          run(() => model.moveRelative(id, block.id, after), "Item moved. Changes are local.");
        });
        const select = document.createElement("button");
        select.type = "button";
        select.className = "workshop-manage-select";
        select.setAttribute("aria-pressed", String(block.id === selectedId));
        const duplicate = all.filter((item) => item.name === block.name).length > 1;
        select.setAttribute("aria-label", `Select ${block.name || "untitled item"}${duplicate ? `, item ${all.findIndex((item) => item.id === block.id) + 1}` : ""}`);
        const name = document.createElement("span");
        name.textContent = block.name || "(Untitled item)";
        name.title = name.textContent;
        const badge = document.createElement("small");
        badge.textContent = `${block.marker === "category" ? "Category" : block.marker ? "Marker" : "Prompt"}${block.isLocked ? " · Locked" : ""}${!block.enabled ? " · Off" : ""}`;
        select.append(name, badge);
        select.addEventListener("click", () => {
          selectedId = block.id;
          render();
          list.querySelector(`[data-manage-id="${CSS.escape(block.id)}"] .workshop-manage-select`)?.focus({ preventScroll: true });
        });
        if (block.marker !== "category") {
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.dataset.checkId = block.id;
          const suffix = duplicate ? `, item ${all.findIndex((item) => item.id === block.id) + 1}` : "";
          checkbox.setAttribute("aria-label", `Include ${block.name || "untitled prompt"}${suffix} in move`);
          checkbox.checked = checked.has(block.id);
          checkbox.disabled = structureProtected(block) || Boolean(group.categoryBlock && structureProtected(group.categoryBlock));
          if (!checkbox.disabled)
            visibleSelectable.push(block.id);
          checkbox.addEventListener("change", () => {
            if (checkbox.checked)
              checked.add(block.id);
            else
              checked.delete(block.id);
            selectedId = block.id;
            render();
            list.querySelector(`[data-check-id="${CSS.escape(block.id)}"]`)?.focus({ preventScroll: true });
          });
          row.append(checkbox);
        }
        row.append(grip, select);
        list.append(row);
      }
    }
    if (!count) {
      const empty = document.createElement("li");
      empty.className = "workshop-manage-row";
      empty.textContent = query ? "No matching titles." : "No prompts yet. Add a prompt, marker, or category.";
      list.append(empty);
    }
    const selectVisible = el("select-visible");
    const visibleChecked = visibleSelectable.filter((id) => checked.has(id)).length;
    selectVisible.disabled = !visibleSelectable.length;
    selectVisible.checked = visibleChecked > 0 && visibleChecked === visibleSelectable.length;
    selectVisible.indeterminate = visibleChecked > 0 && visibleChecked < visibleSelectable.length;
    button("clear-selection").disabled = !checked.size;
    el("count").textContent = `${all.length} items`;
    el("root-drop").hidden = Boolean(query);
    list.scrollTop = scroll;
    renderSelection();
    categories(parent, parent.value);
  };
  for (const [id, label] of PROMPT_MARKERS)
    marker.add(new Option(label, id));
  const addButtons = dialog.querySelectorAll("[data-add]");
  const hideForm = () => {
    form.hidden = true;
    addButtons.forEach((add) => add.setAttribute("aria-expanded", "false"));
  };
  addButtons.forEach((add) => {
    add.setAttribute("aria-controls", form.id);
    add.setAttribute("aria-expanded", "false");
    add.addEventListener("click", () => {
      kind = add.dataset.add;
      form.hidden = false;
      addButtons.forEach((button) => button.setAttribute("aria-expanded", String(button === add)));
      el("marker-label").hidden = kind !== "marker";
      el("category-label").hidden = kind === "category";
      title.value = kind === "marker" ? marker.selectedOptions[0].text : "";
      const group = computePromptGroups(model.snapshot()).find((group) => group.categoryBlock?.id === selectedId || group.children.some((child) => child.id === selectedId));
      categories(parent, group?.categoryBlock?.id ?? "");
      renderSelection();
      title.focus();
    });
  });
  marker.addEventListener("change", () => {
    title.value = marker.selectedOptions[0].text;
  });
  button("cancel-add").addEventListener("click", () => {
    hideForm();
    renderSelection();
    dialog.querySelector(`[data-add="${kind}"]`).focus();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    run(() => {
      selectedId = createdId = model.add(kind, title.value, kind === "category" ? null : parent.value || null, marker.value);
      hideForm();
      search.value = "";
    }, "Item added. Choose Done to keep it in Workshop.");
    if (form.hidden) {
      button("done").focus();
      list.querySelector(`[data-manage-id="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: "nearest" });
    }
  });
  search.addEventListener("input", render);
  el("select-visible").addEventListener("change", (event) => {
    const include = event.target.checked;
    for (const id of visibleSelectable) {
      if (include)
        checked.add(id);
      else
        checked.delete(id);
    }
    render();
  });
  button("clear-selection").addEventListener("click", () => {
    checked.clear();
    render();
    if (el("select-visible").disabled)
      search.focus();
    else
      el("select-visible").focus();
  });
  for (const [name, direction] of [["up", -1], ["down", 1]])
    button(name).addEventListener("click", () => {
      run(() => {
        if (selectedId)
          model.step(selectedId, direction);
      }, "Item moved. Changes are local.");
      if (button(name).disabled) {
        const other = button(name === "up" ? "down" : "up");
        if (!other.disabled)
          other.focus();
        else
          list.querySelector(`[data-manage-id="${CSS.escape(selectedId)}"] .workshop-manage-select`)?.focus();
      }
      list.querySelector(`[data-manage-id="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: "nearest" });
    });
  button("move").addEventListener("click", () => {
    const ids = checked.size ? [...checked] : selectedId ? [selectedId] : [];
    run(() => model.moveManyTo(ids, el("destination").value || null), `${ids.length} prompt${ids.length === 1 ? "" : "s"} moved. Changes are local.`);
  });
  button("delete").addEventListener("click", () => {
    const block = selected();
    if (!block)
      return;
    const category = block.marker === "category";
    const count = computePromptGroups(model.snapshot()).find((group) => group.categoryBlock?.id === block.id)?.children.length ?? 0;
    el("delete-copy").textContent = category ? `Delete “${block.name}”? Keep its ${count} prompts ungrouped, or delete them too.` : `Delete “${block.name}” from the prompt list?`;
    button("keep").hidden = !category;
    button("remove").textContent = category ? "Delete category and prompts" : "Delete item";
    confirmation.hidden = false;
    button("delete").setAttribute("aria-expanded", "true");
    button("cancel-delete").focus();
  });
  button("cancel-delete").addEventListener("click", () => {
    confirmation.hidden = true;
    button("delete").setAttribute("aria-expanded", "false");
    button("delete").focus();
  });
  for (const [name, mode] of [["keep", "keep"], ["remove", "delete"]])
    button(name).addEventListener("click", () => {
      run(() => {
        if (selectedId)
          model.remove(selectedId, mode);
        selectedId = null;
      }, "Item deleted locally. Choose Done to keep changes.");
      search.focus();
    });
  el("root-drop").addEventListener("dragover", (event) => {
    if (dragId && !search.value.trim()) {
      event.preventDefault();
      clearDrop();
      el("root-drop").classList.add("drop-after");
    }
  });
  el("root-drop").addEventListener("drop", (event) => {
    if (!dragId || search.value.trim())
      return;
    event.preventDefault();
    const id = dragId;
    dragId = null;
    clearDrop();
    selectedId = id;
    run(() => {
      const blocks = model.snapshot(), source = blocks.find((block) => block.id === id);
      if (source.marker !== "category")
        model.moveTo(id, null);
      else {
        const last = computePromptGroups(blocks).flatMap((group) => group.categoryBlock ? [group.categoryBlock] : group.children).at(-1);
        if (last)
          model.moveRelative(id, last.id, true);
      }
    }, "Item moved to the end. Changes are local.");
  });
  button("cancel").addEventListener("click", finish);
  button("done").addEventListener("click", () => {
    const next = model.snapshot();
    if (JSON.stringify(next) === baseline) {
      finish();
      return;
    }
    const error = stage(next, next.some((block) => block.id === createdId) ? createdId : null);
    if (error)
      el("error").textContent = error;
    else
      finish();
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finish();
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape")
      event.stopPropagation();
  });
  root.append(dialog);
  render();
  dialog.showModal();
  search.focus();
  return finish;
}

// src/reference-view.ts
var REFERENCE_CSS = `
.workshop-reference[hidden] {display:none}
.workshop-reference {min-height:0;min-width:0;display:flex;flex-direction:column;overflow:auto;padding:10px;gap:8px}
.workshop-reference-controls {flex-shrink:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.workshop-reference-controls>div {flex:1;min-width:160px}
.workshop-reference-controls label {font-size:11px;color:var(--lumiverse-text-muted)}
.workshop-reference select,.workshop-reference input {display:block;width:100%;min-width:0;padding:7px;border:1px solid var(--lumiverse-border);border-radius:7px;background:var(--lumiverse-input-bg,var(--lumiverse-bg));color:var(--lumiverse-text);font:inherit}
.workshop-reference>input {flex-shrink:0}
.workshop-reference-status {flex-shrink:0;font-size:11px;color:var(--lumiverse-text-muted);margin:0}
.workshop-reference-body {display:grid;grid-template-columns:minmax(130px,30%) minmax(0,1fr);gap:10px;min-height:150px;flex:1}
.workshop-reference-nav {overflow:auto;min-height:0;min-width:0;border:1px solid var(--lumiverse-border);border-radius:8px;padding:6px}
.workshop-reference-nav summary {cursor:pointer;padding:7px;font-size:12px;overflow-wrap:anywhere}
.workshop-reference-nav button {display:block;width:100%;text-align:left;padding:8px;margin:3px 0;white-space:normal;overflow-wrap:anywhere}
.workshop-reference-nav button[aria-current=true] {border-color:var(--lumiverse-primary);background:var(--lumiverse-fill-subtle,rgba(128,128,128,.15))}
.workshop-reference-document {display:flex;flex-direction:column;min-width:0;min-height:0;gap:6px}
.workshop-reference-document h3 {font-size:13px;margin:0;overflow-wrap:anywhere}
.workshop-reference-document label {font-size:11px;color:var(--lumiverse-text-muted)}
.workshop-reference-document textarea {flex:1;min-height:70px;width:100%;resize:none;border:1px solid var(--lumiverse-border);border-radius:8px;padding:10px;background:var(--lumiverse-input-bg,var(--lumiverse-bg));color:var(--lumiverse-text);font:12px/1.6 var(--lumiverse-font-mono,monospace)}
@media(max-width:900px){.workshop-shell.reference-mode:not(.preview-collapsed) .workshop-center,.workshop-shell.reference-mode.preview-split:not(.preview-collapsed) .workshop-center {grid-template-rows:minmax(0,1fr) 5px min(60vh,max(360px,var(--wk-preview-height)))}.workshop-preview-label {display:none}}
@media(max-width:600px){.workshop-reference-body {grid-template-columns:minmax(110px,35%) minmax(0,1fr)}.workshop-reference {padding:7px}}
`;

class ReferenceView {
  ctx;
  mountedId;
  element = document.createElement("div");
  disposed = false;
  started = false;
  sequence = 0;
  preset = null;
  selected = null;
  collapsed = new Set;
  pending = new Map;
  unsubscribe;
  picker;
  search;
  nav;
  text;
  title;
  status;
  copy;
  constructor(ctx, mountedId) {
    this.ctx = ctx;
    this.mountedId = mountedId;
    this.element.className = "workshop-reference";
    this.element.hidden = true;
    this.element.setAttribute("role", "region");
    this.element.setAttribute("aria-label", "Reference preset");
    const id = `reference-${crypto.randomUUID()}`;
    this.element.innerHTML = `<div class="workshop-reference-controls"><div><label for="${id}-preset">Reference preset</label><select id="${id}-preset"><option value="">Choose a second preset</option></select></div><button type="button" class="workshop-text-button" data-reference-refresh>Refresh reference presets</button></div><p class="workshop-reference-status" role="status"></p><input type="search" placeholder="Search reference prompts…" aria-label="Search reference prompts"><div class="workshop-reference-body"><nav class="workshop-reference-nav" aria-label="Reference prompts"></nav><section class="workshop-reference-document" aria-label="Reference prompt"><h3>Select a reference prompt</h3><button class="workshop-text-button" type="button" data-reference-copy disabled>Copy reference prompt</button><label for="${id}">Read-only prompt content</label><textarea id="${id}" readonly spellcheck="false"></textarea></section></div>`;
    this.picker = this.element.querySelector("select");
    this.search = this.element.querySelector("input");
    this.nav = this.element.querySelector("nav");
    this.text = this.element.querySelector("textarea");
    this.title = this.element.querySelector("h3");
    this.status = this.element.querySelector("[role=status]");
    this.copy = this.element.querySelector("[data-reference-copy]");
    this.unsubscribe = ctx.onBackendMessage((payload) => {
      if (!payload || typeof payload !== "object")
        return;
      const p = payload;
      if (p.type !== "workshop:reference-result")
        return;
      const pending = this.pending.get(p.requestId);
      if (!pending)
        return;
      clearTimeout(pending.timer);
      this.pending.delete(p.requestId);
      if (p.error)
        pending.reject(Error(p.error));
      else
        pending.resolve(p);
    });
    this.picker.addEventListener("change", () => {
      this.search.value = "";
      this.selected = null;
      this.collapsed.clear();
      this.loadSelected();
    });
    this.search.addEventListener("input", () => this.renderNav());
    this.element.querySelector("[data-reference-refresh]").addEventListener("click", () => {
      this.refresh();
    });
    this.copy.addEventListener("click", () => {
      const content = this.text.value;
      Promise.resolve().then(() => navigator.clipboard.writeText(content)).then(() => {
        if (!this.disposed)
          this.status.textContent = "Reference prompt copied.";
      }, () => {
        if (this.disposed)
          return;
        this.text.focus();
        this.text.select();
        this.status.textContent = "Clipboard unavailable. Copy the selected text with your keyboard or selection menu.";
      });
    });
  }
  activate() {
    if (!this.started) {
      this.started = true;
      this.refresh();
    }
  }
  request(type, presetId) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(Error("Reference read timed out. Refresh to retry."));
      }, 1e4);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.ctx.sendToBackend({ type: `workshop:reference-${type}`, requestId, presetId });
      } catch {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(Error("Could not request reference presets."));
      }
    });
  }
  async refresh() {
    const sequence = ++this.sequence;
    const selected = this.picker.value;
    this.status.textContent = "Loading reference presets…";
    try {
      const result = await this.request("list");
      if (this.disposed || sequence !== this.sequence)
        return;
      const entries = (result.presets ?? []).filter((p) => p.id !== this.mountedId);
      this.picker.replaceChildren(new Option(entries.length ? "Choose a second preset" : "No other presets available", ""), ...entries.map((p) => new Option(p.name, p.id)));
      this.picker.value = entries.some((p) => p.id === selected) ? selected : "";
      await this.loadSelected();
    } catch (error) {
      if (!this.disposed && sequence === this.sequence)
        this.status.textContent = error instanceof Error ? error.message : "Could not load presets.";
    }
  }
  async loadSelected() {
    const sequence = ++this.sequence, presetId = this.picker.value;
    const previous = this.selected;
    this.preset = null;
    this.selected = null;
    this.renderNav();
    this.renderDocument();
    if (!presetId) {
      this.status.textContent = "Read-only saved snapshot. Choose a second preset; unsynced edits are not included.";
      return;
    }
    this.status.textContent = "Loading reference preset…";
    try {
      const result = await this.request("get", presetId);
      if (this.disposed || sequence !== this.sequence)
        return;
      if (!result.preset || result.preset.id !== presetId)
        throw Error("Reference preset unavailable.");
      this.preset = result.preset;
      this.selected = this.preset.blocks.some((b) => b.id === previous) ? previous : null;
      this.status.textContent = `${this.preset.name} · Read-only saved snapshot; unsynced edits are not included.`;
      this.renderNav();
      this.renderDocument();
    } catch (error) {
      if (!this.disposed && sequence === this.sequence)
        this.status.textContent = error instanceof Error ? error.message : "Could not read preset.";
    }
  }
  renderNav() {
    const scroll = this.nav.scrollTop;
    this.nav.replaceChildren();
    const query = this.search.value.trim().toLowerCase();
    for (const [index, group] of computePromptGroups(this.preset?.blocks ?? []).entries()) {
      const category = group.categoryBlock?.name ?? "Ungrouped";
      const blocks = [group.categoryBlock, ...group.children].filter((b) => b && (!query || `${category}
${b.name}
${b.content}`.toLowerCase().includes(query)));
      if (!blocks.length)
        continue;
      const details = document.createElement("details"), summary = document.createElement("summary");
      const key = `${group.categoryBlock?.id ?? "ungrouped"}-${index}`;
      details.open = !!query || !this.collapsed.has(key);
      summary.textContent = category;
      details.append(summary);
      details.addEventListener("toggle", () => {
        if (details.open)
          this.collapsed.delete(key);
        else
          this.collapsed.add(key);
      });
      for (const block of blocks) {
        if (!block)
          continue;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "workshop-text-button";
        button.textContent = block.name || "Untitled prompt";
        if (block.id === this.selected)
          button.setAttribute("aria-current", "true");
        button.addEventListener("click", () => {
          this.selected = block.id;
          for (const other of this.nav.querySelectorAll("[aria-current]"))
            other.removeAttribute("aria-current");
          button.setAttribute("aria-current", "true");
          this.renderDocument();
        });
        details.append(button);
      }
      this.nav.append(details);
    }
    if (this.preset && !this.nav.children.length)
      this.nav.textContent = query ? "No matching reference prompts." : "This preset has no prompt blocks.";
    this.nav.scrollTop = scroll;
  }
  renderDocument() {
    const block = this.preset?.blocks.find((b) => b.id === this.selected);
    this.title.textContent = block ? `${block.name} · ${block.role} · ${block.enabled ? "Enabled" : "Disabled"}` : "Select a reference prompt";
    this.text.value = block?.content ?? "";
    this.copy.disabled = !block;
  }
  destroy() {
    this.disposed = true;
    this.unsubscribe();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(Error("Reference view closed."));
    }
    this.pending.clear();
    this.element.remove();
  }
}

// node_modules/marked/lib/marked.esm.js
function B() {
  return { async: false, breaks: false, extensions: null, gfm: true, hooks: null, pedantic: false, renderer: null, silent: false, tokenizer: null, walkTokens: null };
}
var y = B();
function V(a) {
  y = a;
}
var M = { exec: () => null };
function D(a) {
  let e = [];
  return (t) => {
    let n = Math.max(0, Math.min(3, t - 1)), i = e[n];
    return i || (i = a(n), e[n] = i), i;
  };
}
function h(a, e = "") {
  let t = typeof a == "string" ? a : a.source, n = { replace: (i, r) => {
    let o = typeof r == "string" ? r : r.source;
    return o = o.replace(x.caret, "$1"), t = t.replace(i, o), n;
  }, getRegex: () => new RegExp(t, e) };
  return n;
}
var ze = ((a = "") => {
  try {
    return !!new RegExp("(?<=1)(?<!1)" + a);
  } catch {
    return false;
  }
})();
var x = { codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm, outputLinkReplace: /\\([\[\]])/g, indentCodeCompensation: /^(\s+)(?:```)/, beginningSpace: /^\s+/, endingHash: /#$/, startingSpaceChar: /^ /, endingSpaceChar: / $/, endingSpaceTabChar: /[ \t]$/, nonSpaceChar: /[^ ]/, newLineCharGlobal: /\n/g, tabCharGlobal: /\t/g, leadingSpaceTab: /^[ \t]+/, multipleSpaceGlobal: /\s+/g, blankLine: /^[ \t]*$/, doubleBlankLine: /\n[ \t]*\n[ \t]*$/, blockquoteStart: /^ {0,3}>/, blockquoteSetextReplace: /\n {0,3}((?:=+|-+) *)(?=\n|$)/g, blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm, listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g, listIsTask: /^\[[ xX]\] +\S/, listReplaceTask: /^\[[ xX]\] +/, listTaskCheckbox: /\[[ xX]\]/, anyLine: /\n.*\n/, hrefBrackets: /^<(.*)>$/, tableDelimiter: /[:|]/, tableAlignChars: /^\||\| *$/g, tableRowBlankLine: /\n[ \t]*$/, tableAlignRight: /^ *-+: *$/, tableAlignCenter: /^ *:-+: *$/, tableAlignLeft: /^ *:-+ *$/, startATag: /^<a /i, endATag: /^<\/a>/i, startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i, endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i, startAngleBracket: /^</, endAngleBracket: />$/, pedanticHrefTitle: /^([^'"]*[^\s])\s+(['"])(.*)\2/, unicodeAlphaNumeric: /[\p{L}\p{N}]/u, numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/, numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, escapeTest: /[&<>"']/, escapeReplace: /[&<>"']/g, escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/, escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, caret: /(^|[^\[])\^/g, percentDecode: /%25/g, findPipe: /\|/g, splitPipe: / \|/, slashPipe: /\\\|/g, carriageReturn: /\r\n|\r/g, spaceLine: /^ +$/gm, notSpaceStart: /^\S*/, endingNewline: /\n$/, listItemRegex: (a) => new RegExp(`^( {0,3}${a})((?:[	 ][^\\n]*)?(?:\\n|$))`), nextBulletRegex: D((a) => new RegExp(`^ {0,${a}}(?:[*+-]|\\d{1,9}[.)])((?:[ 	][^\\n]*)?(?:\\n|$))`)), hrRegex: D((a) => new RegExp(`^ {0,${a}}((?:-[ 	]*){3,}|(?:_[ 	]*){3,}|(?:\\*[ 	]*){3,})(?:\\n+|$)`)), fencesBeginRegex: D((a) => new RegExp(`^ {0,${a}}(?:\`\`\`|~~~)`)), headingBeginRegex: D((a) => new RegExp(`^ {0,${a}}#`)), htmlBeginRegex: D((a) => new RegExp(`^ {0,${a}}(?:</?(?:${Q})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, "i")), blockquoteBeginRegex: D((a) => new RegExp(`^ {0,${a}}>`)) };
var Ee = /^(?:[ \t]*(?:\n|$))+/;
var Me = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
var Ce = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\1[~`]* *(?=\n|$)|$)/;
var N = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
var Ie = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
var Y = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
var fe = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+) *(?:\n+|$)/;
var me = h(fe).replace(/bull/g, Y).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/).replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/\|table/g, "").getRegex();
var Be = h(fe).replace(/bull/g, Y).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/).replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/).getRegex();
var ee = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
var De = /^[^\n]+/;
var te = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\])+/;
var qe = h(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/).replace("label", te).replace("title", /(?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))/).getRegex();
var Ze = h(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, Y).getRegex();
var Q = "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
var ne = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
var ve = h("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?: +|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))", "i").replace("comment", ne).replace("tag", Q).replace("attribute", / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex();
var xe = (a) => h(ee).replace("hr", N).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("|table", "").replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace("list", a).replace("html", " {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)").replace("tag", Q).getRegex();
var He = xe(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/);
var Ge = xe(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);
var Ne = h(/^( {0,3}> ?(paragraph|[^\n]*)(?:\n|$))+/).replace("paragraph", Ge).getRegex();
var re = { blockquote: Ne, code: Me, def: qe, fences: Ce, heading: Ie, hr: N, html: ve, lheading: me, list: Ze, newline: Ee, paragraph: He, table: M, text: De };
var de = h("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)").replace("hr", N).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("blockquote", " {0,3}>").replace("code", "(?: {4}| {0,3}\t)[^\\n]").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]").replace("html", " {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)").replace("tag", Q).getRegex();
var Qe = { ...re, lheading: Be, table: de, paragraph: h(ee).replace("hr", N).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("table", de).replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]").replace("html", " {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)").replace("tag", Q).getRegex() };
var je = { ...re, html: h(`^ *(?:comment *(?:\\n|\\s*$)|<(tag)[\\s\\S]+?</\\1> *(?:\\n{2,}|\\s*$)|<tag(?:"[^"]*"|'[^']*'|\\s[^'"/>\\s]*)*?/?> *(?:\\n{2,}|\\s*$))`).replace("comment", ne).replace(/tag/g, "(?!(?:a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img)\\b)\\w+(?!:|[^\\w\\s@]*@)\\b").getRegex(), def: /^ *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +(["(][^\n]+[")]))? *(?:\n+|$)/, heading: /^(#{1,6})(.*)(?:\n+|$)/, fences: M, lheading: /^(.+?)\n {0,3}(=+|-+) *(?:\n+|$)/, paragraph: h(ee).replace("hr", N).replace("heading", ` *#{1,6} *[^
]`).replace("lheading", me).replace("|table", "").replace("blockquote", " {0,3}>").replace("|fences", "").replace("|list", "").replace("|html", "").replace("|tag", "").getRegex() };
var Fe = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
var Ue = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
var be = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
var Ke = /^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/;
var S = /[\p{P}\p{S}]/u;
var q = /[\s\p{P}\p{S}]/u;
var j = /[^\s\p{P}\p{S}]/u;
var Xe = h(/^((?![*_])punctSpace)/, "u").replace(/punctSpace/g, q).getRegex();
var We = /[\p{Pi}\p{Ps}"']/u;
var Re = /(?!~)[\p{P}\p{S}]/u;
var Ve = /(?!~)[\s\p{P}\p{S}]/u;
var Je = /(?:[^\s\p{P}\p{S}]|~)/u;
var Ye = h(/link|precode-code|html/, "g").replace("link", /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/).replace("precode-", ze ? "(?<!`)()" : "(^^|[^`])").replace("code", /(?<b>`+)[^`]+\k<b>(?!`)/).replace("html", /<(?! )[^<>]*?>/).getRegex();
var Te = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
var et = h(Te, "u").replace(/punct/g, S).getRegex();
var tt = h(Te, "u").replace(/punct/g, Re).getRegex();
var nt = /^(?:\*+(?:((?!\*)(?!openQuote)punct)|([^\s*]))?)|^_+(?:((?!_)(?!openQuote)punct)|([^\s_]))?/;
var rt = h(nt, "u").replace(/openQuote/g, We).replace(/punct/g, S).getRegex();
var Oe = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)";
var st = h(Oe, "gu").replace(/notPunctSpace/g, j).replace(/punctSpace/g, q).replace(/punct/g, S).getRegex();
var it = h(Oe, "gu").replace(/notPunctSpace/g, Je).replace(/punctSpace/g, Ve).replace(/punct/g, Re).getRegex();
var ot = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)[\\s](\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|(?:(?!\\*)punct|notPunctSpace)(\\*+)(?!\\*)(?=notPunctSpace)";
var at = h(ot, "gu").replace(/notPunctSpace/g, j).replace(/punctSpace/g, q).replace(/punct/g, S).getRegex();
var lt = h("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)", "gu").replace(/notPunctSpace/g, j).replace(/punctSpace/g, q).replace(/punct/g, S).getRegex();
var ut = "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)[\\s](_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)|(?:(?!_)punct|notPunctSpace)(_+)(?!_)(?=notPunctSpace)";
var pt = h(ut, "gu").replace(/notPunctSpace/g, j).replace(/punctSpace/g, q).replace(/punct/g, S).getRegex();
var ct = h(/^~~?(?:((?!~)punct)|[^\s~])/, "u").replace(/punct/g, S).getRegex();
var ht = "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)";
var dt = h(ht, "gu").replace(/notPunctSpace/g, j).replace(/punctSpace/g, q).replace(/punct/g, S).getRegex();
var kt = h(/\\(punct)/, "gu").replace(/punct/g, S).getRegex();
var gt = h(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, "gu").replace(/punct/g, S).getRegex();
var ft = h(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/).replace("scheme", /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/).replace("email", /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/).getRegex();
var mt = h(ne).replace("(?:-->|$)", "-->").getRegex();
var xt = h("^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>").replace("comment", mt).replace("attribute", /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).getRegex();
var we = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
var K = h(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/).replace("brackets", we).getRegex();
var bt = h(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/).replace("label", K).replace("href", /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/).replace("title", /"(?:\\"?|[^"\\])*"|'(?:\\'?|[^'\\])*'|\((?:\\\)?|[^)\\])*\)/).getRegex();
var Rt = h(/^!?\[(label)\]\[(ref)\]/).replace("label", K).replace("ref", te).getRegex();
var Tt = h(/^!?\[(ref)\](?:\[\])?/).replace("ref", te).getRegex();
var ke = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
var Ot = h(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/).replace("brackets", we).getRegex();
var wt = h("reflink|nolink(?!\\()", "g").replace("reflink", h(/^!?\[(label)\]\[(ref)\]/).replace("label", Ot).replace("ref", ke).getRegex()).replace("nolink", h(/^!?\[(ref)\](?:\[\])?/).replace("ref", ke).getRegex()).getRegex();
var ge = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
var Pt = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
var yt = h(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).replace(/email/g, Pt).getRegex();
var se = { _backpedal: M, anyPunctuation: kt, anyPunctuationOutsideCode: gt, autolink: ft, blockSkip: Ye, br: be, code: Ue, del: M, delLDelim: M, delRDelim: M, emStrongLDelim: et, emStrongRDelimAst: st, emStrongRDelimUnd: lt, escape: Fe, link: bt, nolink: Tt, punctuation: Xe, reflink: Rt, reflinkSearch: wt, tag: xt, text: Ke, url: M };
var St = { ...se, emStrongLDelim: rt, emStrongRDelimAst: at, emStrongRDelimUnd: pt, link: h(/^!?\[(label)\]\((.*?)\)/).replace("label", K).getRegex(), reflink: h(/^!?\[(label)\]\s*\[([^\]]*)\]/).replace("label", K).getRegex() };
var J = { ...se, emStrongRDelimAst: it, emStrongLDelim: tt, delLDelim: ct, delRDelim: dt, url: h(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/).replace("emailProtocol", yt).replace("protocol", ge).replace("email", /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/).getRegex(), _backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/, del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/, text: h(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/).replace("protocol", ge).replace(/emailProtocol/g, /(?:mailto|xmpp):/).getRegex() };
var _t = { ...J, br: h(be).replace("{2,}", "*").getRegex(), text: h(J.text).replace("\\b_", "\\b_| {2,}\\n").replace(/\{2,\}/g, "*").getRegex() };
var F = { normal: re, gfm: Qe, pedantic: je };
var Z = { normal: se, gfm: J, breaks: _t, pedantic: St };
var $t = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
var Pe = (a) => $t[a];
function w(a, e) {
  if (e) {
    if (x.escapeTest.test(a))
      return a.replace(x.escapeReplace, Pe);
  } else if (x.escapeTestNoEncode.test(a))
    return a.replace(x.escapeReplaceNoEncode, Pe);
  return a;
}
function ye(a) {
  return x.numericCharacterReference.test(a) ? a.replace(x.numericCharacterReferenceOrAmpersand, (e, t, n) => {
    if (t === undefined && n === undefined)
      return "&amp;";
    let i = t === undefined ? Number.parseInt(n, 16) : Number.parseInt(t, 10);
    return i === 0 || i > 1114111 || i >= 55296 && i <= 57343 ? "�" : i === 38 ? "&amp;" : String.fromCodePoint(i);
  }) : a;
}
function ie(a) {
  try {
    a = encodeURI(a).replace(x.percentDecode, "%");
  } catch {
    return null;
  }
  return a;
}
function oe(a, e) {
  let t = a.replace(x.findPipe, (r, o, s) => {
    let l = false, u = o;
    for (;--u >= 0 && s[u] === "\\"; )
      l = !l;
    return l ? "|" : " |";
  }), n = t.split(x.splitPipe), i = 0;
  if (n[0].trim() || n.shift(), n.length > 0 && !n.at(-1)?.trim() && n.pop(), e)
    if (n.length > e)
      n.splice(e);
    else
      for (;n.length < e; )
        n.push("");
  for (;i < n.length; i++)
    n[i] = n[i].trim().replace(x.slashPipe, "|");
  return n;
}
function A(a, e, t) {
  let n = a.length;
  if (n === 0)
    return "";
  let i = 0;
  for (;i < n; ) {
    let r = a.charAt(n - i - 1);
    if (r === e && !t)
      i++;
    else if (r !== e && t)
      i++;
    else
      break;
  }
  return a.slice(0, n - i);
}
function ae(a) {
  let e = a.split(`
`), t = e.length - 1;
  for (;t >= 0 && x.blankLine.test(e[t]); )
    t--;
  return e.length - t <= 2 ? a : e.slice(0, t + 1).join(`
`);
}
function v(a) {
  return a.trim().toLowerCase().toUpperCase().toLowerCase();
}
function le(a, e) {
  if (a.indexOf(e[0]) === -1 && a.indexOf(e[1]) === -1)
    return -1;
  let t = 0;
  for (let n = 0;n < a.length; n++)
    if (a[n] === "\\")
      n++;
    else if (a[n] === e[0])
      t++;
    else if (a[n] === e[1] && (t--, t < 0))
      return n;
  return t > 0 ? -2 : -1;
}
function X(a, e = 0) {
  let t = e, n = "";
  for (let i of a)
    if (i === "\t") {
      let r = 4 - t % 4;
      n += " ".repeat(r), t += r;
    } else
      n += i, t++;
  return n;
}
function Se(a, e, t, n, i) {
  let r = e.href, o = e.title || null, s = a[1].replace(i.other.outputLinkReplace, "$1"), l = a[0].charAt(0) === "!", u = n.state.inLink, c = n.state.linkEmitted, p = n.state.inRawBlock;
  n.state.inLink = true, n.state.linkEmitted = false;
  let d = n.inlineTokens(s), g = n.state.linkEmitted;
  if (n.state.linkEmitted = c, n.state.inLink = u, !l) {
    if (g) {
      n.state.inRawBlock = p;
      return;
    }
    n.state.linkEmitted = true;
  }
  return { type: l ? "image" : "link", raw: t, href: r, title: o, text: s, tokens: d };
}
function Lt(a, e, t) {
  let n = a.match(t.other.indentCodeCompensation);
  if (n === null)
    return e;
  let i = n[1];
  return e.split(`
`).map((r) => {
    let o = r.match(t.other.beginningSpace);
    if (o === null)
      return r;
    let [s] = o;
    return r.slice(Math.min(s.length, i.length));
  }).join(`
`);
}
function _e(a, e, t, n) {
  if (!e.includes("<"))
    return false;
  for (let i = 0;i < e.length; i++) {
    if (e[i] === "\\") {
      i++;
      continue;
    }
    if (e[i] === "`") {
      let s = n.inline.code.exec(e.slice(i));
      if (s) {
        i += s[0].length - 1;
        continue;
      }
    }
    if (e[i] !== "<")
      continue;
    let r = a.slice(t + i), o = n.inline.tag.exec(r) || n.inline.autolink.exec(r);
    if (o) {
      if (o[0].length > e.length - i)
        return true;
      i += o[0].length - 1;
    }
  }
  return false;
}
var _ = class {
  options;
  rules;
  lexer;
  constructor(e) {
    this.options = e || y;
  }
  space(e) {
    let t = this.rules.block.newline.exec(e);
    if (t && t[0].length > 0)
      return { type: "space", raw: t[0] };
  }
  code(e) {
    let t = this.rules.block.code.exec(e);
    if (t) {
      let n = this.options.pedantic ? t[0] : ae(t[0]), i = n.replace(this.rules.other.codeRemoveIndent, "");
      return { type: "code", raw: n, codeBlockStyle: "indented", text: i };
    }
  }
  fences(e) {
    let t = this.rules.block.fences.exec(e);
    if (t) {
      let n = t[0], i = Lt(n, t[3] || "", this.rules);
      return { type: "code", raw: n, lang: t[2] ? t[2].trim().replace(this.rules.inline.anyPunctuation, "$1") : t[2], text: i };
    }
  }
  heading(e) {
    let t = this.rules.block.heading.exec(e);
    if (t) {
      let n = t[2].trim();
      if (this.rules.other.endingHash.test(n)) {
        let i = A(n, "#");
        (this.options.pedantic || !i || this.rules.other.endingSpaceTabChar.test(i)) && (n = i.trim());
      }
      return { type: "heading", raw: A(t[0], `
`), depth: t[1].length, text: n, tokens: this.lexer.inline(n) };
    }
  }
  hr(e) {
    let t = this.rules.block.hr.exec(e);
    if (t)
      return { type: "hr", raw: A(t[0], `
`) };
  }
  blockquote(e) {
    let t = this.rules.block.blockquote.exec(e);
    if (t) {
      let n = A(t[0], `
`).split(`
`), i = "", r = "", o = [];
      for (;n.length > 0; ) {
        let s = false, l = [], u;
        for (u = 0;u < n.length; u++)
          if (this.rules.other.blockquoteStart.test(n[u]))
            l.push(n[u]), s = true;
          else if (!s)
            l.push(n[u]);
          else
            break;
        n = n.slice(u);
        let c = l.join(`
`), p = c.replace(this.rules.other.blockquoteSetextReplace, `
    $1`).replace(this.rules.other.blockquoteSetextReplace2, "");
        i = i ? `${i}
${c}` : c, r = r ? `${r}
${p}` : p;
        let d = this.lexer.state.top;
        if (this.lexer.state.top = true, this.lexer.blockTokens(p, o, true), this.lexer.state.top = d, n.length === 0)
          break;
        let g = o.at(-1);
        if (g?.type === "code" || g?.type === "heading" || g?.type === "hr" || g?.type === "html")
          break;
        if (g?.type === "blockquote") {
          let k = g, P = n.join(`
`), R = k.raw + `
` + P.replace(this.rules.other.blockquoteSetextReplace2, ""), m = this.blockquote(R);
          o[o.length - 1] = m;
          let E = R.substring(m.raw.length).replace(/^\n/, ""), b = E ? E.split(`
`).length : 0, H = b ? n.slice(0, -b) : n;
          H.length > 0 && (i = `${i}
${H.join(`
`)}`), r = r.substring(0, r.length - k.text.length) + m.text;
          break;
        } else if (g?.type === "list") {
          let k = g, P = k.raw + `
` + n.join(`
`), R = this.list(P);
          o[o.length - 1] = R, i = i.substring(0, i.length - g.raw.length) + R.raw, r = r.substring(0, r.length - k.raw.length) + R.raw, n = P.substring(o.at(-1).raw.length).split(`
`);
          continue;
        }
      }
      return { type: "blockquote", raw: i, tokens: o, text: r };
    }
  }
  list(e) {
    let t = this.rules.block.list.exec(e);
    if (t) {
      let n = e, i = () => n.length - e.length, r = t[1].trim(), o = r.length > 1, s = { type: "list", raw: "", ordered: o, start: o ? +r.slice(0, -1) : "", loose: false, items: [] };
      r = o ? `\\d{1,9}\\${r.slice(-1)}` : `\\${r}`, this.options.pedantic && (r = o ? r : "[*+-]");
      let l = this.rules.other.listItemRegex(r), u = false;
      for (;e; ) {
        let p = false, d = "";
        if (!(t = l.exec(e)) || this.rules.block.hr.test(e))
          break;
        let g = i();
        e = e.substring(t[0].length);
        let k = t[2].split(`
`, 1)[0], P = t[1].length, R = this.options.pedantic ? X(k, P) : k.replace(this.rules.other.leadingSpaceTab, (W) => X(W, P)), m = e.split(`
`, 1)[0], E = !R.trim(), b = 0;
        if (this.options.pedantic ? (b = 2, d = R.trimStart()) : E ? b = P + 1 : (b = R.search(this.rules.other.nonSpaceChar), b = b > 4 ? 1 : b, d = R.slice(b), b += P), E && this.rules.other.blankLine.test(m) && (e = e.substring(m.length + 1), p = true), !p) {
          let W = this.rules.other.nextBulletRegex(b), ue = this.rules.other.hrRegex(b), pe = this.rules.other.fencesBeginRegex(b), ce = this.rules.other.headingBeginRegex(b), $e = this.rules.other.htmlBeginRegex(b), Le = this.rules.other.blockquoteBeginRegex(b);
          for (;e; ) {
            let he = e.split(`
`, 1)[0], G;
            if (m = he, this.options.pedantic ? (m = m.replace(this.rules.other.listReplaceNesting, "  "), G = m) : G = m.replace(this.rules.other.leadingSpaceTab, (Ae) => X(Ae)), pe.test(m) || ce.test(m) || $e.test(m) || Le.test(m) || W.test(m) || ue.test(m))
              break;
            if (G.search(this.rules.other.nonSpaceChar) >= b || !m.trim())
              d += `
` + G.slice(b);
            else {
              if (E || R.replace(this.rules.other.tabCharGlobal, "    ").search(this.rules.other.nonSpaceChar) >= 4 || pe.test(R) || ce.test(R) || ue.test(R))
                break;
              d += `
` + m;
            }
            E = !m.trim(), e = e.substring(he.length + 1), R = G.slice(b);
          }
        }
        let H = n.slice(g, i());
        s.loose || (u ? s.loose = true : this.rules.other.doubleBlankLine.test(H) && (u = true)), s.items.push({ type: "list_item", raw: H, task: !!this.options.gfm && this.rules.other.listIsTask.test(d), loose: false, text: d, tokens: [] });
      }
      let c = s.items.at(-1);
      if (c)
        c.raw = c.raw.trimEnd(), c.text = c.text.trimEnd();
      else
        return;
      s.raw = n.slice(0, i()).trimEnd();
      for (let p of s.items)
        if (this.lexer.state.top = false, p.tokens = this.lexer.blockTokens(p.text, []), !s.loose) {
          let d = p.tokens.filter((k) => k.type === "space"), g = d.length > 0 && d.some((k) => this.rules.other.anyLine.test(k.raw));
          s.loose = g;
        }
      for (let p of s.items) {
        let d = p.tokens[0];
        if (p.task && (d?.type === "text" || d?.type === "paragraph")) {
          p.text = p.text.replace(this.rules.other.listReplaceTask, ""), d.raw = d.raw.replace(this.rules.other.listReplaceTask, ""), d.text = d.text.replace(this.rules.other.listReplaceTask, "");
          for (let k = this.lexer.inlineQueue.length - 1;k >= 0; k--)
            if (this.rules.other.listIsTask.test(this.lexer.inlineQueue[k].src)) {
              this.lexer.inlineQueue[k].src = this.lexer.inlineQueue[k].src.replace(this.rules.other.listReplaceTask, "");
              break;
            }
          let g = this.rules.other.listTaskCheckbox.exec(p.raw);
          if (g) {
            let k = { type: "checkbox", raw: g[0] + " ", checked: g[0] !== "[ ]" };
            p.checked = k.checked, s.loose ? p.tokens[0] && ["paragraph", "text"].includes(p.tokens[0].type) && "tokens" in p.tokens[0] && p.tokens[0].tokens ? (p.tokens[0].raw = k.raw + p.tokens[0].raw, p.tokens[0].text = k.raw + p.tokens[0].text, p.tokens[0].tokens.unshift(k)) : p.tokens.unshift({ type: "paragraph", raw: k.raw, text: k.raw, tokens: [k] }) : p.tokens.unshift(k);
          }
        } else
          p.task && (p.task = false);
      }
      if (s.loose)
        for (let p of s.items) {
          p.loose = true;
          for (let d of p.tokens)
            d.type === "text" && (d.type = "paragraph");
        }
      return s;
    }
  }
  html(e) {
    let t = this.rules.block.html.exec(e);
    if (t) {
      let n = ae(t[0]);
      return { type: "html", block: true, raw: n, pre: t[1] === "pre" || t[1] === "script" || t[1] === "style", text: n };
    }
  }
  def(e) {
    let t = this.rules.block.def.exec(e);
    if (t) {
      if (!this.rules.other.startAngleBracket.test(t[2]) && le(t[2], "()") !== -1)
        return;
      let n = v(t[1]).replace(this.rules.other.multipleSpaceGlobal, " "), i = t[2] ? t[2].replace(this.rules.other.hrefBrackets, "$1").replace(this.rules.inline.anyPunctuation, "$1") : "", r = t[3] ? t[3].substring(1, t[3].length - 1).replace(this.rules.inline.anyPunctuation, "$1") : t[3];
      return { type: "def", tag: n, raw: A(t[0], `
`), href: i, title: r };
    }
  }
  table(e) {
    let t = this.rules.block.table.exec(e);
    if (!t || !this.rules.other.tableDelimiter.test(t[2]))
      return;
    let n = oe(t[1]), i = t[2].replace(this.rules.other.tableAlignChars, "").split("|"), r = t[3]?.trim() ? t[3].replace(this.rules.other.tableRowBlankLine, "").split(`
`) : [], o = { type: "table", raw: A(t[0], `
`), header: [], align: [], rows: [] };
    if (n.length === i.length) {
      for (let s of i)
        this.rules.other.tableAlignRight.test(s) ? o.align.push("right") : this.rules.other.tableAlignCenter.test(s) ? o.align.push("center") : this.rules.other.tableAlignLeft.test(s) ? o.align.push("left") : o.align.push(null);
      for (let s = 0;s < n.length; s++)
        o.header.push({ text: n[s], tokens: this.lexer.inline(n[s]), header: true, align: o.align[s] });
      for (let s of r)
        o.rows.push(oe(s, o.header.length).map((l, u) => ({ text: l, tokens: this.lexer.inline(l), header: false, align: o.align[u] })));
      return o;
    }
  }
  lheading(e) {
    let t = this.rules.block.lheading.exec(e);
    if (t) {
      let n = t[1].trim();
      return { type: "heading", raw: A(t[0], `
`), depth: t[2].charAt(0) === "=" ? 1 : 2, text: n, tokens: this.lexer.inline(n) };
    }
  }
  paragraph(e) {
    let t = this.rules.block.paragraph.exec(e);
    if (t) {
      let n = t[1].charAt(t[1].length - 1) === `
` ? t[1].slice(0, -1) : t[1];
      return { type: "paragraph", raw: t[0], text: n, tokens: this.lexer.inline(n) };
    }
  }
  text(e) {
    let t = this.rules.block.text.exec(e);
    if (t)
      return { type: "text", raw: t[0], text: t[0], tokens: this.lexer.inline(t[0]) };
  }
  escape(e) {
    let t = this.rules.inline.escape.exec(e);
    if (t)
      return { type: "escape", raw: t[0], text: t[1] };
  }
  tag(e) {
    let t = this.rules.inline.tag.exec(e);
    if (t)
      return !this.lexer.state.inLink && this.rules.other.startATag.test(t[0]) ? this.lexer.state.inLink = true : this.lexer.state.inLink && this.rules.other.endATag.test(t[0]) && (this.lexer.state.inLink = false), !this.lexer.state.inRawBlock && this.rules.other.startPreScriptTag.test(t[0]) ? this.lexer.state.inRawBlock = true : this.lexer.state.inRawBlock && this.rules.other.endPreScriptTag.test(t[0]) && (this.lexer.state.inRawBlock = false), { type: "html", raw: t[0], inLink: this.lexer.state.inLink, inRawBlock: this.lexer.state.inRawBlock, block: false, text: t[0] };
  }
  link(e) {
    if (this.lexer.state.linkParenPossible === false)
      return;
    let t = this.rules.inline.link.exec(e);
    if (t) {
      let n = t[0].charAt(0) === "!" ? 2 : 1;
      if (!this.options.pedantic && _e(e, t[1], n, this.rules))
        return;
      let i = t[2].trim();
      if (!this.options.pedantic && this.rules.other.startAngleBracket.test(i)) {
        if (!this.rules.other.endAngleBracket.test(i))
          return;
        let s = A(i.slice(0, -1), "\\");
        if ((i.length - s.length) % 2 === 0)
          return;
      } else {
        let s = le(t[2], "()");
        if (s === -2)
          return;
        if (s > -1) {
          let u = (t[0].indexOf("!") === 0 ? 5 : 4) + t[1].length + s;
          t[2] = t[2].substring(0, s), t[0] = t[0].substring(0, u).trim(), t[3] = "";
        }
      }
      let r = t[2], o = "";
      if (this.options.pedantic) {
        let s = this.rules.other.pedanticHrefTitle.exec(r);
        s && (r = s[1], o = s[3]);
      } else
        o = t[3] ? t[3].slice(1, -1) : "";
      return r = r.trim(), this.rules.other.startAngleBracket.test(r) && (this.options.pedantic && !this.rules.other.endAngleBracket.test(i) ? r = r.slice(1) : r = r.slice(1, -1)), Se(t, { href: r && r.replace(this.rules.inline.anyPunctuation, "$1"), title: o && o.replace(this.rules.inline.anyPunctuation, "$1") }, t[0], this.lexer, this.rules);
    }
  }
  reflink(e, t) {
    let n;
    if ((n = this.rules.inline.reflink.exec(e)) || (n = this.rules.inline.nolink.exec(e))) {
      let i = n[0].charAt(0) === "!" ? 2 : 1;
      if (!this.options.pedantic && _e(e, n[1], i, this.rules))
        return;
      let r = (n[2] || n[1]).replace(this.rules.other.multipleSpaceGlobal, " "), o = t[v(r)];
      if (!o) {
        let s = n[0].charAt(0);
        return { type: "text", raw: s, text: s };
      }
      return Se(n, o, n[0], this.lexer, this.rules);
    }
  }
  emStrong(e, t, n = "") {
    let i = this.rules.inline.emStrongLDelim.exec(e);
    if (!i || !i[1] && !i[2] && !i[3] && !i[4] || i[4] && n.match(this.rules.other.unicodeAlphaNumeric))
      return;
    if (!(i[1] || i[3] || "") || !n || this.rules.inline.punctuation.exec(n)) {
      let o = [...i[0]].length - 1, s, l, u = o, c = 0, p = i[0][0], d = n === p, g = p === "*" ? this.rules.inline.emStrongRDelimAst : this.rules.inline.emStrongRDelimUnd;
      for (g.lastIndex = 0, t = t.slice(-1 * e.length + o);(i = g.exec(t)) !== null; ) {
        if (s = i[1] || i[2] || i[3] || i[4] || i[5] || i[6], !s)
          continue;
        if (l = [...s].length, i[3] || i[4]) {
          u += l;
          continue;
        } else if (i[5] || i[6]) {
          if (o % 3 && !((o + l) % 3)) {
            c += l;
            continue;
          }
          if (d)
            break;
        }
        if (u -= l, u > 0)
          continue;
        l = Math.min(l, l + u + c);
        let k = [...i[0]][0].length, P = e.slice(0, o + i.index + k + l);
        if (Math.min(o, l) % 2) {
          let m = P.slice(1, -1);
          return { type: "em", raw: P, text: m, tokens: this.lexer.inlineTokens(m) };
        }
        let R = P.slice(2, -2);
        return { type: "strong", raw: P, text: R, tokens: this.lexer.inlineTokens(R) };
      }
    }
  }
  codespan(e) {
    let t = this.rules.inline.code.exec(e);
    if (t) {
      let n = t[2].replace(this.rules.other.newLineCharGlobal, " "), i = this.rules.other.nonSpaceChar.test(n), r = this.rules.other.startingSpaceChar.test(n) && this.rules.other.endingSpaceChar.test(n);
      return i && r && (n = n.substring(1, n.length - 1)), { type: "codespan", raw: t[0], text: n };
    }
  }
  br(e) {
    let t = this.rules.inline.br.exec(e);
    if (t)
      return { type: "br", raw: t[0] };
  }
  del(e, t, n = "") {
    let i = this.rules.inline.delLDelim.exec(e);
    if (!i)
      return;
    if (!(i[1] || "") || !n || this.rules.inline.punctuation.exec(n)) {
      let o = [...i[0]].length - 1, s, l, u = o, c = this.rules.inline.delRDelim;
      for (c.lastIndex = 0, t = t.slice(-1 * e.length + o);(i = c.exec(t)) !== null; ) {
        if (s = i[1] || i[2] || i[3] || i[4] || i[5] || i[6], !s || (l = [...s].length, l !== o))
          continue;
        if (i[3] || i[4]) {
          u += l;
          continue;
        }
        if (u -= l, u > 0)
          continue;
        l = Math.min(l, l + u);
        let p = [...i[0]][0].length, d = e.slice(0, o + i.index + p + l), g = d.slice(o, -o);
        return { type: "del", raw: d, text: g, tokens: this.lexer.inlineTokens(g) };
      }
    }
  }
  autolink(e) {
    let t = this.rules.inline.autolink.exec(e);
    if (t) {
      let n, i;
      return t[2] === "@" ? (n = t[1], i = "mailto:" + n) : (n = t[1], i = n), { type: "link", raw: t[0], text: n, href: i, autolink: true, tokens: [{ type: "text", raw: n, text: n }] };
    }
  }
  url(e) {
    let t;
    if (t = this.rules.inline.url.exec(e)) {
      let n, i;
      if (t[2] === "@")
        n = t[0], i = "mailto:" + n;
      else {
        let r;
        do
          r = t[0], t[0] = this.rules.inline._backpedal.exec(t[0])?.[0] ?? "";
        while (r !== t[0]);
        n = t[0], t[1] === "www." ? i = "http://" + t[0] : i = t[0];
      }
      return { type: "link", raw: t[0], text: n, href: i, autolink: true, tokens: [{ type: "text", raw: n, text: n }] };
    }
  }
  inlineText(e) {
    let t = this.rules.inline.text.exec(e);
    if (t) {
      let n = this.lexer.state.inRawBlock;
      return { type: "text", raw: t[0], text: n ? t[0] : ye(t[0]), escaped: n };
    }
  }
};
var T = class a {
  tokens;
  options;
  state;
  inlineQueue;
  tokenizer;
  constructor(e) {
    this.tokens = [], this.tokens.links = Object.create(null), this.options = e || y, this.options.tokenizer = this.options.tokenizer || new _, this.tokenizer = this.options.tokenizer, this.tokenizer.options = this.options, this.tokenizer.lexer = this, this.inlineQueue = [], this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
    let t = { other: x, block: F.normal, inline: Z.normal };
    this.options.pedantic ? (t.block = F.pedantic, t.inline = Z.pedantic) : this.options.gfm && (t.block = F.gfm, this.options.breaks ? t.inline = Z.breaks : t.inline = Z.gfm), this.tokenizer.rules = t;
  }
  static get rules() {
    return { block: F, inline: Z };
  }
  static lex(e, t) {
    return new a(t).lex(e);
  }
  static lexInline(e, t) {
    return new a(t).inlineTokens(e);
  }
  lex(e) {
    e = e.replace(x.carriageReturn, `
`), this.blockTokens(e, this.tokens);
    for (let t = 0;t < this.inlineQueue.length; t++) {
      let n = this.inlineQueue[t];
      this.inlineTokens(n.src, n.tokens);
    }
    return this.inlineQueue = [], this.tokens;
  }
  blockTokens(e, t = [], n = false) {
    this.tokenizer.lexer = this, this.options.pedantic && (e = e.replace(x.tabCharGlobal, "    ").replace(x.spaceLine, ""));
    let i = 1 / 0;
    for (;e; ) {
      if (e.length < i)
        i = e.length;
      else {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
      let r;
      if (this.options.extensions?.block?.some((s) => (r = s.call({ lexer: this }, e, t)) ? (e = e.substring(r.raw.length), t.push(r), true) : false))
        continue;
      if (r = this.tokenizer.space(e)) {
        e = e.substring(r.raw.length);
        let s = t.at(-1);
        r.raw.length === 1 && s !== undefined ? s.raw += `
` : t.push(r);
        continue;
      }
      if (r = this.tokenizer.code(e)) {
        e = e.substring(r.raw.length);
        let s = t.at(-1);
        s?.type === "paragraph" || s?.type === "text" ? (s.raw += (s.raw.endsWith(`
`) ? "" : `
`) + r.raw, s.text += `
` + r.text, this.inlineQueue.at(-1).src = s.text) : t.push(r);
        continue;
      }
      if (r = this.tokenizer.fences(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.heading(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.hr(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.blockquote(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.list(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.html(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.def(e)) {
        e = e.substring(r.raw.length);
        let s = t.at(-1);
        s?.type === "paragraph" || s?.type === "text" ? (s.raw += (s.raw.endsWith(`
`) ? "" : `
`) + r.raw, s.text += `
` + r.raw, this.inlineQueue.at(-1).src = s.text) : this.tokens.links[r.tag] || (this.tokens.links[r.tag] = { href: r.href, title: r.title }, t.push(r));
        continue;
      }
      if (r = this.tokenizer.table(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.lheading(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      let o = e;
      if (this.options.extensions?.startBlock) {
        let s = 1 / 0, l = e.slice(1), u;
        this.options.extensions.startBlock.forEach((c) => {
          u = c.call({ lexer: this }, l), typeof u == "number" && u >= 0 && (s = Math.min(s, u));
        }), s < 1 / 0 && s >= 0 && (o = e.substring(0, s + 1));
      }
      if (this.state.top && (r = this.tokenizer.paragraph(o))) {
        let s = t.at(-1);
        n && s?.type === "paragraph" ? (s.raw += (s.raw.endsWith(`
`) ? "" : `
`) + r.raw, s.text += `
` + r.text, this.inlineQueue.pop(), this.inlineQueue.at(-1).src = s.text) : t.push(r), n = o.length !== e.length, e = e.substring(r.raw.length);
        continue;
      }
      if (r = this.tokenizer.text(e)) {
        e = e.substring(r.raw.length);
        let s = t.at(-1);
        s?.type === "text" ? (s.raw += (s.raw.endsWith(`
`) ? "" : `
`) + r.raw, s.text += `
` + r.text, this.inlineQueue.pop(), this.inlineQueue.at(-1).src = s.text) : t.push(r);
        continue;
      }
      if (e) {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
    }
    return this.state.top = true, t;
  }
  inline(e, t = []) {
    return this.inlineQueue.push({ src: e, tokens: t }), t;
  }
  linkInText(e) {
    if (!e.includes("["))
      return false;
    let t = this.tokenizer.rules.inline.link;
    for (let n of e.matchAll(this.tokenizer.rules.inline.blockSkip))
      if (t.test(n[0]) && e.charAt(n.index - 1) !== "!")
        return true;
    for (let n of e.matchAll(this.tokenizer.rules.inline.reflinkSearch)) {
      let i = n[0], r = i.lastIndexOf("[");
      if (!(i.charAt(0) === "!" || !Object.hasOwn(this.tokens.links, v(i.slice(r + 1, -1)))) && !(r > 1 && this.linkInText(i.slice(1, r - 1))))
        return true;
    }
    return false;
  }
  inlineTokens(e, t = []) {
    this.tokenizer.lexer = this;
    let n = this.state.linkParenPossible;
    this.state.linkParenPossible = n && e.includes(")");
    try {
      return this.#e(e, t);
    } finally {
      this.state.linkParenPossible = n;
    }
  }
  #e(e, t) {
    let n = e;
    if (this.tokens.links && e.includes("[")) {
      let s = this.tokenizer.rules.inline.reflinkSearch, l = (u) => {
        let c = u.lastIndexOf("[");
        if (!Object.hasOwn(this.tokens.links, v(u.slice(c + 1, -1))))
          return u;
        if (c > 1 && u.charAt(0) !== "!") {
          let p = u.slice(1, c - 1);
          if (this.linkInText(p))
            return "[" + p.replace(s, l) + "][" + "a".repeat(u.length - c - 2) + "]";
        }
        return "[" + "a".repeat(u.length - 2) + "]";
      };
      n = n.replace(s, l);
    }
    n = n.replace(this.tokenizer.rules.inline.anyPunctuationOutsideCode, (s, l, u) => u ? "+".repeat(s.length) : l ? l + s.slice(l.length, -l.length).replace(/`/g, "+") + l : s), n = n.replace(this.tokenizer.rules.inline.blockSkip, (s, l, u) => {
      let c = u ? u.length : 0;
      return s.slice(0, c) + "[" + "a".repeat(s.length - c - 2) + "]";
    }), n = this.options.hooks?.emStrongMask?.call({ lexer: this }, n) ?? n;
    let i = false, r = "", o = 1 / 0;
    for (;e; ) {
      if (e.length < o)
        o = e.length;
      else {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
      i || (r = ""), i = false;
      let s;
      if (this.options.extensions?.inline?.some((u) => (s = u.call({ lexer: this }, e, t)) ? (e = e.substring(s.raw.length), t.push(s), true) : false))
        continue;
      if (s = this.tokenizer.escape(e)) {
        e = e.substring(s.raw.length), t.push(s);
        continue;
      }
      if (s = this.tokenizer.tag(e)) {
        e = e.substring(s.raw.length), t.push(s);
        continue;
      }
      if (s = this.tokenizer.link(e)) {
        e = e.substring(s.raw.length), t.push(s);
        continue;
      }
      if (s = this.tokenizer.reflink(e, this.tokens.links)) {
        e = e.substring(s.raw.length);
        let u = t.at(-1);
        s.type === "text" && u?.type === "text" ? (u.raw += s.raw, u.text += s.text) : t.push(s);
        continue;
      }
      if (s = this.tokenizer.emStrong(e, n, r)) {
        e = e.substring(s.raw.length), t.push(s);
        continue;
      }
      if (s = this.tokenizer.codespan(e)) {
        e = e.substring(s.raw.length), t.push(s);
        continue;
      }
      if (s = this.tokenizer.br(e)) {
        e = e.substring(s.raw.length), t.push(s);
        continue;
      }
      if (s = this.tokenizer.del(e, n, r)) {
        e = e.substring(s.raw.length), t.push(s);
        continue;
      }
      if (s = this.tokenizer.autolink(e)) {
        e = e.substring(s.raw.length), t.push(s);
        continue;
      }
      if (!this.state.inLink && (s = this.tokenizer.url(e))) {
        e = e.substring(s.raw.length), t.push(s);
        continue;
      }
      let l = e;
      if (this.options.extensions?.startInline) {
        let u = 1 / 0, c = e.slice(1), p;
        this.options.extensions.startInline.forEach((d) => {
          p = d.call({ lexer: this }, c), typeof p == "number" && p >= 0 && (u = Math.min(u, p));
        }), u < 1 / 0 && u >= 0 && (l = e.substring(0, u + 1));
      }
      if (s = this.tokenizer.inlineText(l)) {
        e = e.substring(s.raw.length), s.raw.slice(-1) !== "_" && (r = s.raw.slice(-1)), i = true;
        let u = t.at(-1);
        u?.type === "text" ? (u.raw += s.raw, u.text += s.text) : t.push(s);
        continue;
      }
      if (e) {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
    }
    return t;
  }
  infiniteLoopError(e) {
    let t = "Infinite loop on byte: " + e;
    if (this.options.silent)
      console.error(t);
    else
      throw new Error(t);
  }
};
var $ = class {
  options;
  parser;
  constructor(e) {
    this.options = e || y;
  }
  space(e) {
    return "";
  }
  code({ text: e, lang: t, escaped: n }) {
    let i = (t || "").match(x.notSpaceStart)?.[0], r = e ? e.replace(x.endingNewline, "") + `
` : "";
    return i ? '<pre><code class="language-' + w(i) + '">' + (n ? r : w(r, true)) + `</code></pre>
` : "<pre><code>" + (n ? r : w(r, true)) + `</code></pre>
`;
  }
  blockquote({ tokens: e }) {
    return `<blockquote>
${this.parser.parse(e)}</blockquote>
`;
  }
  html({ text: e }) {
    return e;
  }
  def(e) {
    return "";
  }
  heading({ tokens: e, depth: t }) {
    return `<h${t}>${this.parser.parseInline(e)}</h${t}>
`;
  }
  hr(e) {
    return `<hr>
`;
  }
  list(e) {
    let { ordered: t, start: n } = e, i = "";
    for (let s = 0;s < e.items.length; s++) {
      let l = e.items[s];
      i += this.listitem(l);
    }
    let r = t ? "ol" : "ul", o = t && n !== 1 ? ' start="' + n + '"' : "";
    return "<" + r + o + `>
` + i + "</" + r + `>
`;
  }
  listitem(e) {
    return `<li>${this.parser.parse(e.tokens)}</li>
`;
  }
  checkbox({ checked: e }) {
    return "<input " + (e ? 'checked="" ' : "") + 'disabled="" type="checkbox"> ';
  }
  paragraph({ tokens: e }) {
    return `<p>${this.parser.parseInline(e)}</p>
`;
  }
  table(e) {
    let t = "", n = "";
    for (let r = 0;r < e.header.length; r++)
      n += this.tablecell(e.header[r]);
    t += this.tablerow({ text: n });
    let i = "";
    for (let r = 0;r < e.rows.length; r++) {
      let o = e.rows[r];
      n = "";
      for (let s = 0;s < o.length; s++)
        n += this.tablecell(o[s]);
      i += this.tablerow({ text: n });
    }
    return i && (i = `<tbody>${i}</tbody>`), `<table>
<thead>
` + t + `</thead>
` + i + `</table>
`;
  }
  tablerow({ text: e }) {
    return `<tr>
${e}</tr>
`;
  }
  tablecell(e) {
    let t = this.parser.parseInline(e.tokens), n = e.header ? "th" : "td";
    return (e.align ? `<${n} align="${e.align}">` : `<${n}>`) + t + `</${n}>
`;
  }
  strong({ tokens: e }) {
    return `<strong>${this.parser.parseInline(e)}</strong>`;
  }
  em({ tokens: e }) {
    return `<em>${this.parser.parseInline(e)}</em>`;
  }
  codespan({ text: e }) {
    return `<code>${w(e, true)}</code>`;
  }
  br(e) {
    return "<br>";
  }
  del({ tokens: e }) {
    return `<del>${this.parser.parseInline(e)}</del>`;
  }
  link({ href: e, title: t, text: n, tokens: i, autolink: r }) {
    let o = r ? w(n, true) : this.parser.parseInline(i), s = ie(e);
    if (s === null)
      return o;
    e = w(s, r);
    let l = '<a href="' + e + '"';
    return t && (l += ' title="' + w(t) + '"'), l += ">" + o + "</a>", l;
  }
  image({ href: e, title: t, text: n, tokens: i }) {
    i && (n = this.parser.parseInline(i, this.parser.textRenderer));
    let r = ie(e);
    if (r === null)
      return w(n);
    e = r;
    let o = `<img src="${w(e)}" alt="${w(n)}"`;
    return t && (o += ` title="${w(t)}"`), o += ">", o;
  }
  text(e) {
    return "tokens" in e && e.tokens ? this.parser.parseInline(e.tokens) : ("escaped" in e) && e.escaped ? e.text : w(e.text);
  }
};
var z = class {
  strong({ text: e }) {
    return e;
  }
  em({ text: e }) {
    return e;
  }
  codespan({ text: e }) {
    return e;
  }
  del({ text: e }) {
    return e;
  }
  html({ text: e }) {
    return e;
  }
  text({ text: e }) {
    return e;
  }
  link({ text: e }) {
    return "" + e;
  }
  image({ text: e }) {
    return "" + e;
  }
  br() {
    return "";
  }
  checkbox({ raw: e }) {
    return e;
  }
};
var O = class a {
  options;
  renderer;
  textRenderer;
  constructor(e) {
    this.options = e || y, this.options.renderer = this.options.renderer || new $, this.renderer = this.options.renderer, this.renderer.options = this.options, this.renderer.parser = this, this.textRenderer = new z;
  }
  static parse(e, t) {
    return new a(t).parse(e);
  }
  static parseInline(e, t) {
    return new a(t).parseInline(e);
  }
  parse(e) {
    this.renderer.parser = this;
    let t = "";
    for (let n = 0;n < e.length; n++) {
      let i = e[n];
      if (this.options.extensions?.renderers?.[i.type]) {
        let o = i, s = this.options.extensions.renderers[o.type].call({ parser: this }, o);
        if (s !== false || !["space", "hr", "heading", "code", "table", "blockquote", "list", "checkbox", "html", "def", "paragraph", "text"].includes(o.type)) {
          t += s || "";
          continue;
        }
      }
      let r = i;
      switch (r.type) {
        case "space": {
          t += this.renderer.space(r);
          break;
        }
        case "hr": {
          t += this.renderer.hr(r);
          break;
        }
        case "heading": {
          t += this.renderer.heading(r);
          break;
        }
        case "code": {
          t += this.renderer.code(r);
          break;
        }
        case "table": {
          t += this.renderer.table(r);
          break;
        }
        case "blockquote": {
          t += this.renderer.blockquote(r);
          break;
        }
        case "list": {
          t += this.renderer.list(r);
          break;
        }
        case "checkbox": {
          t += this.renderer.checkbox(r);
          break;
        }
        case "html": {
          t += this.renderer.html(r);
          break;
        }
        case "def": {
          t += this.renderer.def(r);
          break;
        }
        case "paragraph": {
          t += this.renderer.paragraph(r);
          break;
        }
        case "text": {
          t += this.renderer.text(r);
          break;
        }
        default: {
          let o = 'Token with "' + r.type + '" type was not found.';
          if (this.options.silent)
            return console.error(o), "";
          throw new Error(o);
        }
      }
    }
    return t;
  }
  parseInline(e, t = this.renderer) {
    this.renderer.parser = this;
    let n = "";
    for (let i = 0;i < e.length; i++) {
      let r = e[i];
      if (this.options.extensions?.renderers?.[r.type]) {
        let s = this.options.extensions.renderers[r.type].call({ parser: this }, r);
        if (s !== false || !["escape", "html", "link", "image", "checkbox", "strong", "em", "codespan", "br", "del", "text"].includes(r.type)) {
          n += s || "";
          continue;
        }
      }
      let o = r;
      switch (o.type) {
        case "escape": {
          n += t.text(o);
          break;
        }
        case "html": {
          n += t.html(o);
          break;
        }
        case "link": {
          n += t.link(o);
          break;
        }
        case "image": {
          n += t.image(o);
          break;
        }
        case "checkbox": {
          n += t.checkbox(o);
          break;
        }
        case "strong": {
          n += t.strong(o);
          break;
        }
        case "em": {
          n += t.em(o);
          break;
        }
        case "codespan": {
          n += t.codespan(o);
          break;
        }
        case "br": {
          n += t.br(o);
          break;
        }
        case "del": {
          n += t.del(o);
          break;
        }
        case "text": {
          n += t.text(o);
          break;
        }
        default: {
          let s = 'Token with "' + o.type + '" type was not found.';
          if (this.options.silent)
            return console.error(s), "";
          throw new Error(s);
        }
      }
    }
    return n;
  }
};
var L = class {
  options;
  block;
  constructor(e) {
    this.options = e || y;
  }
  static passThroughHooks = new Set(["preprocess", "postprocess", "processAllTokens", "emStrongMask"]);
  static passThroughHooksRespectAsync = new Set(["preprocess", "postprocess", "processAllTokens"]);
  preprocess(e) {
    return e;
  }
  postprocess(e) {
    return e;
  }
  processAllTokens(e) {
    return e;
  }
  emStrongMask(e) {
    return e;
  }
  provideLexer(e = this.block) {
    return e ? T.lex : T.lexInline;
  }
  provideParser(e = this.block) {
    return e ? O.parse : O.parseInline;
  }
};
function C(a, e) {
  if (Array.isArray(e))
    for (let t = 0;t < e.length; t++)
      a.push(e[t]);
  else
    a.push(e);
}
var U = class {
  defaults = B();
  options = this.setOptions;
  parse = this.parseMarkdown(true);
  parseInline = this.parseMarkdown(false);
  Parser = O;
  Renderer = $;
  TextRenderer = z;
  Lexer = T;
  Tokenizer = _;
  Hooks = L;
  constructor(...e) {
    this.use(...e);
  }
  walkTokens(e, t) {
    let n = [];
    for (let i of e)
      switch (C(n, t.call(this, i)), i.type) {
        case "table": {
          let r = i;
          for (let o of r.header)
            C(n, this.walkTokens(o.tokens, t));
          for (let o of r.rows)
            for (let s of o)
              C(n, this.walkTokens(s.tokens, t));
          break;
        }
        case "list": {
          let r = i;
          C(n, this.walkTokens(r.items, t));
          break;
        }
        default: {
          let r = i;
          this.defaults.extensions?.childTokens?.[r.type] ? this.defaults.extensions.childTokens[r.type].forEach((o) => {
            let s = r[o].flat(1 / 0);
            C(n, this.walkTokens(s, t));
          }) : r.tokens && C(n, this.walkTokens(r.tokens, t));
        }
      }
    return n;
  }
  use(...e) {
    let t = this.defaults.extensions || { renderers: {}, childTokens: {} };
    return e.forEach((n) => {
      let i = { ...n };
      if (i.async = this.defaults.async || i.async || false, n.extensions && (n.extensions.forEach((r) => {
        if (!r.name)
          throw new Error("extension name required");
        if ("renderer" in r) {
          let o = t.renderers[r.name];
          o ? t.renderers[r.name] = function(...s) {
            let l = r.renderer.apply(this, s);
            return l === false && (l = o.apply(this, s)), l;
          } : t.renderers[r.name] = r.renderer;
        }
        if ("tokenizer" in r) {
          if (!r.level || r.level !== "block" && r.level !== "inline")
            throw new Error("extension level must be 'block' or 'inline'");
          let o = t[r.level];
          o ? o.unshift(r.tokenizer) : t[r.level] = [r.tokenizer], r.start && (r.level === "block" ? t.startBlock ? t.startBlock.push(r.start) : t.startBlock = [r.start] : r.level === "inline" && (t.startInline ? t.startInline.push(r.start) : t.startInline = [r.start]));
        }
        "childTokens" in r && r.childTokens && (t.childTokens[r.name] = r.childTokens);
      }), i.extensions = t), n.renderer) {
        let r = this.defaults.renderer || new $(this.defaults);
        for (let o in n.renderer) {
          if (!(o in r))
            throw new Error(`renderer '${o}' does not exist`);
          if (["options", "parser"].includes(o))
            continue;
          let s = o, l = n.renderer[s], u = r[s];
          r[s] = (...c) => {
            let p = l.apply(r, c);
            return p === false && (p = u.apply(r, c)), p || "";
          };
        }
        i.renderer = r;
      }
      if (n.tokenizer) {
        let r = this.defaults.tokenizer || new _(this.defaults);
        for (let o in n.tokenizer) {
          if (!(o in r))
            throw new Error(`tokenizer '${o}' does not exist`);
          if (["options", "rules", "lexer"].includes(o))
            continue;
          let s = o, l = n.tokenizer[s], u = r[s];
          r[s] = (...c) => {
            let p = l.apply(r, c);
            return p === false && (p = u.apply(r, c)), p;
          };
        }
        i.tokenizer = r;
      }
      if (n.hooks) {
        let r = this.defaults.hooks || new L;
        for (let o in n.hooks) {
          if (!(o in r))
            throw new Error(`hook '${o}' does not exist`);
          if (["options", "block"].includes(o))
            continue;
          let s = o, l = n.hooks[s], u = r[s];
          L.passThroughHooks.has(o) ? r[s] = (c) => {
            if (this.defaults.async && L.passThroughHooksRespectAsync.has(o))
              return (async () => {
                let d = await l.call(r, c);
                return u.call(r, d);
              })();
            let p = l.call(r, c);
            return u.call(r, p);
          } : r[s] = (...c) => {
            if (this.defaults.async)
              return (async () => {
                let d = await l.apply(r, c);
                return d === false && (d = await u.apply(r, c)), d;
              })();
            let p = l.apply(r, c);
            return p === false && (p = u.apply(r, c)), p;
          };
        }
        i.hooks = r;
      }
      if (n.walkTokens) {
        let r = this.defaults.walkTokens, o = n.walkTokens;
        i.walkTokens = function(s) {
          let l = [];
          return l.push(o.call(this, s)), r && C(l, r.call(this, s)), l;
        };
      }
      this.defaults = { ...this.defaults, ...i };
    }), this;
  }
  setOptions(e) {
    return this.defaults = { ...this.defaults, ...e }, this;
  }
  lexer(e, t) {
    return T.lex(e, t ?? this.defaults);
  }
  parser(e, t) {
    return O.parse(e, t ?? this.defaults);
  }
  parseMarkdown(e) {
    return (n, i) => {
      let r = { ...i }, o = { ...this.defaults, ...r }, s = this.onError(!!o.silent, !!o.async);
      if (this.defaults.async === true && r.async === false)
        return s(new Error("marked(): The async option was set to true by an extension. Remove async: false from the parse options object to return a Promise."));
      if (typeof n > "u" || n === null)
        return s(new Error("marked(): input parameter is undefined or null"));
      if (typeof n != "string")
        return s(new Error("marked(): input parameter is of type " + Object.prototype.toString.call(n) + ", string expected"));
      if (o.hooks && (o.hooks.options = o, o.hooks.block = e), o.async)
        return (async () => {
          let l = o.hooks ? await o.hooks.preprocess(n) : n, c = await (o.hooks ? await o.hooks.provideLexer(e) : e ? T.lex : T.lexInline)(l, o), p = o.hooks ? await o.hooks.processAllTokens(c) : c;
          o.walkTokens && await Promise.all(this.walkTokens(p, o.walkTokens));
          let g = await (o.hooks ? await o.hooks.provideParser(e) : e ? O.parse : O.parseInline)(p, o);
          return o.hooks ? await o.hooks.postprocess(g) : g;
        })().catch(s);
      try {
        o.hooks && (n = o.hooks.preprocess(n));
        let u = (o.hooks ? o.hooks.provideLexer(e) : e ? T.lex : T.lexInline)(n, o);
        o.hooks && (u = o.hooks.processAllTokens(u)), o.walkTokens && this.walkTokens(u, o.walkTokens);
        let p = (o.hooks ? o.hooks.provideParser(e) : e ? O.parse : O.parseInline)(u, o);
        return o.hooks && (p = o.hooks.postprocess(p)), p;
      } catch (l) {
        return s(l);
      }
    };
  }
  onError(e, t) {
    return (n) => {
      if (n.message += `
Please report this to https://github.com/markedjs/marked.`, e) {
        let i = "<p>An error occurred:</p><pre>" + w(n.message + "", true) + "</pre>";
        return t ? Promise.resolve(i) : i;
      }
      if (t)
        return Promise.reject(n);
      throw n;
    };
  }
};
var I = new U;
function f(a, e) {
  return I.parse(a, e);
}
f.options = f.setOptions = function(a) {
  return I.setOptions(a), f.defaults = I.defaults, V(f.defaults), f;
};
f.getDefaults = B;
f.defaults = y;
function At(...a) {
  return I.use(...a), f.defaults = I.defaults, V(f.defaults), f;
}
f.use = At;
f.walkTokens = function(a, e) {
  return I.walkTokens(a, e);
};
f.parseInline = I.parseInline;
f.Parser = O;
f.parser = O.parse;
f.Renderer = $;
f.TextRenderer = z;
f.Lexer = T;
f.lexer = T.lex;
f.Tokenizer = _;
f.Hooks = L;
f.parse = f;
var Rn = f.options;
var Tn = f.setOptions;
var On = f.walkTokens;
var wn = f.parseInline;
var yn = O.parse;
var Sn = T.lex;

// node_modules/dompurify/dist/purify.es.mjs
/*! @license DOMPurify 3.4.17 | (c) Cure53 and other contributors | Released under the Apache license 2.0 and Mozilla Public License 2.0 | github.com/cure53/DOMPurify/blob/3.4.17/LICENSE */
function _OverloadYield(e, d) {
  this.v = e, this.k = d;
}
function _arrayLikeToArray(r, a) {
  (a == null || a > r.length) && (a = r.length);
  for (var e = 0, n = Array(a);e < a; e++)
    n[e] = r[e];
  return n;
}
function _arrayWithHoles(r) {
  if (Array.isArray(r))
    return r;
}
function _iterableToArrayLimit(r, l) {
  var t = r == null ? null : typeof Symbol != "undefined" && r[Symbol.iterator] || r["@@iterator"];
  if (t != null) {
    var e, n, i, u, a = [], f = true, o = false;
    try {
      if (i = (t = t.call(r)).next, l === 0) {
        if (Object(t) !== t)
          return;
        f = false;
      } else
        for (;!(f = (e = i.call(t)).done) && (a.push(e.value), a.length !== l); f = true)
          ;
    } catch (r) {
      o = true, n = r;
    } finally {
      try {
        if (!f && t.return != null && (u = t.return(), Object(u) !== u))
          return;
      } finally {
        if (o)
          throw n;
      }
    }
    return a;
  }
}
function _nonIterableRest() {
  throw new TypeError(`Invalid attempt to destructure non-iterable instance.
In order to be iterable, non-array objects must have a [Symbol.iterator]() method.`);
}
/*! regenerator-runtime -- Copyright (c) 2014-present, Facebook, Inc. -- license (MIT): https://github.com/babel/babel/blob/main/packages/babel-helpers/LICENSE */
function _slicedToArray(r, e) {
  return _arrayWithHoles(r) || _iterableToArrayLimit(r, e) || _unsupportedIterableToArray(r, e) || _nonIterableRest();
}
function _unsupportedIterableToArray(r, a) {
  if (r) {
    if (typeof r == "string")
      return _arrayLikeToArray(r, a);
    var t = {}.toString.call(r).slice(8, -1);
    return t === "Object" && r.constructor && (t = r.constructor.name), t === "Map" || t === "Set" ? Array.from(r) : t === "Arguments" || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(t) ? _arrayLikeToArray(r, a) : undefined;
  }
}
function AsyncGenerator(e) {
  var t, n;
  function resume(t, n) {
    try {
      var r = e[t](n), o = r.value, u = o instanceof _OverloadYield;
      Promise.resolve(u ? o.v : o).then(function(n) {
        if (u) {
          var i = t === "return" && o.k ? t : "next";
          if (!o.k || n.done)
            return resume(i, n);
          n = e[i](n).value;
        }
        settle(!!r.done, n);
      }, function(e) {
        resume("throw", e);
      });
    } catch (e) {
      settle(2, e);
    }
  }
  function settle(e, r) {
    e === 2 ? t.reject(r) : t.resolve({
      value: r,
      done: e
    }), (t = t.next) ? resume(t.key, t.arg) : n = null;
  }
  this._invoke = function(e, r) {
    return new Promise(function(o, u) {
      var i = {
        key: e,
        arg: r,
        resolve: o,
        reject: u,
        next: null
      };
      n ? n = n.next = i : (t = n = i, resume(e, r));
    });
  }, typeof e.return != "function" && (this.return = undefined);
}
AsyncGenerator.prototype[typeof Symbol == "function" && Symbol.asyncIterator || "@@asyncIterator"] = function() {
  return this;
}, AsyncGenerator.prototype.next = function(e) {
  return this._invoke("next", e);
}, AsyncGenerator.prototype.throw = function(e) {
  return this._invoke("throw", e);
}, AsyncGenerator.prototype.return = function(e) {
  return this._invoke("return", e);
};
var entries = Object.entries;
var setPrototypeOf = Object.setPrototypeOf;
var isFrozen = Object.isFrozen;
var getPrototypeOf = Object.getPrototypeOf;
var getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
var freeze = Object.freeze;
var seal = Object.seal;
var create = Object.create;
var _ref = typeof Reflect !== "undefined" && Reflect;
var apply = _ref.apply;
var construct = _ref.construct;
if (!freeze)
  freeze = function freeze(x) {
    return x;
  };
if (!seal)
  seal = function seal(x) {
    return x;
  };
if (!apply)
  apply = function apply(func, thisArg) {
    for (var _len = arguments.length, args = new Array(_len > 2 ? _len - 2 : 0), _key = 2;_key < _len; _key++)
      args[_key - 2] = arguments[_key];
    return func.apply(thisArg, args);
  };
if (!construct)
  construct = function construct(Func) {
    for (var _len2 = arguments.length, args = new Array(_len2 > 1 ? _len2 - 1 : 0), _key2 = 1;_key2 < _len2; _key2++)
      args[_key2 - 1] = arguments[_key2];
    return new Func(...args);
  };
var arrayForEach = unapply(Array.prototype.forEach);
Array.prototype.indexOf;
var arrayLastIndexOf = unapply(Array.prototype.lastIndexOf);
var arrayPop = unapply(Array.prototype.pop);
var arrayPush = unapply(Array.prototype.push);
var arraySlice = unapply(Array.prototype.slice);
var arraySplice = unapply(Array.prototype.splice);
var arrayIsArray = Array.isArray;
var setCreate = unconstruct(Set);
var setAdd = unapply(Set.prototype.add);
var setHas = unapply(Set.prototype.has);
var stringToLowerCase = unapply(String.prototype.toLowerCase);
var stringToString = unapply(String.prototype.toString);
var stringMatch = unapply(String.prototype.match);
var stringReplace = unapply(String.prototype.replace);
var stringIndexOf = unapply(String.prototype.indexOf);
var stringTrim = unapply(String.prototype.trim);
var numberToString = unapply(Number.prototype.toString);
var booleanToString = unapply(Boolean.prototype.toString);
var bigintToString = typeof BigInt === "undefined" ? null : unapply(BigInt.prototype.toString);
var symbolToString = typeof Symbol === "undefined" ? null : unapply(Symbol.prototype.toString);
var objectHasOwnProperty = unapply(Object.prototype.hasOwnProperty);
var objectToString = unapply(Object.prototype.toString);
var regExpTest = unapply(RegExp.prototype.test);
var typeErrorCreate = unconstruct(TypeError);
function unapply(func) {
  return function(thisArg) {
    if (thisArg instanceof RegExp)
      thisArg.lastIndex = 0;
    for (var _len3 = arguments.length, args = new Array(_len3 > 1 ? _len3 - 1 : 0), _key3 = 1;_key3 < _len3; _key3++)
      args[_key3 - 1] = arguments[_key3];
    return apply(func, thisArg, args);
  };
}
function unconstruct(Func) {
  return function() {
    for (var _len4 = arguments.length, args = new Array(_len4), _key4 = 0;_key4 < _len4; _key4++)
      args[_key4] = arguments[_key4];
    return construct(Func, args);
  };
}
function addToSet(set, array) {
  let transformCaseFunc = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : stringToLowerCase;
  if (setPrototypeOf)
    setPrototypeOf(set, null);
  if (!arrayIsArray(array))
    return set;
  let l = array.length;
  while (l--) {
    let element = array[l];
    if (typeof element === "string") {
      const lcElement = transformCaseFunc(element);
      if (lcElement !== element) {
        if (!isFrozen(array))
          array[l] = lcElement;
        element = lcElement;
      }
    }
    set[element] = true;
  }
  return set;
}
function cleanArray(array) {
  for (let index = 0;index < array.length; index++)
    if (!objectHasOwnProperty(array, index))
      array[index] = null;
  return array;
}
function clone(object) {
  const newObject = create(null);
  for (const _ref2 of entries(object)) {
    var _ref3 = _slicedToArray(_ref2, 2);
    const property = _ref3[0];
    const value = _ref3[1];
    if (objectHasOwnProperty(object, property)) {
      if (arrayIsArray(value))
        newObject[property] = cleanArray(value);
      else if (value && typeof value === "object" && value.constructor === Object)
        newObject[property] = clone(value);
      else
        newObject[property] = value;
    }
  }
  return newObject;
}
function stringifyValue(value) {
  switch (typeof value) {
    case "string":
      return value;
    case "number":
      return numberToString(value);
    case "boolean":
      return booleanToString(value);
    case "bigint":
      return bigintToString ? bigintToString(value) : "0";
    case "symbol":
      return symbolToString ? symbolToString(value) : "Symbol()";
    case "undefined":
      return objectToString(value);
    case "function":
    case "object": {
      if (value === null)
        return objectToString(value);
      const valueAsRecord = value;
      const valueToString = lookupGetter(valueAsRecord, "toString");
      if (typeof valueToString === "function") {
        const stringified = valueToString(valueAsRecord);
        return typeof stringified === "string" ? stringified : objectToString(stringified);
      }
      return objectToString(value);
    }
    default:
      return objectToString(value);
  }
}
function lookupGetter(object, prop) {
  while (object !== null) {
    const desc = getOwnPropertyDescriptor(object, prop);
    if (desc) {
      if (desc.get)
        return unapply(desc.get);
      if (typeof desc.value === "function")
        return unapply(desc.value);
    }
    object = getPrototypeOf(object);
  }
  function fallbackValue() {
    return null;
  }
  return fallbackValue;
}
function lookupAccessor(object, prop) {
  while (object !== null) {
    const desc = getOwnPropertyDescriptor(object, prop);
    if (desc)
      return desc.get ? unapply(desc.get) : null;
    object = getPrototypeOf(object);
  }
  return null;
}
function isRegex(value) {
  try {
    regExpTest(value, "");
    return true;
  } catch (_unused) {
    return false;
  }
}
var html$1 = freeze([
  "a",
  "abbr",
  "acronym",
  "address",
  "area",
  "article",
  "aside",
  "audio",
  "b",
  "bdi",
  "bdo",
  "big",
  "blink",
  "blockquote",
  "body",
  "br",
  "button",
  "canvas",
  "caption",
  "center",
  "cite",
  "code",
  "col",
  "colgroup",
  "content",
  "data",
  "datalist",
  "dd",
  "decorator",
  "del",
  "details",
  "dfn",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "element",
  "em",
  "fieldset",
  "figcaption",
  "figure",
  "font",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hgroup",
  "hr",
  "html",
  "i",
  "img",
  "input",
  "ins",
  "kbd",
  "label",
  "legend",
  "li",
  "main",
  "map",
  "mark",
  "marquee",
  "menu",
  "menuitem",
  "meter",
  "nav",
  "nobr",
  "ol",
  "optgroup",
  "option",
  "output",
  "p",
  "picture",
  "pre",
  "progress",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "search",
  "section",
  "select",
  "shadow",
  "slot",
  "small",
  "source",
  "spacer",
  "span",
  "strike",
  "strong",
  "style",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "template",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "track",
  "tt",
  "u",
  "ul",
  "var",
  "video",
  "wbr"
]);
var svg$1 = freeze([
  "svg",
  "a",
  "altglyph",
  "altglyphdef",
  "altglyphitem",
  "animatecolor",
  "animatemotion",
  "animatetransform",
  "circle",
  "clippath",
  "defs",
  "desc",
  "ellipse",
  "enterkeyhint",
  "exportparts",
  "filter",
  "font",
  "g",
  "glyph",
  "glyphref",
  "hkern",
  "image",
  "inputmode",
  "line",
  "lineargradient",
  "marker",
  "mask",
  "metadata",
  "mpath",
  "part",
  "path",
  "pattern",
  "polygon",
  "polyline",
  "radialgradient",
  "rect",
  "stop",
  "style",
  "switch",
  "symbol",
  "text",
  "textpath",
  "title",
  "tref",
  "tspan",
  "view",
  "vkern"
]);
var svgFilters = freeze([
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feComposite",
  "feConvolveMatrix",
  "feDiffuseLighting",
  "feDisplacementMap",
  "feDistantLight",
  "feDropShadow",
  "feFlood",
  "feFuncA",
  "feFuncB",
  "feFuncG",
  "feFuncR",
  "feGaussianBlur",
  "feImage",
  "feMerge",
  "feMergeNode",
  "feMorphology",
  "feOffset",
  "fePointLight",
  "feSpecularLighting",
  "feSpotLight",
  "feTile",
  "feTurbulence"
]);
var svgDisallowed = freeze([
  "animate",
  "color-profile",
  "cursor",
  "discard",
  "font-face",
  "font-face-format",
  "font-face-name",
  "font-face-src",
  "font-face-uri",
  "foreignobject",
  "hatch",
  "hatchpath",
  "mesh",
  "meshgradient",
  "meshpatch",
  "meshrow",
  "missing-glyph",
  "script",
  "set",
  "solidcolor",
  "unknown",
  "use"
]);
var mathMl$1 = freeze([
  "math",
  "menclose",
  "merror",
  "mfenced",
  "mfrac",
  "mglyph",
  "mi",
  "mlabeledtr",
  "mmultiscripts",
  "mn",
  "mo",
  "mover",
  "mpadded",
  "mphantom",
  "mroot",
  "mrow",
  "ms",
  "mspace",
  "msqrt",
  "mstyle",
  "msub",
  "msup",
  "msubsup",
  "mtable",
  "mtd",
  "mtext",
  "mtr",
  "munder",
  "munderover",
  "mprescripts"
]);
var mathMlDisallowed = freeze([
  "maction",
  "maligngroup",
  "malignmark",
  "mlongdiv",
  "mscarries",
  "mscarry",
  "msgroup",
  "mstack",
  "msline",
  "msrow",
  "semantics",
  "annotation",
  "annotation-xml",
  "mprescripts",
  "none"
]);
var text = freeze(["#text"]);
var html = freeze([
  "accept",
  "action",
  "align",
  "alt",
  "autocapitalize",
  "autocomplete",
  "autopictureinpicture",
  "autoplay",
  "background",
  "bgcolor",
  "border",
  "capture",
  "cellpadding",
  "cellspacing",
  "checked",
  "cite",
  "class",
  "clear",
  "color",
  "cols",
  "colspan",
  "command",
  "commandfor",
  "controls",
  "controlslist",
  "coords",
  "crossorigin",
  "datetime",
  "decoding",
  "default",
  "dir",
  "disabled",
  "disablepictureinpicture",
  "disableremoteplayback",
  "download",
  "draggable",
  "enctype",
  "enterkeyhint",
  "exportparts",
  "face",
  "for",
  "headers",
  "height",
  "hidden",
  "high",
  "href",
  "hreflang",
  "id",
  "inert",
  "inputmode",
  "integrity",
  "ismap",
  "kind",
  "label",
  "lang",
  "list",
  "loading",
  "loop",
  "low",
  "max",
  "maxlength",
  "media",
  "method",
  "min",
  "minlength",
  "multiple",
  "muted",
  "name",
  "nonce",
  "noshade",
  "novalidate",
  "nowrap",
  "open",
  "optimum",
  "part",
  "pattern",
  "placeholder",
  "playsinline",
  "popover",
  "popovertarget",
  "popovertargetaction",
  "poster",
  "preload",
  "pubdate",
  "radiogroup",
  "readonly",
  "rel",
  "required",
  "rev",
  "reversed",
  "role",
  "rows",
  "rowspan",
  "spellcheck",
  "scope",
  "selected",
  "shape",
  "size",
  "sizes",
  "slot",
  "span",
  "srclang",
  "start",
  "src",
  "srcset",
  "step",
  "style",
  "summary",
  "tabindex",
  "title",
  "translate",
  "type",
  "usemap",
  "valign",
  "value",
  "width",
  "wrap",
  "xmlns"
]);
var svg = freeze([
  "accent-height",
  "accumulate",
  "additive",
  "alignment-baseline",
  "amplitude",
  "ascent",
  "attributename",
  "attributetype",
  "azimuth",
  "basefrequency",
  "baseline-shift",
  "begin",
  "bias",
  "by",
  "class",
  "clip",
  "clippathunits",
  "clip-path",
  "clip-rule",
  "color",
  "color-interpolation",
  "color-interpolation-filters",
  "color-profile",
  "color-rendering",
  "cx",
  "cy",
  "d",
  "dx",
  "dy",
  "diffuseconstant",
  "direction",
  "display",
  "divisor",
  "dominant-baseline",
  "dur",
  "edgemode",
  "elevation",
  "end",
  "exponent",
  "fill",
  "fill-opacity",
  "fill-rule",
  "filter",
  "filterunits",
  "flood-color",
  "flood-opacity",
  "font-family",
  "font-size",
  "font-size-adjust",
  "font-stretch",
  "font-style",
  "font-variant",
  "font-weight",
  "fx",
  "fy",
  "g1",
  "g2",
  "glyph-name",
  "glyphref",
  "gradientunits",
  "gradienttransform",
  "height",
  "href",
  "id",
  "image-rendering",
  "in",
  "in2",
  "intercept",
  "k",
  "k1",
  "k2",
  "k3",
  "k4",
  "kerning",
  "keypoints",
  "keysplines",
  "keytimes",
  "lang",
  "lengthadjust",
  "letter-spacing",
  "kernelmatrix",
  "kernelunitlength",
  "lighting-color",
  "local",
  "marker-end",
  "marker-mid",
  "marker-start",
  "markerheight",
  "markerunits",
  "markerwidth",
  "maskcontentunits",
  "maskunits",
  "max",
  "mask",
  "mask-type",
  "media",
  "method",
  "mode",
  "min",
  "name",
  "numoctaves",
  "offset",
  "operator",
  "opacity",
  "order",
  "orient",
  "orientation",
  "origin",
  "overflow",
  "paint-order",
  "path",
  "pathlength",
  "patterncontentunits",
  "patterntransform",
  "patternunits",
  "pointer-events",
  "points",
  "preservealpha",
  "preserveaspectratio",
  "primitiveunits",
  "r",
  "rx",
  "ry",
  "radius",
  "refx",
  "refy",
  "repeatcount",
  "repeatdur",
  "restart",
  "result",
  "rotate",
  "scale",
  "seed",
  "shape-rendering",
  "slope",
  "specularconstant",
  "specularexponent",
  "spreadmethod",
  "startoffset",
  "stddeviation",
  "stitchtiles",
  "stop-color",
  "stop-opacity",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke",
  "stroke-width",
  "style",
  "surfacescale",
  "systemlanguage",
  "tabindex",
  "tablevalues",
  "targetx",
  "targety",
  "transform",
  "transform-origin",
  "text-anchor",
  "text-decoration",
  "text-orientation",
  "text-rendering",
  "textlength",
  "type",
  "u1",
  "u2",
  "unicode",
  "values",
  "vector-effect",
  "viewbox",
  "visibility",
  "version",
  "vert-adv-y",
  "vert-origin-x",
  "vert-origin-y",
  "width",
  "word-spacing",
  "wrap",
  "writing-mode",
  "xchannelselector",
  "ychannelselector",
  "x",
  "x1",
  "x2",
  "xmlns",
  "y",
  "y1",
  "y2",
  "z",
  "zoomandpan"
]);
var mathMl = freeze([
  "accent",
  "accentunder",
  "align",
  "bevelled",
  "close",
  "columnalign",
  "columnlines",
  "columnspacing",
  "columnspan",
  "denomalign",
  "depth",
  "dir",
  "display",
  "displaystyle",
  "encoding",
  "fence",
  "frame",
  "height",
  "href",
  "id",
  "largeop",
  "length",
  "linethickness",
  "lquote",
  "lspace",
  "mathbackground",
  "mathcolor",
  "mathsize",
  "mathvariant",
  "maxsize",
  "minsize",
  "movablelimits",
  "notation",
  "numalign",
  "open",
  "rowalign",
  "rowlines",
  "rowspacing",
  "rowspan",
  "rspace",
  "rquote",
  "scriptlevel",
  "scriptminsize",
  "scriptsizemultiplier",
  "selection",
  "separator",
  "separators",
  "stretchy",
  "subscriptshift",
  "supscriptshift",
  "symmetric",
  "voffset",
  "width",
  "xmlns"
]);
var xml = freeze([
  "xlink:href",
  "xml:id",
  "xlink:title",
  "xml:space",
  "xmlns:xlink"
]);
var MUSTACHE_EXPR = seal(/{{[\w\W]*|^[\w\W]*}}/g);
var ERB_EXPR = seal(/<%[\w\W]*|^[\w\W]*%>/g);
var TMPLIT_EXPR = seal(/\${[\w\W]*/g);
var DATA_ATTR = seal(/^data-[\-\w.\u00B7-\uFFFF]+$/);
var ARIA_ATTR = seal(/^aria-[\-\w]+$/);
var IS_ALLOWED_URI = seal(/^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i);
var IS_SCRIPT_OR_DATA = seal(/^(?:\w+script|data):/i);
var ATTR_WHITESPACE = seal(/[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g);
var DOCTYPE_NAME = seal(/^html$/i);
var CUSTOM_ELEMENT = seal(/^[a-z][.\w]*(-[.\w]+)+$/i);
var ELEMENT_MARKUP_PROBE = seal(/<[/\w!]/g);
var COMMENT_MARKUP_PROBE = seal(/<[/\w]/g);
var FALLBACK_TAG_CLOSE = seal(/<\/no(script|embed|frames)/i);
var SELF_CLOSING_TAG = seal(/\/>/i);
var NODE_TYPE = {
  element: 1,
  attribute: 2,
  text: 3,
  cdataSection: 4,
  entityReference: 5,
  entityNode: 6,
  processingInstruction: 7,
  comment: 8,
  document: 9,
  documentType: 10,
  documentFragment: 11,
  notation: 12
};
var LITERAL_TEXT_ELEMENTS = freeze(addToSet({}, [
  "style",
  "script",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "plaintext",
  "noscript"
]));
var getGlobal = function getGlobal() {
  return typeof window === "undefined" ? null : window;
};
var _createTrustedTypesPolicy = function _createTrustedTypesPolicy(trustedTypes, purifyHostElement) {
  if (typeof trustedTypes !== "object" || typeof trustedTypes.createPolicy !== "function")
    return null;
  let suffix = null;
  const ATTR_NAME = "data-tt-policy-suffix";
  if (purifyHostElement && purifyHostElement.hasAttribute(ATTR_NAME))
    suffix = purifyHostElement.getAttribute(ATTR_NAME);
  const policyName = "dompurify" + (suffix ? "#" + suffix : "");
  try {
    return trustedTypes.createPolicy(policyName, {
      createHTML(html) {
        return html;
      },
      createScriptURL(scriptUrl) {
        return scriptUrl;
      }
    });
  } catch (_) {
    console.warn("TrustedTypes policy " + policyName + " could not be created.");
    return null;
  }
};
var _createHooksMap = function _createHooksMap() {
  return {
    afterSanitizeAttributes: [],
    afterSanitizeElements: [],
    afterSanitizeShadowDOM: [],
    beforeSanitizeAttributes: [],
    beforeSanitizeElements: [],
    beforeSanitizeShadowDOM: [],
    uponSanitizeAttribute: [],
    uponSanitizeElement: [],
    uponSanitizeShadowNode: []
  };
};
var _resolveSetOption = function _resolveSetOption(cfg, key, fallback, options) {
  return objectHasOwnProperty(cfg, key) && arrayIsArray(cfg[key]) ? addToSet(options.base ? clone(options.base) : {}, cfg[key], options.transform) : fallback;
};
var _resolveObjectOption = function _resolveObjectOption(cfg, key, makeFallback) {
  const value = objectHasOwnProperty(cfg, key) ? cfg[key] : undefined;
  return value && typeof value === "object" ? clone(value) : makeFallback();
};
function createDOMPurify() {
  let window2 = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : getGlobal();
  const DOMPurify = (root) => createDOMPurify(root);
  DOMPurify.version = "3.4.17";
  DOMPurify.removed = [];
  if (!window2 || !window2.document || window2.document.nodeType !== NODE_TYPE.document || !window2.Element) {
    DOMPurify.isSupported = false;
    return DOMPurify;
  }
  let document2 = window2.document;
  const originalDocument = document2;
  const currentScript = originalDocument.currentScript;
  window2.DocumentFragment;
  const { HTMLTemplateElement, Node, Element, NodeFilter } = window2;
  window2.NamedNodeMap === undefined && (window2.NamedNodeMap || window2.MozNamedAttrMap);
  window2.HTMLFormElement;
  const { DOMParser, trustedTypes } = window2;
  const ElementPrototype = Element.prototype;
  const cloneNode = lookupGetter(ElementPrototype, "cloneNode");
  const remove = lookupGetter(ElementPrototype, "remove");
  const removeAttributeNode = lookupGetter(ElementPrototype, "removeAttributeNode");
  const getNextSibling = lookupGetter(ElementPrototype, "nextSibling");
  const getChildNodes = lookupGetter(ElementPrototype, "childNodes");
  const getParentNode = lookupGetter(ElementPrototype, "parentNode");
  const getShadowRoot = lookupGetter(ElementPrototype, "shadowRoot");
  const getAttributes = lookupGetter(ElementPrototype, "attributes");
  const getNodeType = Node && Node.prototype ? lookupGetter(Node.prototype, "nodeType") : null;
  const getNodeName = Node && Node.prototype ? lookupGetter(Node.prototype, "nodeName") : null;
  const getOwnerDocument = Node && Node.prototype ? lookupGetter(Node.prototype, "ownerDocument") : null;
  const _readNodeType = function _readNodeType(node) {
    return getNodeType ? getNodeType(node) : node.nodeType;
  };
  const _readNodeName = function _readNodeName(node) {
    return getNodeName ? getNodeName(node) : node.nodeName;
  };
  const getNamespaceURI = lookupAccessor(ElementPrototype, "namespaceURI");
  const _readNamespaceURI = function _readNamespaceURI(element) {
    return getNamespaceURI ? getNamespaceURI(element) : element.namespaceURI;
  };
  if (typeof HTMLTemplateElement === "function") {
    const template = document2.createElement("template");
    if (template.content && template.content.ownerDocument)
      document2 = template.content.ownerDocument;
  }
  let trustedTypesPolicy;
  let emptyHTML = "";
  let defaultTrustedTypesPolicy;
  let defaultTrustedTypesPolicyResolved = false;
  let IN_TRUSTED_TYPES_POLICY = 0;
  const _assertNotInTrustedTypesPolicy = function _assertNotInTrustedTypesPolicy() {
    if (IN_TRUSTED_TYPES_POLICY > 0)
      throw typeErrorCreate('A configured TRUSTED_TYPES_POLICY callback (createHTML or createScriptURL) must not call DOMPurify.sanitize, as that causes infinite recursion. Do not pass a policy whose callbacks wrap DOMPurify as TRUSTED_TYPES_POLICY; see the "DOMPurify and Trusted Types" section of the README.');
  };
  const _createTrustedHTML = function _createTrustedHTML(html) {
    _assertNotInTrustedTypesPolicy();
    IN_TRUSTED_TYPES_POLICY++;
    try {
      return trustedTypesPolicy.createHTML(html);
    } finally {
      IN_TRUSTED_TYPES_POLICY--;
    }
  };
  const _createTrustedScriptURL = function _createTrustedScriptURL(scriptUrl) {
    _assertNotInTrustedTypesPolicy();
    IN_TRUSTED_TYPES_POLICY++;
    try {
      return trustedTypesPolicy.createScriptURL(scriptUrl);
    } finally {
      IN_TRUSTED_TYPES_POLICY--;
    }
  };
  const _getDefaultTrustedTypesPolicy = function _getDefaultTrustedTypesPolicy() {
    if (!defaultTrustedTypesPolicyResolved) {
      defaultTrustedTypesPolicy = _createTrustedTypesPolicy(trustedTypes, currentScript);
      defaultTrustedTypesPolicyResolved = true;
    }
    return defaultTrustedTypesPolicy;
  };
  const _document = document2, { implementation, createNodeIterator, createDocumentFragment, getElementsByTagName } = _document;
  const importNode = originalDocument.importNode;
  let hooks = _createHooksMap();
  DOMPurify.isSupported = typeof entries === "function" && typeof getParentNode === "function" && implementation && implementation.createHTMLDocument !== undefined;
  const MUSTACHE_EXPR$1 = MUSTACHE_EXPR, ERB_EXPR$1 = ERB_EXPR, TMPLIT_EXPR$1 = TMPLIT_EXPR, DATA_ATTR$1 = DATA_ATTR, ARIA_ATTR$1 = ARIA_ATTR, IS_SCRIPT_OR_DATA$1 = IS_SCRIPT_OR_DATA, ATTR_WHITESPACE$1 = ATTR_WHITESPACE, CUSTOM_ELEMENT$1 = CUSTOM_ELEMENT;
  let IS_ALLOWED_URI$1 = IS_ALLOWED_URI;
  let ALLOWED_TAGS = null;
  const DEFAULT_ALLOWED_TAGS = addToSet({}, [
    ...html$1,
    ...svg$1,
    ...svgFilters,
    ...mathMl$1,
    ...text
  ]);
  let ALLOWED_ATTR = null;
  const DEFAULT_ALLOWED_ATTR = addToSet({}, [
    ...html,
    ...svg,
    ...mathMl,
    ...xml
  ]);
  let CUSTOM_ELEMENT_HANDLING = Object.seal(create(null, {
    tagNameCheck: {
      writable: true,
      configurable: false,
      enumerable: true,
      value: null
    },
    attributeNameCheck: {
      writable: true,
      configurable: false,
      enumerable: true,
      value: null
    },
    allowCustomizedBuiltInElements: {
      writable: true,
      configurable: false,
      enumerable: true,
      value: false
    }
  }));
  let FORBID_TAGS = null;
  let FORBID_ATTR = null;
  const EXTRA_ELEMENT_HANDLING = Object.seal(create(null, {
    tagCheck: {
      writable: true,
      configurable: false,
      enumerable: true,
      value: null
    },
    attributeCheck: {
      writable: true,
      configurable: false,
      enumerable: true,
      value: null
    }
  }));
  let ALLOW_ARIA_ATTR = true;
  let ALLOW_DATA_ATTR = true;
  let ALLOW_UNKNOWN_PROTOCOLS = false;
  let ALLOW_SELF_CLOSE_IN_ATTR = true;
  let SAFE_FOR_TEMPLATES = false;
  let SAFE_FOR_XML = true;
  let WHOLE_DOCUMENT = false;
  let SET_CONFIG = false;
  let SET_CONFIG_ALLOWED_TAGS = null;
  let SET_CONFIG_ALLOWED_ATTR = null;
  let FORCE_BODY = false;
  let RETURN_DOM = false;
  let RETURN_DOM_FRAGMENT = false;
  let RETURN_TRUSTED_TYPE = false;
  let SANITIZE_DOM = true;
  let SANITIZE_NAMED_PROPS = false;
  const SANITIZE_NAMED_PROPS_PREFIX = "user-content-";
  let KEEP_CONTENT = true;
  let IN_PLACE = false;
  let IN_PLACE_VISITED = null;
  let USE_PROFILES = {};
  let FORBID_CONTENTS = null;
  const DEFAULT_FORBID_CONTENTS = addToSet({}, [
    "annotation-xml",
    "audio",
    "colgroup",
    "desc",
    "foreignobject",
    "head",
    "iframe",
    "math",
    "mi",
    "mn",
    "mo",
    "ms",
    "mtext",
    "noembed",
    "noframes",
    "noscript",
    "plaintext",
    "script",
    "selectedcontent",
    "style",
    "svg",
    "template",
    "thead",
    "title",
    "video",
    "xmp"
  ]);
  let DATA_URI_TAGS = null;
  const DEFAULT_DATA_URI_TAGS = addToSet({}, [
    "audio",
    "video",
    "img",
    "source",
    "image",
    "track"
  ]);
  let URI_SAFE_ATTRIBUTES = null;
  const DEFAULT_URI_SAFE_ATTRIBUTES = addToSet({}, [
    "alt",
    "class",
    "for",
    "id",
    "label",
    "name",
    "pattern",
    "placeholder",
    "role",
    "summary",
    "title",
    "value",
    "style",
    "xmlns"
  ]);
  const MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML";
  const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
  const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
  let NAMESPACE = HTML_NAMESPACE;
  let IS_EMPTY_INPUT = false;
  let ALLOWED_NAMESPACES = null;
  const DEFAULT_ALLOWED_NAMESPACES = addToSet({}, [
    MATHML_NAMESPACE,
    SVG_NAMESPACE,
    HTML_NAMESPACE
  ], stringToString);
  const DEFAULT_MATHML_TEXT_INTEGRATION_POINTS = freeze([
    "mi",
    "mo",
    "mn",
    "ms",
    "mtext"
  ]);
  let MATHML_TEXT_INTEGRATION_POINTS = addToSet({}, DEFAULT_MATHML_TEXT_INTEGRATION_POINTS);
  const DEFAULT_HTML_INTEGRATION_POINTS = freeze(["annotation-xml"]);
  let HTML_INTEGRATION_POINTS = addToSet({}, DEFAULT_HTML_INTEGRATION_POINTS);
  const COMMON_SVG_AND_HTML_ELEMENTS = addToSet({}, [
    "title",
    "style",
    "font",
    "a",
    "script"
  ]);
  let PARSER_MEDIA_TYPE = null;
  const SUPPORTED_PARSER_MEDIA_TYPES = ["application/xhtml+xml", "text/html"];
  const DEFAULT_PARSER_MEDIA_TYPE = "text/html";
  let transformCaseFunc = null;
  let CONFIG = null;
  const formElement = document2.createElement("form");
  const isRegexOrFunction = function isRegexOrFunction(testValue) {
    return testValue instanceof RegExp || testValue instanceof Function;
  };
  const _parseConfig = function _parseConfig() {
    let cfg = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};
    if (CONFIG && CONFIG === cfg)
      return;
    if (!cfg || typeof cfg !== "object")
      cfg = {};
    cfg = clone(cfg);
    PARSER_MEDIA_TYPE = SUPPORTED_PARSER_MEDIA_TYPES.indexOf(cfg.PARSER_MEDIA_TYPE) === -1 ? DEFAULT_PARSER_MEDIA_TYPE : cfg.PARSER_MEDIA_TYPE;
    transformCaseFunc = PARSER_MEDIA_TYPE === "application/xhtml+xml" ? stringToString : stringToLowerCase;
    ALLOWED_TAGS = _resolveSetOption(cfg, "ALLOWED_TAGS", DEFAULT_ALLOWED_TAGS, { transform: transformCaseFunc });
    ALLOWED_ATTR = _resolveSetOption(cfg, "ALLOWED_ATTR", DEFAULT_ALLOWED_ATTR, { transform: transformCaseFunc });
    ALLOWED_NAMESPACES = _resolveSetOption(cfg, "ALLOWED_NAMESPACES", DEFAULT_ALLOWED_NAMESPACES, { transform: stringToString });
    URI_SAFE_ATTRIBUTES = _resolveSetOption(cfg, "ADD_URI_SAFE_ATTR", DEFAULT_URI_SAFE_ATTRIBUTES, {
      transform: transformCaseFunc,
      base: DEFAULT_URI_SAFE_ATTRIBUTES
    });
    DATA_URI_TAGS = _resolveSetOption(cfg, "ADD_DATA_URI_TAGS", DEFAULT_DATA_URI_TAGS, {
      transform: transformCaseFunc,
      base: DEFAULT_DATA_URI_TAGS
    });
    FORBID_CONTENTS = _resolveSetOption(cfg, "FORBID_CONTENTS", DEFAULT_FORBID_CONTENTS, { transform: transformCaseFunc });
    FORBID_TAGS = _resolveSetOption(cfg, "FORBID_TAGS", clone({}), { transform: transformCaseFunc });
    FORBID_ATTR = _resolveSetOption(cfg, "FORBID_ATTR", clone({}), { transform: transformCaseFunc });
    USE_PROFILES = objectHasOwnProperty(cfg, "USE_PROFILES") ? cfg.USE_PROFILES && typeof cfg.USE_PROFILES === "object" ? clone(cfg.USE_PROFILES) : cfg.USE_PROFILES : false;
    ALLOW_ARIA_ATTR = cfg.ALLOW_ARIA_ATTR !== false;
    ALLOW_DATA_ATTR = cfg.ALLOW_DATA_ATTR !== false;
    ALLOW_UNKNOWN_PROTOCOLS = cfg.ALLOW_UNKNOWN_PROTOCOLS || false;
    ALLOW_SELF_CLOSE_IN_ATTR = cfg.ALLOW_SELF_CLOSE_IN_ATTR !== false;
    SAFE_FOR_TEMPLATES = cfg.SAFE_FOR_TEMPLATES || false;
    SAFE_FOR_XML = cfg.SAFE_FOR_XML !== false;
    WHOLE_DOCUMENT = cfg.WHOLE_DOCUMENT || false;
    RETURN_DOM = cfg.RETURN_DOM || false;
    RETURN_DOM_FRAGMENT = cfg.RETURN_DOM_FRAGMENT || false;
    RETURN_TRUSTED_TYPE = cfg.RETURN_TRUSTED_TYPE || false;
    FORCE_BODY = cfg.FORCE_BODY || false;
    SANITIZE_DOM = cfg.SANITIZE_DOM !== false;
    SANITIZE_NAMED_PROPS = cfg.SANITIZE_NAMED_PROPS || false;
    KEEP_CONTENT = cfg.KEEP_CONTENT !== false;
    IN_PLACE = cfg.IN_PLACE || false;
    IS_ALLOWED_URI$1 = isRegex(cfg.ALLOWED_URI_REGEXP) ? cfg.ALLOWED_URI_REGEXP : IS_ALLOWED_URI;
    NAMESPACE = typeof cfg.NAMESPACE === "string" ? cfg.NAMESPACE : HTML_NAMESPACE;
    MATHML_TEXT_INTEGRATION_POINTS = _resolveObjectOption(cfg, "MATHML_TEXT_INTEGRATION_POINTS", () => addToSet({}, DEFAULT_MATHML_TEXT_INTEGRATION_POINTS));
    HTML_INTEGRATION_POINTS = _resolveObjectOption(cfg, "HTML_INTEGRATION_POINTS", () => addToSet({}, DEFAULT_HTML_INTEGRATION_POINTS));
    const customElementHandling = _resolveObjectOption(cfg, "CUSTOM_ELEMENT_HANDLING", () => create(null));
    CUSTOM_ELEMENT_HANDLING = create(null);
    if (objectHasOwnProperty(customElementHandling, "tagNameCheck") && isRegexOrFunction(customElementHandling.tagNameCheck))
      CUSTOM_ELEMENT_HANDLING.tagNameCheck = customElementHandling.tagNameCheck;
    if (objectHasOwnProperty(customElementHandling, "attributeNameCheck") && isRegexOrFunction(customElementHandling.attributeNameCheck))
      CUSTOM_ELEMENT_HANDLING.attributeNameCheck = customElementHandling.attributeNameCheck;
    if (objectHasOwnProperty(customElementHandling, "allowCustomizedBuiltInElements") && typeof customElementHandling.allowCustomizedBuiltInElements === "boolean")
      CUSTOM_ELEMENT_HANDLING.allowCustomizedBuiltInElements = customElementHandling.allowCustomizedBuiltInElements;
    seal(CUSTOM_ELEMENT_HANDLING);
    if (SAFE_FOR_TEMPLATES)
      ALLOW_DATA_ATTR = false;
    if (RETURN_DOM_FRAGMENT)
      RETURN_DOM = true;
    if (USE_PROFILES) {
      ALLOWED_TAGS = addToSet({}, text);
      ALLOWED_ATTR = create(null);
      if (USE_PROFILES.html === true) {
        addToSet(ALLOWED_TAGS, html$1);
        addToSet(ALLOWED_ATTR, html);
      }
      if (USE_PROFILES.svg === true) {
        addToSet(ALLOWED_TAGS, svg$1);
        addToSet(ALLOWED_ATTR, svg);
        addToSet(ALLOWED_ATTR, xml);
      }
      if (USE_PROFILES.svgFilters === true) {
        addToSet(ALLOWED_TAGS, svgFilters);
        addToSet(ALLOWED_ATTR, svg);
        addToSet(ALLOWED_ATTR, xml);
      }
      if (USE_PROFILES.mathMl === true) {
        addToSet(ALLOWED_TAGS, mathMl$1);
        addToSet(ALLOWED_ATTR, mathMl);
        addToSet(ALLOWED_ATTR, xml);
      }
    }
    EXTRA_ELEMENT_HANDLING.tagCheck = null;
    EXTRA_ELEMENT_HANDLING.attributeCheck = null;
    if (objectHasOwnProperty(cfg, "ADD_TAGS")) {
      if (typeof cfg.ADD_TAGS === "function")
        EXTRA_ELEMENT_HANDLING.tagCheck = cfg.ADD_TAGS;
      else if (arrayIsArray(cfg.ADD_TAGS)) {
        if (ALLOWED_TAGS === DEFAULT_ALLOWED_TAGS)
          ALLOWED_TAGS = clone(ALLOWED_TAGS);
        addToSet(ALLOWED_TAGS, cfg.ADD_TAGS, transformCaseFunc);
      }
    }
    if (objectHasOwnProperty(cfg, "ADD_ATTR")) {
      if (typeof cfg.ADD_ATTR === "function")
        EXTRA_ELEMENT_HANDLING.attributeCheck = cfg.ADD_ATTR;
      else if (arrayIsArray(cfg.ADD_ATTR)) {
        if (ALLOWED_ATTR === DEFAULT_ALLOWED_ATTR)
          ALLOWED_ATTR = clone(ALLOWED_ATTR);
        addToSet(ALLOWED_ATTR, cfg.ADD_ATTR, transformCaseFunc);
      }
    }
    if (objectHasOwnProperty(cfg, "ADD_FORBID_CONTENTS") && arrayIsArray(cfg.ADD_FORBID_CONTENTS)) {
      if (FORBID_CONTENTS === DEFAULT_FORBID_CONTENTS)
        FORBID_CONTENTS = clone(FORBID_CONTENTS);
      addToSet(FORBID_CONTENTS, cfg.ADD_FORBID_CONTENTS, transformCaseFunc);
    }
    if (KEEP_CONTENT)
      ALLOWED_TAGS["#text"] = true;
    if (WHOLE_DOCUMENT)
      addToSet(ALLOWED_TAGS, [
        "html",
        "head",
        "body"
      ]);
    if (ALLOWED_TAGS.table) {
      addToSet(ALLOWED_TAGS, ["tbody"]);
      delete FORBID_TAGS.tbody;
    }
    if (cfg.TRUSTED_TYPES_POLICY) {
      if (typeof cfg.TRUSTED_TYPES_POLICY.createHTML !== "function")
        throw typeErrorCreate('TRUSTED_TYPES_POLICY configuration option must provide a "createHTML" hook.');
      if (typeof cfg.TRUSTED_TYPES_POLICY.createScriptURL !== "function")
        throw typeErrorCreate('TRUSTED_TYPES_POLICY configuration option must provide a "createScriptURL" hook.');
      const previousTrustedTypesPolicy = trustedTypesPolicy;
      trustedTypesPolicy = cfg.TRUSTED_TYPES_POLICY;
      try {
        emptyHTML = _createTrustedHTML("");
      } catch (error) {
        trustedTypesPolicy = previousTrustedTypesPolicy;
        throw error;
      }
    } else if (cfg.TRUSTED_TYPES_POLICY === null) {
      trustedTypesPolicy = undefined;
      emptyHTML = "";
    } else {
      if (trustedTypesPolicy === undefined)
        trustedTypesPolicy = _getDefaultTrustedTypesPolicy();
      if (trustedTypesPolicy && typeof emptyHTML === "string")
        emptyHTML = _createTrustedHTML("");
    }
    if (freeze)
      freeze(cfg);
    CONFIG = cfg;
  };
  const ALL_SVG_TAGS = addToSet({}, [
    ...svg$1,
    ...svgFilters,
    ...svgDisallowed
  ]);
  const ALL_MATHML_TAGS = addToSet({}, [...mathMl$1, ...mathMlDisallowed]);
  const _checkSvgNamespace = function _checkSvgNamespace(tagName, parent, parentTagName) {
    if (parent.namespaceURI === HTML_NAMESPACE)
      return tagName === "svg";
    if (parent.namespaceURI === MATHML_NAMESPACE)
      return tagName === "svg" && (parentTagName === "annotation-xml" || MATHML_TEXT_INTEGRATION_POINTS[parentTagName]);
    return Boolean(ALL_SVG_TAGS[tagName]);
  };
  const _checkMathMlNamespace = function _checkMathMlNamespace(tagName, parent, parentTagName) {
    if (parent.namespaceURI === HTML_NAMESPACE)
      return tagName === "math";
    if (parent.namespaceURI === SVG_NAMESPACE)
      return tagName === "math" && HTML_INTEGRATION_POINTS[parentTagName];
    return Boolean(ALL_MATHML_TAGS[tagName]);
  };
  const _checkHtmlNamespace = function _checkHtmlNamespace(tagName, parent, parentTagName) {
    if (parent.namespaceURI === SVG_NAMESPACE && !HTML_INTEGRATION_POINTS[parentTagName])
      return false;
    if (parent.namespaceURI === MATHML_NAMESPACE && !MATHML_TEXT_INTEGRATION_POINTS[parentTagName])
      return false;
    return !ALL_MATHML_TAGS[tagName] && (COMMON_SVG_AND_HTML_ELEMENTS[tagName] || !ALL_SVG_TAGS[tagName]);
  };
  const _checkValidNamespace = function _checkValidNamespace(element) {
    const elementNamespace = _readNamespaceURI(element);
    const tagName = stringToLowerCase(_readNodeName(element));
    const parentNode = getParentNode(element);
    let parent;
    let parentTagName;
    if (parentNode && _readNodeType(parentNode) === NODE_TYPE.element) {
      parent = { namespaceURI: _readNamespaceURI(parentNode) };
      parentTagName = stringToLowerCase(_readNodeName(parentNode));
    } else {
      parent = { namespaceURI: NAMESPACE };
      parentTagName = "template";
    }
    if (!ALLOWED_NAMESPACES[elementNamespace])
      return false;
    if (elementNamespace === SVG_NAMESPACE)
      return _checkSvgNamespace(tagName, parent, parentTagName);
    if (elementNamespace === MATHML_NAMESPACE)
      return _checkMathMlNamespace(tagName, parent, parentTagName);
    if (elementNamespace === HTML_NAMESPACE)
      return _checkHtmlNamespace(tagName, parent, parentTagName);
    if (PARSER_MEDIA_TYPE === "application/xhtml+xml" && ALLOWED_NAMESPACES[elementNamespace])
      return true;
    return false;
  };
  const _forceRemove = function _forceRemove(node) {
    arrayPush(DOMPurify.removed, { element: node });
    try {
      getParentNode(node).removeChild(node);
    } catch (_) {
      remove(node);
      if (!getParentNode(node))
        throw typeErrorCreate("a node selected for removal could not be detached from its tree and cannot be safely returned; refusing to sanitize in place");
    }
  };
  const _stripAttributeNode = function _stripAttributeNode(element, attribute, name) {
    try {
      removeAttributeNode(element, attribute);
    } catch (_) {
      try {
        element.removeAttribute(name);
      } catch (_) {}
    }
  };
  const _neutralizeRoot = function _neutralizeRoot(root) {
    _neutralizeSubtree(root);
    const childNodes = getChildNodes(root);
    if (childNodes)
      arrayForEach(arraySlice(childNodes), (child) => {
        try {
          remove(child);
        } catch (_) {}
      });
    const attributes = _readNodeType(root) === NODE_TYPE.element ? getAttributes(root) : null;
    if (attributes)
      for (let i = attributes.length - 1;i >= 0; --i) {
        const attribute = attributes[i];
        const name = attribute && attribute.name;
        if (typeof name === "string")
          _stripAttributeNode(root, attribute, name);
      }
  };
  const _removeAttribute = function _removeAttribute(name, element, attr) {
    if (!attr)
      try {
        attr = element.getAttributeNode(name);
      } catch (_) {
        attr = null;
      }
    arrayPush(DOMPurify.removed, {
      attribute: attr || null,
      from: element
    });
    try {
      if (attr)
        removeAttributeNode(element, attr);
      else
        element.removeAttribute(name);
    } catch (_) {
      try {
        element.removeAttribute(name);
      } catch (_) {}
    }
    if (name === "is") {
      if (RETURN_DOM || RETURN_DOM_FRAGMENT)
        try {
          _forceRemove(element);
        } catch (_) {}
      else
        try {
          element.setAttribute(name, "");
        } catch (_) {}
    }
  };
  const _stripDisallowedAttributes = function _stripDisallowedAttributes(element) {
    const attributes = getAttributes(element);
    if (!attributes)
      return;
    for (let i = attributes.length - 1;i >= 0; --i) {
      const attribute = attributes[i];
      const name = attribute && attribute.name;
      if (typeof name !== "string" || ALLOWED_ATTR[transformCaseFunc(name)])
        continue;
      _stripAttributeNode(element, attribute, name);
    }
  };
  const _walkTree = function _walkTree(root, visit) {
    let intoShadow = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : false;
    const stack = [root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (visit(node) === false)
        continue;
      if (intoShadow && _readNodeType(node) === NODE_TYPE.element) {
        const shadowRoot = getShadowRoot(node);
        if (_isDocumentFragment(shadowRoot))
          stack.push(shadowRoot);
      }
      const childNodes = getChildNodes(node);
      if (childNodes)
        for (let i = childNodes.length - 1;i >= 0; --i)
          stack.push(childNodes[i]);
    }
  };
  const _neutralizeSubtree = function _neutralizeSubtree(root) {
    _walkTree(root, (node) => {
      if (_readNodeType(node) === NODE_TYPE.element)
        _stripDisallowedAttributes(node);
    });
  };
  const _collectLiveNodes = function _collectLiveNodes(root) {
    const nodes = [];
    _walkTree(root, (node) => {
      nodes.push(node);
    }, true);
    return nodes;
  };
  const _neutralizeEscapedElements = function _neutralizeEscapedElements(root, before) {
    const reachable = setCreate();
    arrayForEach(_collectLiveNodes(root), (node) => {
      if (_readNodeType(node) === NODE_TYPE.element)
        setAdd(reachable, node);
    });
    arrayForEach(before, (node) => {
      if (_readNodeType(node) === NODE_TYPE.element && !setHas(reachable, node))
        _stripDisallowedAttributes(node);
    });
  };
  const _neutralizeDiscarded = function _neutralizeDiscarded(root, before) {
    let rootRemoved = false;
    arrayForEach(DOMPurify.removed, (entry) => {
      if (entry.element) {
        rootRemoved = rootRemoved || entry.element === root;
        _neutralizeSubtree(entry.element);
      }
    });
    _neutralizeEscapedElements(root, before);
    return rootRemoved;
  };
  const MAX_UNVISITED_ROUNDS = 8;
  const _sanitizeUnvisitedNodes = function _sanitizeUnvisitedNodes(root, before) {
    const visited = IN_PLACE_VISITED;
    let original = null;
    const getOriginal = () => {
      if (!original) {
        original = setCreate();
        arrayForEach(before, (beforeNode) => {
          setAdd(original, beforeNode);
        });
      }
      return original;
    };
    for (let round = 0;; round++) {
      const live = _collectLiveNodes(root);
      const containers = [root];
      let pending = false;
      arrayForEach(live, (node) => {
        if (_readNodeType(node) === NODE_TYPE.documentFragment)
          arrayPush(containers, node);
        else if (!pending && !setHas(visited, node))
          pending = setHas(getOriginal(), node);
      });
      if (!pending)
        return;
      if (round >= MAX_UNVISITED_ROUNDS)
        throw typeErrorCreate("the tree kept changing during in-place sanitization; refusing to return it");
      arrayForEach(containers, (container, index) => {
        _sanitizeUnvisitedIn(container, index > 0, root, getOriginal());
      });
    }
  };
  const _sanitizeUnvisitedIn = function _sanitizeUnvisitedIn(container, inShadow, root, original) {
    const iterator = _createNodeIterator(container);
    let node;
    while (node = iterator.nextNode()) {
      if (!setHas(original, node) || setHas(IN_PLACE_VISITED, node))
        continue;
      if (inShadow)
        _executeHooks(hooks.uponSanitizeShadowNode, node, null);
      _sanitizeElements(node, root);
      _sanitizeAttributes(node, root);
      if (_isDocumentFragment(node.content))
        _sanitizeShadowDOM2(node.content);
    }
  };
  const _markVisited = function _markVisited(node) {
    if (IN_PLACE_VISITED)
      setAdd(IN_PLACE_VISITED, node);
  };
  const _isPatchLinkageAttribute = function _isPatchLinkageAttribute(lcName, lcTag) {
    if (!SAFE_FOR_XML)
      return false;
    if (lcName === "patchsrc")
      return true;
    return lcName === "for" && lcTag !== "label" && lcTag !== "output";
  };
  const _neutralizePatchLinkage = function _neutralizePatchLinkage(root) {
    if (!SAFE_FOR_XML)
      return;
    _walkTree(root, (node) => {
      const nodeType = _readNodeType(node);
      if (nodeType === NODE_TYPE.processingInstruction || nodeType === NODE_TYPE.comment && regExpTest(COMMENT_MARKUP_PROBE, node.data)) {
        try {
          remove(node);
        } catch (_) {}
        return false;
      }
      if (nodeType === NODE_TYPE.element) {
        const element = node;
        const lcTag = transformCaseFunc(_readNodeName(node));
        try {
          if (element.hasAttribute && element.hasAttribute("patchsrc"))
            element.removeAttribute("patchsrc");
          if (element.hasAttribute && element.hasAttribute("for") && _isPatchLinkageAttribute("for", lcTag))
            element.removeAttribute("for");
        } catch (_) {}
      }
      return true;
    });
  };
  const _initDocument = function _initDocument(dirty) {
    let doc = null;
    let leadingWhitespace = null;
    if (FORCE_BODY)
      dirty = "<remove></remove>" + dirty;
    else {
      const matches = stringMatch(dirty, /^[\r\n\t ]+/);
      leadingWhitespace = matches && matches[0];
    }
    if (PARSER_MEDIA_TYPE === "application/xhtml+xml" && NAMESPACE === HTML_NAMESPACE)
      dirty = '<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body>' + dirty + "</body></html>";
    const dirtyPayload = trustedTypesPolicy ? _createTrustedHTML(dirty) : dirty;
    if (NAMESPACE === HTML_NAMESPACE)
      try {
        doc = new DOMParser().parseFromString(dirtyPayload, PARSER_MEDIA_TYPE);
      } catch (_) {}
    if (!doc || !doc.documentElement) {
      doc = implementation.createDocument(NAMESPACE, "template", null);
      try {
        doc.documentElement.innerHTML = IS_EMPTY_INPUT ? emptyHTML : dirtyPayload;
      } catch (_) {}
    }
    const body = doc.body || doc.documentElement;
    if (dirty && leadingWhitespace)
      body.insertBefore(document2.createTextNode(leadingWhitespace), body.childNodes[0] || null);
    if (NAMESPACE === HTML_NAMESPACE)
      return getElementsByTagName.call(doc, WHOLE_DOCUMENT ? "html" : "body")[0];
    return WHOLE_DOCUMENT ? doc.documentElement : body;
  };
  const _createNodeIterator = function _createNodeIterator(root) {
    const doc = getOwnerDocument ? getOwnerDocument(root) : root.ownerDocument;
    return createNodeIterator.call(doc || root, root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_TEXT | NodeFilter.SHOW_PROCESSING_INSTRUCTION | NodeFilter.SHOW_CDATA_SECTION, null);
  };
  const _stripTemplateExpressions = function _stripTemplateExpressions(value) {
    value = stringReplace(value, MUSTACHE_EXPR$1, " ");
    value = stringReplace(value, ERB_EXPR$1, " ");
    value = stringReplace(value, TMPLIT_EXPR$1, " ");
    return value;
  };
  const _scrubTemplateExpressions2 = function _scrubTemplateExpressions(node) {
    var _node$querySelectorAl;
    _scrubOwnCharacterData(node);
    const templates = (_node$querySelectorAl = node.querySelectorAll) === null || _node$querySelectorAl === undefined ? undefined : _node$querySelectorAl.call(node, "template");
    if (templates)
      arrayForEach(templates, (tmpl) => {
        if (_isDocumentFragment(tmpl.content))
          _scrubTemplateExpressions2(tmpl.content);
      });
  };
  const _scrubOwnCharacterData = function _scrubOwnCharacterData(node) {
    node.normalize();
    const doc = getOwnerDocument ? getOwnerDocument(node) : node.ownerDocument;
    const walker = createNodeIterator.call(doc || node, node, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_CDATA_SECTION | NodeFilter.SHOW_PROCESSING_INSTRUCTION, null);
    let currentNode = walker.nextNode();
    while (currentNode) {
      currentNode.data = _stripTemplateExpressions(currentNode.data);
      currentNode = walker.nextNode();
    }
  };
  const _isClobbered = function _isClobbered(element) {
    const realTagName = getNodeName ? getNodeName(element) : null;
    if (typeof realTagName !== "string")
      return false;
    if (transformCaseFunc(realTagName) !== "form")
      return false;
    return typeof element.nodeName !== "string" || typeof element.textContent !== "string" || typeof element.removeChild !== "function" || element.attributes !== getAttributes(element) || typeof element.removeAttribute !== "function" || typeof element.removeAttributeNode !== "function" || typeof element.getAttributeNode !== "function" || typeof element.setAttribute !== "function" || typeof element.namespaceURI !== "string" || typeof element.insertBefore !== "function" || typeof element.hasChildNodes !== "function" || element.nodeType !== getNodeType(element) || element.childNodes !== getChildNodes(element);
  };
  const _isDocumentFragment = function _isDocumentFragment(value) {
    if (!getNodeType || typeof value !== "object" || value === null)
      return false;
    try {
      return getNodeType(value) === NODE_TYPE.documentFragment;
    } catch (_) {
      return false;
    }
  };
  const _isNode = function _isNode(value) {
    if (!getNodeType || typeof value !== "object" || value === null)
      return false;
    try {
      return typeof getNodeType(value) === "number";
    } catch (_) {
      return false;
    }
  };
  function _executeHooks(hooks, currentNode, data) {
    if (hooks.length === 0)
      return;
    arrayForEach(hooks, (hook) => {
      hook.call(DOMPurify, currentNode, data, CONFIG);
    });
  }
  const _isUnsafeNode = function _isUnsafeNode(currentNode, tagName) {
    if (SAFE_FOR_XML && currentNode.hasChildNodes() && !_isNode(currentNode.firstElementChild) && regExpTest(ELEMENT_MARKUP_PROBE, currentNode.textContent) && regExpTest(ELEMENT_MARKUP_PROBE, currentNode.innerHTML))
      return true;
    if (SAFE_FOR_XML && LITERAL_TEXT_ELEMENTS[tagName] && _readNodeType(currentNode) === NODE_TYPE.element && _readNamespaceURI(currentNode) === HTML_NAMESPACE && (_isNode(currentNode.firstElementChild) || typeof currentNode.textContent === "string" && regExpTest(ELEMENT_MARKUP_PROBE, currentNode.textContent)))
      return true;
    if (currentNode.nodeType === NODE_TYPE.processingInstruction)
      return true;
    if (SAFE_FOR_XML && currentNode.nodeType === NODE_TYPE.comment && regExpTest(COMMENT_MARKUP_PROBE, currentNode.data))
      return true;
    return false;
  };
  const _matchesNameCheck = function _matchesNameCheck(check, name) {
    if (check instanceof RegExp)
      return regExpTest(check, name);
    if (check instanceof Function) {
      for (var _len = arguments.length, args = new Array(_len > 2 ? _len - 2 : 0), _key = 2;_key < _len; _key++)
        args[_key - 2] = arguments[_key];
      return Boolean(check(name, ...args));
    }
    return false;
  };
  const _sanitizeDisallowedNode = function _sanitizeDisallowedNode(currentNode, tagName, root) {
    if (!FORBID_TAGS[tagName] && _isBasicCustomElement(tagName) && _matchesNameCheck(CUSTOM_ELEMENT_HANDLING.tagNameCheck, tagName))
      return false;
    if (KEEP_CONTENT && !FORBID_CONTENTS[tagName] && !FORBID_CONTENTS[stringToLowerCase(tagName)]) {
      const parentNode = getParentNode(currentNode);
      const childNodes = getChildNodes(currentNode);
      if (childNodes && parentNode) {
        const childCount = childNodes.length;
        for (let i = childCount - 1;i >= 0; --i) {
          const hoisted = currentNode === root ? cloneNode(childNodes[i], true) : childNodes[i];
          parentNode.insertBefore(hoisted, getNextSibling(currentNode));
        }
      }
    }
    _forceRemove(currentNode);
    return true;
  };
  const _forkSharedAllowlist = function _forkSharedAllowlist(hookList, set, defaultSet, setConfigSet) {
    if (hookList.length === 0)
      return set;
    return set === defaultSet || set === setConfigSet ? clone(set) : set;
  };
  const _handleHookDetachedNode = function _handleHookDetachedNode(currentNode, root) {
    if (currentNode === root || getParentNode(currentNode) !== null)
      return false;
    if (IN_PLACE)
      _neutralizeSubtree(currentNode);
    return true;
  };
  const _sanitizeElements = function _sanitizeElements(currentNode, root) {
    _markVisited(currentNode);
    _executeHooks(hooks.beforeSanitizeElements, currentNode, null);
    if (_handleHookDetachedNode(currentNode, root))
      return true;
    if (_isClobbered(currentNode)) {
      _forceRemove(currentNode);
      return true;
    }
    const tagName = transformCaseFunc(_readNodeName(currentNode));
    ALLOWED_TAGS = _forkSharedAllowlist(hooks.uponSanitizeElement, ALLOWED_TAGS, DEFAULT_ALLOWED_TAGS, SET_CONFIG_ALLOWED_TAGS);
    _executeHooks(hooks.uponSanitizeElement, currentNode, {
      tagName,
      allowedTags: ALLOWED_TAGS
    });
    if (_handleHookDetachedNode(currentNode, root))
      return true;
    if (_isUnsafeNode(currentNode, tagName)) {
      _forceRemove(currentNode);
      return true;
    }
    if (FORBID_TAGS[tagName] || !(EXTRA_ELEMENT_HANDLING.tagCheck instanceof Function && EXTRA_ELEMENT_HANDLING.tagCheck(tagName)) && !ALLOWED_TAGS[tagName]) {
      const removed = _sanitizeDisallowedNode(currentNode, tagName, root);
      if (removed === false) {
        _executeHooks(hooks.afterSanitizeElements, currentNode, null);
        if (_handleHookDetachedNode(currentNode, root))
          return true;
      }
      return removed;
    }
    if (_readNodeType(currentNode) === NODE_TYPE.element && !_checkValidNamespace(currentNode)) {
      _forceRemove(currentNode);
      return true;
    }
    if ((tagName === "noscript" || tagName === "noembed" || tagName === "noframes") && regExpTest(FALLBACK_TAG_CLOSE, currentNode.innerHTML)) {
      _forceRemove(currentNode);
      return true;
    }
    if (SAFE_FOR_TEMPLATES && currentNode.nodeType === NODE_TYPE.text) {
      const content = _stripTemplateExpressions(currentNode.textContent);
      if (currentNode.textContent !== content) {
        arrayPush(DOMPurify.removed, { element: currentNode.cloneNode() });
        currentNode.textContent = content;
      }
    }
    _executeHooks(hooks.afterSanitizeElements, currentNode, null);
    return _handleHookDetachedNode(currentNode, root);
  };
  const _isValidAttribute = function _isValidAttribute(lcTag, lcName, value) {
    if (FORBID_ATTR[lcName])
      return false;
    if (_isPatchLinkageAttribute(lcName, lcTag))
      return false;
    if (SANITIZE_DOM && (lcName === "id" || lcName === "name") && ((value in document2) || (value in formElement)))
      return false;
    const nameIsPermitted = ALLOWED_ATTR[lcName] || EXTRA_ELEMENT_HANDLING.attributeCheck instanceof Function && EXTRA_ELEMENT_HANDLING.attributeCheck(lcName, lcTag);
    if (ALLOW_DATA_ATTR && regExpTest(DATA_ATTR$1, lcName))
      return true;
    if (ALLOW_ARIA_ATTR && regExpTest(ARIA_ATTR$1, lcName))
      return true;
    if (!nameIsPermitted)
      return _isBasicCustomElement(lcTag) && _matchesNameCheck(CUSTOM_ELEMENT_HANDLING.tagNameCheck, lcTag) && _matchesNameCheck(CUSTOM_ELEMENT_HANDLING.attributeNameCheck, lcName, lcTag) || lcName === "is" && CUSTOM_ELEMENT_HANDLING.allowCustomizedBuiltInElements && _matchesNameCheck(CUSTOM_ELEMENT_HANDLING.tagNameCheck, value);
    if (URI_SAFE_ATTRIBUTES[lcName])
      return true;
    if (regExpTest(IS_ALLOWED_URI$1, stringReplace(value, ATTR_WHITESPACE$1, "")))
      return true;
    if ((lcName === "src" || lcName === "xlink:href" || lcName === "href") && lcTag !== "script" && stringIndexOf(value, "data:") === 0 && DATA_URI_TAGS[lcTag])
      return true;
    if (ALLOW_UNKNOWN_PROTOCOLS && !regExpTest(IS_SCRIPT_OR_DATA$1, stringReplace(value, ATTR_WHITESPACE$1, "")))
      return true;
    return !value;
  };
  const RESERVED_CUSTOM_ELEMENT_NAMES = addToSet({}, [
    "annotation-xml",
    "color-profile",
    "font-face",
    "font-face-format",
    "font-face-name",
    "font-face-src",
    "font-face-uri",
    "missing-glyph"
  ]);
  const _isBasicCustomElement = function _isBasicCustomElement(tagName) {
    return !RESERVED_CUSTOM_ELEMENT_NAMES[stringToLowerCase(tagName)] && regExpTest(CUSTOM_ELEMENT$1, tagName);
  };
  const _applyTrustedTypesToAttribute = function _applyTrustedTypesToAttribute(lcTag, lcName, namespaceURI, value) {
    if (trustedTypesPolicy && typeof trustedTypes === "object" && typeof trustedTypes.getAttributeType === "function" && !namespaceURI)
      switch (trustedTypes.getAttributeType(lcTag, lcName)) {
        case "TrustedHTML":
          return _createTrustedHTML(value);
        case "TrustedScriptURL":
          return _createTrustedScriptURL(value);
      }
    return value;
  };
  const _setAttributeValue = function _setAttributeValue(currentNode, name, namespaceURI, value) {
    try {
      if (namespaceURI)
        currentNode.setAttributeNS(namespaceURI, name, value);
      else
        currentNode.setAttribute(name, value);
      if (_isClobbered(currentNode)) {
        _forceRemove(currentNode);
        return false;
      }
      return true;
    } catch (_) {
      _removeAttribute(name, currentNode);
      return false;
    }
  };
  const _isUnsafeAttributeValue = function _isUnsafeAttributeValue(name, value) {
    if (SAFE_FOR_XML && regExpTest(/((--!?|])>)|<\/(style|script|title|xmp|textarea|noscript|iframe|noembed|noframes)/i, value))
      return true;
    return stringToLowerCase(name) === "attributename" && stringMatch(value, "href") !== null;
  };
  const _sanitizeAttributes = function _sanitizeAttributes(currentNode, root) {
    _executeHooks(hooks.beforeSanitizeAttributes, currentNode, null);
    if (_handleHookDetachedNode(currentNode, root))
      return;
    const attributes = currentNode.attributes;
    if (!attributes || _isClobbered(currentNode))
      return;
    ALLOWED_ATTR = _forkSharedAllowlist(hooks.uponSanitizeAttribute, ALLOWED_ATTR, DEFAULT_ALLOWED_ATTR, SET_CONFIG_ALLOWED_ATTR);
    const hookEvent = {
      attrName: "",
      attrValue: "",
      keepAttr: true,
      allowedAttributes: ALLOWED_ATTR,
      forceKeepAttr: undefined
    };
    let l = attributes.length;
    const lcTag = transformCaseFunc(currentNode.nodeName);
    while (l--) {
      const attr = attributes[l];
      const { name, namespaceURI, value: attrValue } = attr;
      const lcName = transformCaseFunc(name);
      const initValue = attrValue;
      let value = name === "value" ? initValue : stringTrim(initValue);
      let recreatedNamedProp = false;
      hookEvent.attrName = lcName;
      hookEvent.attrValue = value;
      hookEvent.keepAttr = true;
      hookEvent.forceKeepAttr = undefined;
      _executeHooks(hooks.uponSanitizeAttribute, currentNode, hookEvent);
      value = hookEvent.attrValue;
      if (SANITIZE_NAMED_PROPS && (lcName === "id" || lcName === "name") && stringIndexOf(value, SANITIZE_NAMED_PROPS_PREFIX) !== 0) {
        _removeAttribute(name, currentNode, attr);
        value = SANITIZE_NAMED_PROPS_PREFIX + value;
        recreatedNamedProp = true;
      }
      if (_isUnsafeAttributeValue(name, value)) {
        _removeAttribute(name, currentNode, attr);
        continue;
      }
      if (hookEvent.forceKeepAttr)
        continue;
      if (!hookEvent.keepAttr) {
        _removeAttribute(name, currentNode, attr);
        continue;
      }
      if (!ALLOW_SELF_CLOSE_IN_ATTR && regExpTest(SELF_CLOSING_TAG, value)) {
        _removeAttribute(name, currentNode, attr);
        continue;
      }
      if (SAFE_FOR_TEMPLATES)
        value = _stripTemplateExpressions(value);
      if (!_isValidAttribute(lcTag, lcName, value)) {
        _removeAttribute(name, currentNode, attr);
        continue;
      }
      value = _applyTrustedTypesToAttribute(lcTag, lcName, namespaceURI, value);
      if (value !== initValue) {
        if (_setAttributeValue(currentNode, name, namespaceURI, value) && recreatedNamedProp)
          arrayPop(DOMPurify.removed);
      }
    }
    _executeHooks(hooks.afterSanitizeAttributes, currentNode, null);
    _handleHookDetachedNode(currentNode, root);
  };
  const _sanitizeShadowDOM2 = function _sanitizeShadowDOM(fragment) {
    let shadowNode = null;
    const shadowIterator = _createNodeIterator(fragment);
    _executeHooks(hooks.beforeSanitizeShadowDOM, fragment, null);
    while (shadowNode = shadowIterator.nextNode()) {
      _executeHooks(hooks.uponSanitizeShadowNode, shadowNode, null);
      _sanitizeElements(shadowNode, fragment);
      _sanitizeAttributes(shadowNode, fragment);
      if (_isDocumentFragment(shadowNode.content))
        _sanitizeShadowDOM2(shadowNode.content);
      if (_readNodeType(shadowNode) === NODE_TYPE.element) {
        const innerSr = getShadowRoot(shadowNode);
        if (_isDocumentFragment(innerSr)) {
          _sanitizeAttachedShadowRoots(innerSr);
          _sanitizeShadowDOM2(innerSr);
        }
      }
    }
    if (SAFE_FOR_TEMPLATES)
      _scrubOwnCharacterData(fragment);
    _executeHooks(hooks.afterSanitizeShadowDOM, fragment, null);
  };
  const _sanitizeAttachedShadowRoots = function _sanitizeAttachedShadowRoots(root) {
    const stack = [{
      node: root,
      shadow: null
    }];
    while (stack.length > 0) {
      const item = stack.pop();
      if (item.shadow) {
        _sanitizeShadowDOM2(item.shadow);
        continue;
      }
      const node = item.node;
      const isElement = _readNodeType(node) === NODE_TYPE.element;
      const childNodes = getChildNodes(node);
      if (childNodes)
        for (let i = childNodes.length - 1;i >= 0; --i)
          stack.push({
            node: childNodes[i],
            shadow: null
          });
      if (isElement) {
        const rootName = getNodeName ? getNodeName(node) : null;
        if (typeof rootName === "string" && transformCaseFunc(rootName) === "template") {
          const content = node.content;
          if (_isDocumentFragment(content))
            stack.push({
              node: content,
              shadow: null
            });
        }
      }
      if (isElement) {
        const sr = getShadowRoot(node);
        if (_isDocumentFragment(sr))
          stack.push({
            node: null,
            shadow: sr
          }, {
            node: sr,
            shadow: null
          });
      }
    }
  };
  DOMPurify.sanitize = function(dirty) {
    let cfg = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};
    let body = null;
    let importedNode = null;
    let currentNode = null;
    let returnNode = null;
    IS_EMPTY_INPUT = !dirty;
    if (IS_EMPTY_INPUT)
      dirty = "<!-->";
    if (typeof dirty !== "string" && !_isNode(dirty)) {
      dirty = stringifyValue(dirty);
      if (typeof dirty !== "string")
        throw typeErrorCreate("dirty is not a string, aborting");
    }
    if (!DOMPurify.isSupported)
      return dirty;
    if (SET_CONFIG) {
      ALLOWED_TAGS = SET_CONFIG_ALLOWED_TAGS;
      ALLOWED_ATTR = SET_CONFIG_ALLOWED_ATTR;
    } else
      _parseConfig(cfg);
    if (hooks.uponSanitizeElement.length > 0 || hooks.uponSanitizeAttribute.length > 0)
      ALLOWED_TAGS = clone(ALLOWED_TAGS);
    if (hooks.uponSanitizeAttribute.length > 0)
      ALLOWED_ATTR = clone(ALLOWED_ATTR);
    DOMPurify.removed = [];
    const inPlace = IN_PLACE && typeof dirty !== "string" && _isNode(dirty);
    let inPlaceNodes = [];
    const outerVisited = IN_PLACE_VISITED;
    if (inPlace) {
      _neutralizePatchLinkage(dirty);
      const nn = _readNodeName(dirty);
      if (typeof nn === "string") {
        const tagName = transformCaseFunc(nn);
        if (!ALLOWED_TAGS[tagName] || FORBID_TAGS[tagName]) {
          _neutralizeRoot(dirty);
          throw typeErrorCreate("root node is forbidden and cannot be sanitized in-place");
        }
      }
      if (_isClobbered(dirty)) {
        _neutralizeRoot(dirty);
        throw typeErrorCreate("root node is clobbered and cannot be sanitized in-place");
      }
      inPlaceNodes = _collectLiveNodes(dirty);
      IN_PLACE_VISITED = setCreate();
    } else if (_isNode(dirty)) {
      body = _initDocument("<!---->");
      importedNode = body.ownerDocument.importNode(dirty, true);
      if (importedNode.nodeType === NODE_TYPE.element && importedNode.nodeName === "BODY")
        body = importedNode;
      else if (importedNode.nodeName === "HTML")
        body = importedNode;
      else
        body.appendChild(importedNode);
      _sanitizeAttachedShadowRoots(body);
    } else {
      if (!RETURN_DOM && !SAFE_FOR_TEMPLATES && !WHOLE_DOCUMENT && dirty.indexOf("<") === -1)
        return trustedTypesPolicy && RETURN_TRUSTED_TYPE ? _createTrustedHTML(dirty) : dirty;
      body = _initDocument(dirty);
      if (!body)
        return RETURN_DOM ? null : RETURN_TRUSTED_TYPE ? emptyHTML : "";
    }
    if (body && FORCE_BODY)
      _forceRemove(body.firstChild);
    const walkRoot = inPlace ? dirty : body;
    try {
      if (inPlace)
        _sanitizeAttachedShadowRoots(dirty);
      const nodeIterator = _createNodeIterator(walkRoot);
      while (currentNode = nodeIterator.nextNode()) {
        _sanitizeElements(currentNode, walkRoot);
        _sanitizeAttributes(currentNode, walkRoot);
        if (_isDocumentFragment(currentNode.content))
          _sanitizeShadowDOM2(currentNode.content);
      }
      if (inPlace)
        _sanitizeUnvisitedNodes(dirty, inPlaceNodes);
    } catch (error) {
      if (inPlace) {
        _neutralizeRoot(dirty);
        _neutralizeDiscarded(dirty, inPlaceNodes);
      }
      throw error;
    } finally {
      IN_PLACE_VISITED = outerVisited;
    }
    if (inPlace) {
      if (_neutralizeDiscarded(dirty, inPlaceNodes))
        throw typeErrorCreate("a node selected for removal could not be safely returned; refusing to sanitize in place");
      if (SAFE_FOR_TEMPLATES)
        _scrubTemplateExpressions2(dirty);
      return dirty;
    }
    if (RETURN_DOM) {
      if (SAFE_FOR_TEMPLATES)
        _scrubTemplateExpressions2(body);
      if (RETURN_DOM_FRAGMENT) {
        returnNode = createDocumentFragment.call(body.ownerDocument);
        while (body.firstChild)
          returnNode.appendChild(body.firstChild);
      } else
        returnNode = body;
      if (ALLOWED_ATTR.shadowroot || ALLOWED_ATTR.shadowrootmode)
        returnNode = importNode.call(originalDocument, returnNode, true);
      return returnNode;
    }
    let serializedHTML = WHOLE_DOCUMENT ? body.outerHTML : body.innerHTML;
    if (WHOLE_DOCUMENT && ALLOWED_TAGS["!doctype"] && body.ownerDocument && body.ownerDocument.doctype && body.ownerDocument.doctype.name && regExpTest(DOCTYPE_NAME, body.ownerDocument.doctype.name))
      serializedHTML = "<!DOCTYPE " + body.ownerDocument.doctype.name + `>
` + serializedHTML;
    if (SAFE_FOR_TEMPLATES)
      serializedHTML = _stripTemplateExpressions(serializedHTML);
    return trustedTypesPolicy && RETURN_TRUSTED_TYPE ? _createTrustedHTML(serializedHTML) : serializedHTML;
  };
  DOMPurify.setConfig = function() {
    let cfg = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};
    _parseConfig(cfg);
    SET_CONFIG = true;
    SET_CONFIG_ALLOWED_TAGS = ALLOWED_TAGS;
    SET_CONFIG_ALLOWED_ATTR = ALLOWED_ATTR;
  };
  DOMPurify.clearConfig = function() {
    CONFIG = null;
    SET_CONFIG = false;
    SET_CONFIG_ALLOWED_TAGS = null;
    SET_CONFIG_ALLOWED_ATTR = null;
    trustedTypesPolicy = defaultTrustedTypesPolicy;
    emptyHTML = "";
  };
  DOMPurify.isValidAttribute = function(tag, attr, value) {
    if (!CONFIG)
      _parseConfig({});
    const lcTag = transformCaseFunc(tag);
    const lcName = transformCaseFunc(attr);
    if (typeof value === "string" && (_isUnsafeAttributeValue(attr, value) || !ALLOW_SELF_CLOSE_IN_ATTR && regExpTest(SELF_CLOSING_TAG, value)))
      return false;
    return _isValidAttribute(lcTag, lcName, value);
  };
  DOMPurify.addHook = function(entryPoint, hookFunction) {
    if (typeof hookFunction !== "function")
      return;
    if (!objectHasOwnProperty(hooks, entryPoint))
      return;
    arrayPush(hooks[entryPoint], hookFunction);
  };
  DOMPurify.removeHook = function(entryPoint, hookFunction) {
    if (!objectHasOwnProperty(hooks, entryPoint))
      return;
    if (hookFunction !== undefined) {
      const index = arrayLastIndexOf(hooks[entryPoint], hookFunction);
      return index === -1 ? undefined : arraySplice(hooks[entryPoint], index, 1)[0];
    }
    return arrayPop(hooks[entryPoint]);
  };
  DOMPurify.removeHooks = function(entryPoint) {
    if (!objectHasOwnProperty(hooks, entryPoint))
      return;
    hooks[entryPoint] = [];
  };
  DOMPurify.removeAllHooks = function() {
    hooks = _createHooksMap();
  };
  return DOMPurify;
}
var purify_default = createDOMPurify();

// src/agent-markdown.ts
function renderAgentMarkdown(text) {
  const body = document.createElement("div");
  body.className = "workshop-agent-message-body";
  body.innerHTML = purify_default.sanitize(f.parse(text, { async: false, gfm: true }), {
    ALLOWED_TAGS: ["p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "del", "blockquote", "pre", "code", "ul", "ol", "li", "hr", "table", "thead", "tbody", "tr", "th", "td", "a"],
    ALLOWED_ATTR: ["href", "title", "start"]
  });
  for (const link of body.querySelectorAll("a[href]")) {
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  }
  return body;
}

// src/agent-changes.ts
var stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)])) : value;
var same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
var display = (value) => value === undefined || value === null ? "—" : typeof value === "string" ? value : JSON.stringify(stable(value));
function reorderedIds(before, after) {
  const old = new Map(before.map((b, i) => [b.id, i]));
  const common = after.filter((b) => old.has(b.id));
  const tails = [], parents = [];
  common.forEach((block, i) => {
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = lo + hi >>> 1;
      if (old.get(common[tails[mid]].id) < old.get(block.id))
        lo = mid + 1;
      else
        hi = mid;
    }
    parents[i] = lo ? tails[lo - 1] : -1;
    tails[lo] = i;
  });
  const kept = new Set;
  for (let i = tails.at(-1) ?? -1;i >= 0; i = parents[i])
    kept.add(common[i].id);
  return new Set(common.filter((b) => !kept.has(b.id)).map((b) => b.id));
}
function agentBlockChanges(before, after) {
  const unique = (blocks) => blocks.filter((b) => blocks.filter((other) => other.id === b.id).length === 1);
  const oldBlocks = unique(before), newBlocks = unique(after);
  const old = new Map(oldBlocks.map((b) => [b.id, b])), next = new Map(newBlocks.map((b) => [b.id, b]));
  const moved = reorderedIds(oldBlocks, newBlocks);
  const categories = (blocks) => new Map(computePromptGroups(blocks).flatMap((group) => group.children.map((b) => [b.id, group.categoryBlock?.name ?? "Ungrouped"])));
  const oldCategories = categories(before), newCategories = categories(after);
  const categoryLabel = (block, names) => !block ? "—" : `${names.get(block.id) ?? "—"}${block.group === undefined ? " (inherited)" : ""}`;
  const labels = { name: "Name", role: "Role", depth: "Depth", enabled: "Enabled", position: "Injection position", isLocked: "Locked" };
  const changes = [];
  for (const id of [...newBlocks.map((b) => b.id), ...oldBlocks.filter((b) => !next.has(b.id)).map((b) => b.id)]) {
    if (before.filter((b) => b.id === id).length > 1 || after.filter((b) => b.id === id).length > 1)
      continue;
    const a = old.get(id), b = next.get(id);
    if (a && b && same(a, b) && !moved.has(id))
      continue;
    const fields = [];
    for (const key of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
      if (["id", "content", "group"].includes(key) || (!a || !b) && !["name", "role", "depth", "enabled", "position", "variables"].includes(key))
        continue;
      const av = a ? a[key] : undefined;
      const bv = b ? b[key] : undefined;
      if (!same(av, bv))
        fields.push({ name: labels[key] ?? key, before: display(av), after: display(bv) });
    }
    if (!a || !b || !same(a.group, b.group) || oldCategories.get(id) !== newCategories.get(id))
      fields.push({ name: "Category", before: categoryLabel(a, oldCategories), after: categoryLabel(b, newCategories) });
    if (!a || !b || moved.has(id))
      fields.push({ name: "Order", before: a ? `#${before.indexOf(a) + 1}` : "—", after: b ? `#${after.indexOf(b) + 1}` : "—" });
    changes.push({
      id,
      name: b?.name ?? a.name,
      kind: !a ? "added" : !b ? "removed" : !same(a, b) ? "edited" : "reordered",
      before: a ? structuredClone(a) : null,
      after: b ? structuredClone(b) : null,
      fields
    });
  }
  return changes;
}
function diffPromptLines(before, after) {
  const a = before ? before.split(`
`) : [], b = after ? after.split(`
`) : [];
  let prefix = 0, suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix])
    prefix++;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1])
    suffix++;
  const aa = a.slice(prefix, a.length - suffix), bb = b.slice(prefix, b.length - suffix);
  const operations = a.slice(0, prefix).map((text) => ({ kind: "equal", text }));
  if (aa.length * bb.length <= 250000) {
    const width = bb.length + 1, grid = new Uint32Array((aa.length + 1) * width);
    for (let i = aa.length - 1;i >= 0; i--)
      for (let j = bb.length - 1;j >= 0; j--)
        grid[i * width + j] = aa[i] === bb[j] ? 1 + grid[(i + 1) * width + j + 1] : Math.max(grid[(i + 1) * width + j], grid[i * width + j + 1]);
    let i = 0, j = 0;
    while (i < aa.length || j < bb.length) {
      if (i < aa.length && j < bb.length && aa[i] === bb[j]) {
        operations.push({ kind: "equal", text: aa[i++] });
        j++;
      } else if (i < aa.length && (j === bb.length || grid[(i + 1) * width + j] >= grid[i * width + j + 1]))
        operations.push({ kind: "remove", text: aa[i++] });
      else
        operations.push({ kind: "add", text: bb[j++] });
    }
  } else {
    for (const text of aa)
      operations.push({ kind: "remove", text });
    for (const text of bb)
      operations.push({ kind: "add", text });
  }
  for (const text of a.slice(a.length - suffix))
    operations.push({ kind: "equal", text });
  let oldLine = 0, newLine = 0;
  return operations.map((line) => ({ ...line, before: line.kind === "add" ? null : ++oldLine, after: line.kind === "remove" ? null : ++newLine }));
}

// src/agent-change-view.ts
function contentDiff(change) {
  const result = document.createElement("div");
  const before = change.before?.content ?? "", after = change.after?.content ?? "";
  if (before === after) {
    result.textContent = "Prompt content unchanged.";
    return result;
  }
  const lines = diffPromptLines(before, after);
  const count = document.createElement("p");
  count.textContent = `${lines.filter((line) => line.kind === "add").length} lines added · ${lines.filter((line) => line.kind === "remove").length} removed`;
  const scroller = document.createElement("div"), table = document.createElement("table"), caption = document.createElement("caption"), head = document.createElement("thead"), body = document.createElement("tbody");
  scroller.className = "workshop-agent-diff-scroll";
  table.className = "workshop-agent-diff";
  caption.textContent = `Content changes for ${change.name}`;
  const header = document.createElement("tr");
  for (const name of ["Before", "After", "Change", "Content"]) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = name;
    header.append(cell);
  }
  head.append(header);
  table.append(caption, head, body);
  scroller.append(table);
  const visible = [];
  for (let i = 0;i < lines.length; ) {
    if (lines[i].kind !== "equal") {
      visible.push(lines[i++]);
      continue;
    }
    let end = i;
    while (end < lines.length && lines[end].kind === "equal")
      end++;
    if (end - i > 8) {
      const left = i === 0 ? 0 : 3, right = end === lines.length ? 0 : 3;
      visible.push(...lines.slice(i, i + left), end - i - left - right, ...lines.slice(end - right, end));
    } else
      visible.push(...lines.slice(i, end));
    i = end;
  }
  let shown = 0;
  const more = document.createElement("button");
  more.type = "button";
  more.className = "workshop-text-button";
  const append = (all = false) => {
    const end = all ? visible.length : Math.min(500, visible.length);
    for (;shown < end; shown++) {
      const line = visible[shown], row = document.createElement("tr");
      if (typeof line === "number") {
        const cell = document.createElement("td");
        cell.colSpan = 4;
        cell.textContent = `${line} unchanged lines`;
        row.className = "diff-gap";
        row.append(cell);
      } else {
        row.className = `diff-${line.kind}`;
        for (const value of [line.before ?? "", line.after ?? "", line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " ", line.text]) {
          const cell = document.createElement("td");
          cell.textContent = String(value);
          row.append(cell);
        }
      }
      body.append(row);
    }
    more.hidden = shown === visible.length;
    more.textContent = `Show remaining ${visible.length - shown} diff lines for ${change.name}`;
  };
  append();
  more.addEventListener("click", () => {
    append(true);
    table.focus();
  });
  table.tabIndex = -1;
  result.append(count, scroller, more);
  return result;
}
function renderAgentChanges(changes, primaryId, open) {
  const card = document.createElement("section");
  card.className = "workshop-agent-changes";
  card.setAttribute("aria-label", "Draft changes");
  const heading = document.createElement("h3");
  heading.textContent = `Draft changes (${changes.length})`;
  const copy = document.createElement("p");
  copy.textContent = "Changes from this run. Review the draft before Apply.";
  card.append(heading, copy);
  for (const change of [...changes.filter((change) => change.id === primaryId), ...changes.filter((change) => change.id !== primaryId)]) {
    const detail = document.createElement("details"), summary = document.createElement("summary"), fields = document.createElement("dl");
    summary.textContent = `${change.kind[0].toUpperCase() + change.kind.slice(1)} · ${change.name}`;
    for (const field of change.fields.filter((field) => !["Category", "Order"].includes(field.name))) {
      const row = document.createElement("div"), key = document.createElement("dt"), value = document.createElement("dd");
      key.textContent = field.name;
      value.textContent = `${field.before} → ${field.after}`;
      row.append(key, value);
      fields.append(row);
    }
    detail.append(summary);
    const placement = document.createElement("p");
    placement.className = "workshop-agent-change-placement";
    placement.textContent = change.fields.filter((field) => ["Category", "Order"].includes(field.name)).map((field) => `${field.name}: ${field.before} → ${field.after}`).join(" · ");
    if (placement.textContent)
      detail.append(placement);
    if (fields.children.length) {
      const settings = document.createElement("details"), settingsSummary = document.createElement("summary");
      settings.className = "workshop-agent-change-settings";
      settingsSummary.textContent = `Settings changes (${fields.children.length})`;
      settings.append(settingsSummary, fields);
      settings.open = change.before?.content === change.after?.content;
      detail.append(settings);
    }
    if (change.after) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "workshop-text-button";
      button.textContent = `Open prompt: ${change.name}`;
      button.addEventListener("click", () => open(change.id));
      detail.append(button);
    }
    let rendered = false;
    detail.addEventListener("toggle", () => {
      if (detail.open && !rendered) {
        rendered = true;
        detail.append(contentDiff(change));
      }
    });
    card.append(detail);
    if (change.id === primaryId && (change.before?.content.length ?? 0) + (change.after?.content.length ?? 0) < 20000)
      detail.open = true;
  }
  return card;
}

// src/agent-macros.ts
function macroCatalogue(input) {
  if (!input || typeof input !== "object" || !Array.isArray(input.categories))
    return null;
  const entries = [];
  const bounded = (value, max) => typeof value === "string" && value.length <= max;
  const categories = input.categories;
  if (categories.length > 200)
    return null;
  for (const group of categories) {
    if (!group || typeof group !== "object")
      return null;
    const { category, macros } = group;
    if (!bounded(category, 200) || !Array.isArray(macros) || macros.length > 2000)
      return null;
    for (const item of macros) {
      if (!item || typeof item !== "object")
        return null;
      const m = item;
      if (!bounded(m.name, 200) || !m.name || !bounded(m.syntax, 4000) || !bounded(m.description, 12000))
        return null;
      if (m.args !== undefined && (!Array.isArray(m.args) || m.args.length > 50))
        return null;
      const args = [];
      for (const arg of m.args ?? []) {
        if (!arg || typeof arg !== "object")
          return null;
        const a = arg;
        if (!bounded(a.name, 200) || typeof a.optional !== "boolean")
          return null;
        args.push({ name: a.name, optional: a.optional });
      }
      entries.push({ name: m.name, syntax: m.syntax, description: m.description, category, args, ...bounded(m.returns, 1000) ? { returns: m.returns } : {} });
      if (entries.length > 2000)
        return null;
    }
  }
  return entries;
}
async function loadMacroCatalogue() {
  try {
    const response = await fetch("/api/v1/macros", { credentials: "same-origin", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5000) });
    if (!response.ok)
      return;
    const input = await response.json();
    return macroCatalogue(input) === null ? undefined : input;
  } catch {
    return;
  }
}

// src/agent-workspace.ts
function confirmAgentApply(parent) {
  if (parent.querySelector(".workshop-agent-apply"))
    return Promise.resolve(false);
  const dialog = document.createElement("dialog"), titleId = `agent-apply-${crypto.randomUUID()}`;
  const previous = document.activeElement;
  dialog.className = "workshop-agent-exit workshop-agent-apply";
  dialog.setAttribute("aria-labelledby", titleId);
  dialog.innerHTML = `<h2 id="${titleId}">Apply local agent drafts?</h2><p>Apply all unsynced Workshop changes to the mounted preset? A backup will be created first.</p><button type="button" class="workshop-text-button" data-confirm>Apply drafts</button><button type="button" class="workshop-text-button" data-cancel autofocus>Keep editing</button>`;
  parent.append(dialog);
  return new Promise((resolve) => {
    const finish = (confirmed) => {
      observer.disconnect();
      dialog.close();
      dialog.remove();
      if (previous?.isConnected)
        previous.focus({ preventScroll: true });
      resolve(confirmed);
    };
    const observer = new MutationObserver(() => {
      if (!dialog.isConnected)
        finish(false);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    dialog.querySelector("[data-confirm]").addEventListener("click", () => finish(true));
    dialog.querySelector("[data-cancel]").addEventListener("click", () => finish(false));
    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      finish(false);
    });
    dialog.showModal();
  });
}
var AGENT_CSS = `
.workshop-shell .workshop-header {grid-template-columns:auto minmax(0,1fr) auto}
.workshop-shell.agent-mode .workshop-body {display:none!important}
.workshop-shell.agent-mode .workshop-mobile-only,.workshop-shell.agent-mode [data-action="backups"],.workshop-shell.agent-mode [data-action="preview-layout"] {display:none!important}
.workshop-agent {min-height:0;min-width:0;display:grid;grid-template-rows:minmax(0,1fr) minmax(80px,26%);overflow:hidden;grid-row:2}
.has-draft-error .workshop-agent {grid-row:3}
.workshop-shell.agent-mode .workshop-preview {grid-column:1;grid-row:2;border-left:0;min-height:0}
.workshop-shell.agent-mode.preview-collapsed .workshop-agent {grid-template-rows:minmax(0,1fr) 38px}
.workshop-agent-columns {display:grid;grid-template-columns:minmax(0,1fr) minmax(320px,42%);min-height:0;min-width:0}
.workshop-agent-prompt {position:relative;display:grid;grid-template-columns:minmax(0,1fr);min-width:0;min-height:0;overflow:hidden}
.workshop-agent-prompt.navigation-open {grid-template-columns:minmax(180px,30%) minmax(0,1fr)}
.workshop-shell.agent-mode .workshop-agent .workshop-rail.left {position:static;grid-column:1;grid-row:1;width:auto!important;transform:none;box-shadow:none;visibility:visible!important}
.workshop-shell.agent-mode .workshop-agent .workshop-rail.left[hidden] {display:none!important}
.workshop-shell.agent-mode .workshop-agent .workshop-rail.left .workshop-rail-title,
.workshop-shell.agent-mode .workshop-agent .workshop-rail.left .workshop-count,
.workshop-shell.agent-mode .workshop-agent .workshop-rail.left .workshop-search-wrap,
.workshop-shell.agent-mode .workshop-agent .workshop-rail.left .workshop-scroll,
.workshop-shell.agent-mode .workshop-agent .workshop-rail.left .workshop-rail-note {display:block}
.workshop-shell.agent-mode .workshop-agent .workshop-rail.left .workshop-scroll {flex:1}
.workshop-shell.agent-mode .workshop-agent .workshop-rail-header {justify-content:initial;padding:7px 7px 5px 11px}
.workshop-shell.agent-mode .workshop-agent .workshop-rail-tools {display:inline-flex}
.workshop-shell.agent-mode .workshop-agent .workshop-rail-collapse {display:inline-flex}
.workshop-agent-editor,.workshop-agent-chat {min-width:0;min-height:0;display:flex;flex-direction:column}
.workshop-agent-editor {gap:14px;padding:18px;overflow:auto;grid-column:-2 / -1}
.workshop-agent-chat {border-left:1px solid var(--lumiverse-border);background:var(--lumiverse-fill-subtle,rgba(255,255,255,.025));overflow:hidden}
.workshop-agent-editor-heading {display:flex;gap:10px;align-items:center}
.workshop-agent h2 {font-size:15px;margin:0}.workshop-agent p {font-size:12px;color:var(--lumiverse-text-muted);margin:0;line-height:1.5}
.workshop-agent .workshop-agent-block-name {font-size:14px;font-weight:650;color:var(--lumiverse-text);overflow-wrap:anywhere;padding-bottom:12px;border-bottom:1px solid var(--lumiverse-border)}
.workshop-agent label {display:flex;flex-direction:column;gap:7px;font-size:12px;font-weight:600;min-width:0}
.workshop-agent select,.workshop-agent input,.workshop-agent textarea {box-sizing:border-box;width:100%;border:1px solid var(--lumiverse-border);border-radius:10px;background:var(--lumiverse-bg);color:var(--lumiverse-text);padding:11px;font:inherit}
.workshop-agent textarea {line-height:1.6}.workshop-agent [data-agent="content"] {font-family:var(--lumiverse-font-mono,monospace);font-size:12px;min-height:180px;flex:1;resize:none;padding:16px;border-radius:12px}
.workshop-agent .workshop-agent-content {flex:1;min-height:180px}
.workshop-agent-settings>div {display:flex;flex-direction:column;gap:7px;min-width:0}
.workshop-agent-settings {display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:18px;border-bottom:1px solid var(--lumiverse-border)}
.workshop-agent-model-control {display:flex;gap:7px;min-width:0}
.workshop-agent-model-control input {flex:1;min-width:0}
.workshop-agent-model-control button {flex:0 0 38px;display:grid;place-items:center}
.workshop-agent-model-control svg {width:16px;height:16px}
.workshop-agent-log>* {flex:0 0 auto}
.workshop-agent-model-status {font-size:11px;line-height:1.4;color:var(--lumiverse-text-muted)}
.workshop-agent-settings>p {grid-column:1 / -1;font-size:11px}
.workshop-agent-log {flex:1;min-height:60px;overflow:auto;display:flex;flex-direction:column;gap:14px;padding:18px;scrollbar-gutter:stable}
.workshop-agent-message {white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.6;padding:14px;border:1px solid var(--lumiverse-border);border-radius:12px;background:var(--lumiverse-bg)}
.workshop-agent-message>strong {display:block;margin-bottom:7px;font-size:11px;color:var(--lumiverse-text-muted)}
.workshop-agent-message-body {white-space:normal}
.workshop-agent-message-body p {font-size:inherit;color:inherit;margin:8px 0;line-height:inherit}
.workshop-agent-message-body h1,.workshop-agent-message-body h2,.workshop-agent-message-body h3 {margin:16px 0 8px;line-height:1.4;font-size:15px}
.workshop-agent-message-body ul,.workshop-agent-message-body ol {padding-left:22px;margin:8px 0}
.workshop-agent-message-body li {margin:5px 0}
.workshop-agent-message-body code {font-family:var(--lumiverse-font-mono,monospace);background:var(--lumiverse-fill-subtle,rgba(128,128,128,.12));border-radius:4px;padding:2px 4px;font-size:.92em}
.workshop-agent-message-body pre {white-space:pre;overflow:auto;overflow-wrap:normal;max-height:350px;padding:12px;border:1px solid var(--lumiverse-border);border-radius:8px;font-size:12px}
.workshop-agent-message-body pre code {padding:0;background:none}
.workshop-agent-message-body blockquote {margin:12px 0;padding-left:12px;border-left:3px solid var(--lumiverse-border)}
.workshop-agent-message-body table {display:block;max-width:100%;overflow:auto;border-collapse:collapse;margin:12px 0}
.workshop-agent-message-body th,.workshop-agent-message-body td {border:1px solid var(--lumiverse-border);padding:7px 10px;text-align:left}
.workshop-agent-message-body a {color:var(--lumiverse-primary,#a3a0e5)}
.workshop-agent-message-body a:focus-visible {outline:2px solid currentColor;outline-offset:2px}
.workshop-agent-changes {padding:14px;border:1px solid var(--lumiverse-primary,#a3a0e5);border-radius:12px;background:var(--lumiverse-bg);font-size:12px}
.workshop-agent-changes h3 {font-size:14px;margin:0 0 7px}
.workshop-agent-changes>details {margin-top:10px;border:1px solid var(--lumiverse-border);border-radius:8px;overflow:hidden}
.workshop-agent-changes summary {cursor:pointer;padding:11px 12px;overflow-wrap:anywhere;font-weight:600}
.workshop-agent-changes details>dl,.workshop-agent-changes details>button,.workshop-agent-changes details>div {margin:10px 12px}
.workshop-agent-change-settings {margin:8px 12px;border:1px solid var(--lumiverse-border);border-radius:6px}
.workshop-agent-changes .workshop-agent-change-settings summary {font-size:11px;font-weight:400;padding:8px 10px}
.workshop-agent-changes .workshop-agent-change-placement {margin:8px 12px;font-size:11px;overflow-wrap:anywhere}
.workshop-agent-changes dl {display:flex;flex-direction:column;gap:6px}
.workshop-agent-changes dl>div {display:grid;grid-template-columns:85px minmax(0,1fr);gap:10px}
.workshop-agent-changes dt {color:var(--lumiverse-text-muted)}.workshop-agent-changes dd {margin:0;overflow-wrap:anywhere}
.workshop-agent-diff-scroll {overflow:auto;max-height:300px;margin-top:10px;overscroll-behavior:contain;border:1px solid var(--lumiverse-border);border-radius:6px}
.workshop-agent-diff {border-collapse:collapse;min-width:100%;font:11px var(--lumiverse-font-mono,monospace);line-height:1.6}
.workshop-agent-diff caption {text-align:left;padding:8px;font:11px sans-serif;color:var(--lumiverse-text-muted)}
.workshop-agent-diff th {text-align:left;padding:5px 7px;border-bottom:1px solid var(--lumiverse-border);font:10px sans-serif}
.workshop-agent-diff td {padding:1px 7px;vertical-align:top;white-space:pre}
.workshop-agent-diff td:not(:last-child) {width:1%;color:var(--lumiverse-text-muted)}
.workshop-agent-diff .diff-add {background:rgba(70,180,120,.13)}
.workshop-agent-diff .diff-remove {background:rgba(220,80,105,.13)}
.workshop-agent-diff .diff-gap {color:var(--lumiverse-text-muted);background:var(--lumiverse-fill-subtle,rgba(128,128,128,.08))}
.workshop-agent-thinking {padding:12px 14px;border:1px solid var(--lumiverse-border);border-radius:10px;color:var(--lumiverse-text-muted)}
.workshop-agent-thinking[hidden] {display:none}
.workshop-agent details {font-size:12px}.workshop-agent pre {white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto;font-size:11px}
.workshop-agent-chat-footer {flex:0 0 auto;padding:0 18px 18px;display:flex;flex-direction:column;gap:10px}
.workshop-agent-chat-footer details {padding:0 3px}
.workshop-agent-chat-footer .workshop-agent-tools {padding:0;border:1px solid var(--lumiverse-border);border-radius:12px;background:var(--lumiverse-bg);overflow:hidden}
.workshop-agent-tools>summary {padding:12px 14px;cursor:pointer;font-weight:600;line-height:1.5;list-style-position:inside}
.workshop-agent-tools[open]>summary {border-bottom:1px solid var(--lumiverse-border)}
.workshop-agent-tools-body {padding:14px;max-height:140px;overflow:auto;display:flex;flex-direction:column;gap:10px;overscroll-behavior:contain}
.workshop-agent-compatibility {border-top:1px solid var(--lumiverse-border)}
.workshop-agent-compatibility summary {padding:8px 0;cursor:pointer;color:var(--lumiverse-text-muted)}
.workshop-agent-compatibility label {margin:5px 0 7px}
.workshop-agent-tools-body label {font-size:11px;color:var(--lumiverse-text-muted)}
.workshop-agent-tools-body pre {margin:2px 0 0;padding:10px;min-height:38px;max-height:120px;line-height:1.7;border:1px solid var(--lumiverse-border);border-radius:8px;background:var(--lumiverse-fill-subtle,rgba(128,128,128,.07))}
.workshop-agent-tools-body pre:empty:before {content:'No tool calls yet.';color:var(--lumiverse-text-muted)}.workshop-agent-status {font-size:11px;line-height:1.5;color:var(--lumiverse-text-muted);padding:0 3px}
.workshop-agent-composer {display:flex;gap:10px;align-items:flex-end;padding:12px;border:1px solid var(--lumiverse-border);border-radius:18px;background:var(--lumiverse-bg);box-shadow:0 6px 20px rgba(0,0,0,.12)}
.workshop-agent-composer:focus-within {border-color:var(--lumiverse-primary,var(--lumiverse-text-muted))}
.workshop-agent-composer textarea {flex:1;min-width:0;min-height:48px;max-height:180px;resize:none;border:0!important;border-radius:0;background:transparent;padding:4px;outline:none;font-size:13px;box-shadow:none}
.workshop-agent-send {flex:0 0 auto;width:36px;height:36px;display:grid;place-items:center;border:0;border-radius:50%;background:var(--lumiverse-primary,#a3a0e5);color:var(--lumiverse-primary-text,#111);cursor:pointer}
.workshop-agent-send:disabled {opacity:.4;cursor:default}.workshop-agent-send svg,.workshop-agent-nav-toggle svg {width:18px;height:18px;display:block}
.workshop-agent-nav-toggle {flex:0 0 auto;width:32px;height:32px;display:grid;place-items:center}
.workshop-agent button:focus-visible,.workshop-agent summary:focus-visible {outline:2px solid var(--lumiverse-primary,#a3a0e5);outline-offset:3px}
.workshop-agent-sr-only {position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
.workshop-agent-exit {max-width:min(440px,calc(100vw - 32px));border:1px solid var(--lumiverse-border);border-radius:12px;padding:22px;background:var(--lumiverse-bg,#17171e);color:var(--lumiverse-text,#eee)}
.workshop-agent-exit::backdrop {background:rgba(0,0,0,.65)}.workshop-agent-exit h2 {font-size:17px}.workshop-agent-exit p {font-size:13px;line-height:1.5}.workshop-agent-exit button {margin:6px 5px 0 0}
@media(max-width:1100px){.workshop-agent-prompt.navigation-open {grid-template-columns:minmax(0,1fr)}.workshop-shell.agent-mode .workshop-agent-prompt.navigation-open .workshop-rail.left {position:absolute;inset:0 auto 0 0;width:min(85%,300px)!important;z-index:2;box-shadow:8px 0 24px rgba(0,0,0,.3)}}
@media(max-width:900px){
 .workshop-agent-columns {grid-template-columns:minmax(0,1fr);grid-auto-rows:max-content;align-content:start;overflow:auto}
 .workshop-agent .workshop-agent-content {flex:none;min-height:0}
 .workshop-agent .workshop-preview-label,.workshop-agent .workshop-preview-status,.workshop-agent [data-action="preview-entries-collapse"] {display:none}
 .workshop-agent-editor {overflow:visible;padding:14px}
 .workshop-agent-chat {border-left:0;border-top:1px solid var(--lumiverse-border);min-height:480px}
 .workshop-agent-log {max-height:300px;min-height:70px}
 .workshop-agent [data-agent="content"] {height:230px;flex:none}
 .workshop-agent-settings {grid-template-columns:1fr;padding:14px}
 .workshop-agent-chat-footer {padding:0 14px 14px}
 .workshop-agent {grid-template-rows:minmax(0,1fr) 150px}
 .workshop-shell.agent-mode .workshop-header-brand {display:none}
}
`;
var AGENT_ICONS = {
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5 M4 17v-5h5 M6 6a8 8 0 0 1 13 3 M18 18A8 8 0 0 1 5 15"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  sidebar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>'
};

class AgentWorkspace {
  ctx;
  options;
  element = document.createElement("section");
  busy = false;
  failedInstruction = null;
  thinking = null;
  request = null;
  history = [];
  unsubscribe;
  timer = null;
  configId = crypto.randomUUID();
  disposed = false;
  modelFetch = null;
  connections = [];
  selectedId = null;
  navigationOpen = false;
  navigationHome;
  exitDialog = null;
  finishExit = null;
  constructor(ctx, options) {
    this.ctx = ctx;
    this.options = options;
    this.element.className = "workshop-agent";
    this.element.setAttribute("aria-label", "Agent workspace");
    const fieldId = crypto.randomUUID();
    this.element.innerHTML = `<div class="workshop-agent-columns"><div class="workshop-agent-prompt"><section class="workshop-agent-editor" aria-label="Draft prompt editor"><div class="workshop-agent-editor-heading"><button class="workshop-text-button workshop-agent-nav-toggle" type="button" data-agent="prompts" aria-controls="${fieldId}-prompts" aria-expanded="false" aria-label="Open agent prompts">${AGENT_ICONS.sidebar}</button><h2>Prompt draft</h2></div><p>All edits stay local until Apply.</p><p class="workshop-agent-block-name" data-agent="block-name"></p><label class="workshop-agent-content">Draft content<textarea data-agent="content" spellcheck="false"></textarea></label><details><summary>Inspect mounted context</summary><p>Includes current values, preview mocks, diagnostics, settings and regex metadata. Only this mounted preset is available to the agent.</p><pre data-agent="context"></pre></details></section></div><section class="workshop-agent-chat" aria-label="Preset assistant"><div class="workshop-agent-settings"><div><label for="${fieldId}-connection">Lumi connection</label><select id="${fieldId}-connection" data-agent="connection"><option value="">Loading connections…</option></select></div><div><label for="${fieldId}-model">Model</label><div class="workshop-agent-model-control"><input id="${fieldId}-model" data-agent="model" list="${fieldId}-models" placeholder="Connection default" maxlength="500" autocomplete="off"><datalist id="${fieldId}-models" data-agent="models"></datalist><button type="button" class="workshop-text-button" data-agent="refresh-models" aria-label="Refresh models" title="Refresh models">${AGENT_ICONS.refresh}</button></div><span class="workshop-agent-model-status" data-agent="model-status" role="status"></span></div><p>Use the connection default, or enter a model ID. Edits stay local until Apply.</p></div><div class="workshop-agent-log" data-agent="log" aria-label="Conversation"></div><div class="workshop-agent-chat-footer"><details class="workshop-agent-tools"><summary>Tool activity</summary><div class="workshop-agent-tools-body"><pre data-agent="activity"></pre><details class="workshop-agent-compatibility"><summary>PresetTools compatibility</summary><label for="${fieldId}-server">PresetTools compatibility</label><select id="${fieldId}-server" data-agent="server"><option value="">Built-in tools</option></select></details></div></details><div class="workshop-agent-status" data-agent="status" role="status"></div><button type="button" class="workshop-text-button" data-agent="retry" hidden>Retry last request</button><form class="workshop-agent-composer"><label class="workshop-agent-sr-only" for="${fieldId}-instruction">Ask the preset assistant</label><textarea id="${fieldId}-instruction" data-agent="instruction" rows="2" placeholder="Review diagnostics, or describe an edit…" required maxlength="30000"></textarea><button class="workshop-agent-send" type="submit" data-agent="send" aria-label="Send" title="Send" disabled>${AGENT_ICONS.send}</button></form></div></section></div>`;
    const navigation = options.navigation;
    this.navigationHome = { parent: navigation.parentNode, next: navigation.nextSibling, id: navigation.id, label: navigation.getAttribute("aria-label"), hidden: navigation.hidden, buttonLabel: navigation.querySelector('[data-action="left"]').getAttribute("aria-label") };
    navigation.id = `${fieldId}-prompts`;
    navigation.setAttribute("aria-label", "Agent prompts");
    navigation.querySelector('[data-action="left"]').setAttribute("aria-label", "Collapse agent prompt sidebar");
    const initiallyCollapsed = !!navigation.closest(".left-collapsed");
    this.element.querySelector(".workshop-agent-prompt").prepend(navigation);
    this.selectedId = options.initialBlockId;
    this.setNavigation(window.innerWidth > 1100 && !initiallyCollapsed);
    this.button("prompts").addEventListener("click", () => this.toggleNavigation());
    this.button("send").addEventListener("click", (e) => {
      if (this.busy) {
        e.preventDefault();
        this.cancel();
      }
    });
    this.unsubscribe = ctx.onBackendMessage((payload) => this.receive(payload));
    this.select("connection").addEventListener("change", () => {
      this.resetModel();
      this.loadModels();
      this.updateControls();
    });
    this.button("refresh-models").addEventListener("click", () => {
      this.loadModels();
    });
    this.button("retry").addEventListener("click", () => {
      if (this.failedInstruction)
        this.run(this.failedInstruction);
    });
    this.area("content").addEventListener("input", () => {
      try {
        const preset = options.snapshot(), baseline = presetFingerprint(preset);
        const block = preset.blocks.find((b) => b.id === this.selectedId);
        if (!block || block.isLocked || preset.blocks.filter((b) => b.id === block.id).length !== 1)
          throw Error("This prompt cannot be edited.");
        block.content = this.area("content").value;
        options.stage(preset, baseline);
      } catch (error) {
        this.status(error instanceof Error ? error.message : "Could not stage this edit.");
      }
    });
    this.element.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      if (this.busy)
        this.cancel();
      else
        this.run();
    });
    this.area("instruction").addEventListener("input", () => {
      this.resizeComposer();
      this.updateControls();
    });
    this.area("instruction").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !this.busy) {
        e.preventDefault();
        this.run();
      }
    });
    this.refresh();
    ctx.sendToBackend({ type: "workshop:agent-config", requestId: this.configId });
  }
  select(name) {
    return this.element.querySelector(`[data-agent="${name}"]`);
  }
  modelInput() {
    return this.element.querySelector('[data-agent="model"]');
  }
  resetModel() {
    const model = this.connections.find((c) => c.id === this.select("connection").value)?.model ?? "";
    this.modelInput().value = "";
    this.modelInput().placeholder = model ? `Connection default · ${model}` : "Enter a model ID";
    this.element.querySelector('[data-agent="models"]').replaceChildren(...model ? [new Option(model, model)] : []);
  }
  async loadModels() {
    this.modelFetch?.abort();
    const connectionId = this.select("connection").value;
    this.modelFetch = null;
    const status = this.element.querySelector('[data-agent="model-status"]');
    if (!connectionId) {
      status.textContent = "";
      return;
    }
    const controller = new AbortController;
    this.modelFetch = controller;
    const timeout = setTimeout(() => controller.abort(), 30000);
    status.textContent = "Loading models…";
    this.updateControls();
    try {
      const response = await fetch(`/api/v1/connections/${encodeURIComponent(connectionId)}/models`, { credentials: "same-origin", headers: { Accept: "application/json" }, signal: controller.signal });
      if (!response.ok)
        throw Error("Model catalogue unavailable.");
      const result = await response.json();
      if (!result || typeof result !== "object")
        throw Error("Invalid model catalogue.");
      const data = result;
      if (data.error || !Array.isArray(data.models) || !data.models.every((model) => typeof model === "string"))
        throw Error("Model catalogue unavailable.");
      if (this.disposed || this.modelFetch !== controller || this.select("connection").value !== connectionId)
        return;
      const configured = this.connections.find((c) => c.id === connectionId)?.model ?? "";
      const models = [...new Set([configured, ...data.models].filter(Boolean))];
      this.element.querySelector('[data-agent="models"]').replaceChildren(...models.map((id) => {
        const option = new Option(typeof data.model_labels?.[id] === "string" ? data.model_labels[id] : id, id);
        return option;
      }));
      status.textContent = `${data.models.length} models loaded. You can also enter a model ID.`;
    } catch {
      if (!this.disposed && this.modelFetch === controller)
        status.textContent = "Could not load models. Use the connection default or enter a model ID; Refresh models retries.";
    } finally {
      clearTimeout(timeout);
      if (this.modelFetch === controller) {
        this.modelFetch = null;
        if (!this.disposed)
          this.updateControls();
      }
    }
  }
  area(name) {
    return this.element.querySelector(`[data-agent="${name}"]`);
  }
  button(name) {
    return this.element.querySelector(`[data-agent="${name}"]`);
  }
  status(text) {
    this.element.querySelector('[data-agent="status"]').textContent = text;
  }
  updateControls() {
    const send = this.button("send");
    send.disabled = !this.busy && (!this.select("connection").value || !this.area("instruction").value.trim());
    send.type = this.busy ? "button" : "submit";
    send.setAttribute("aria-label", this.busy ? "Stop" : "Send");
    send.title = this.busy ? "Stop" : "Send";
    send.innerHTML = this.busy ? AGENT_ICONS.stop : AGENT_ICONS.send;
    this.area("content").readOnly = this.busy || !!this.options.snapshot().blocks.find((b) => b.id === this.selectedId)?.isLocked;
    this.button("refresh-models").disabled = this.busy || !!this.modelFetch || !this.select("connection").value;
    this.modelInput().disabled = this.busy || !this.select("connection").value;
    this.select("connection").disabled = this.busy;
    this.select("server").disabled = this.busy;
    this.button("retry").hidden = !this.failedInstruction;
    this.button("retry").disabled = this.busy || !this.select("connection").value;
  }
  message(role, text) {
    const node = document.createElement("div"), label = document.createElement("strong");
    node.className = "workshop-agent-message";
    label.textContent = role === "user" ? "You" : "Assistant";
    node.append(label, ...role === "assistant" ? [renderAgentMarkdown(text)] : [document.createTextNode(text)]);
    const log = this.element.querySelector('[data-agent="log"]');
    log.append(node);
    log.scrollTop = log.scrollHeight;
  }
  refresh() {
    if (this.disposed)
      return;
    const preset = this.options.snapshot();
    if (!preset.blocks.some((b) => b.id === this.selectedId)) {
      this.selectedId = (preset.blocks.find((b) => b.marker !== "category") ?? preset.blocks[0])?.id ?? null;
      if (this.element.isConnected)
        this.options.onSelection(this.selectedId);
    }
    this.renderContent();
    this.element.querySelector('[data-agent="context"]').textContent = JSON.stringify({ preset, ...this.options.context() }, null, 2);
    this.updateControls();
  }
  renderContent() {
    const block = this.options.snapshot().blocks.find((b) => b.id === this.selectedId);
    if (this.area("content").value !== (block?.content ?? ""))
      this.area("content").value = block?.content ?? "";
    this.area("content").disabled = !block;
    this.element.querySelector('[data-agent="block-name"]').textContent = block ? `${block.name}${block.isLocked ? " · Locked" : ""}` : "Choose a prompt from the sidebar";
    this.updateControls();
  }
  get selectedBlockId() {
    return this.selectedId;
  }
  selectBlock(id, reveal = false, focus = true) {
    if (id && !this.options.snapshot().blocks.some((b) => b.id === id))
      return;
    this.selectedId = id;
    this.renderContent();
    this.options.onSelection(id, reveal);
    if (window.innerWidth <= 1100)
      this.setNavigation(false);
    if (focus)
      this.area("content").focus({ preventScroll: true });
  }
  toggleNavigation() {
    this.setNavigation(!this.navigationOpen);
    if (!this.navigationOpen)
      this.button("prompts").focus({ preventScroll: true });
  }
  closeNavigation() {
    if (!this.navigationOpen || window.innerWidth > 1100)
      return false;
    this.setNavigation(false);
    this.button("prompts").focus({ preventScroll: true });
    return true;
  }
  setNavigation(open) {
    this.navigationOpen = open;
    this.options.navigation.hidden = !open;
    this.element.querySelector(".workshop-agent-prompt").classList.toggle("navigation-open", open);
    this.button("prompts").setAttribute("aria-expanded", String(open));
    this.button("prompts").setAttribute("aria-label", open ? "Close agent prompts" : "Open agent prompts");
    this.button("prompts").title = open ? "Close prompts" : "Open prompts";
  }
  resizeComposer() {
    const input = this.area("instruction");
    input.style.height = "auto";
    input.style.height = `${Math.min(180, Math.max(48, input.scrollHeight))}px`;
  }
  run(retryInstruction) {
    if (this.busy || !this.select("connection").value || !(retryInstruction ?? this.area("instruction").value).trim())
      return;
    try {
      const preset = this.options.snapshot(), instruction = (retryInstruction ?? this.area("instruction").value).trim();
      this.request = { id: crypto.randomUUID(), fingerprint: presetFingerprint(preset), instruction, before: structuredClone(preset.blocks), history: [...this.history, { role: "user", content: instruction }] };
      this.failedInstruction = null;
      this.busy = true;
      this.updateControls();
      this.status("Working in a detached draft…");
      if (!retryInstruction)
        this.message("user", instruction);
      if (retryInstruction)
        this.thinking?.parentElement?.remove();
      const thinking = document.createElement("details"), summary = document.createElement("summary");
      thinking.className = "workshop-agent-thinking";
      thinking.hidden = true;
      summary.textContent = "Thinking";
      this.thinking = document.createElement("pre");
      thinking.append(summary, this.thinking);
      this.element.querySelector('[data-agent="log"]').append(thinking);
      this.element.querySelector('[data-agent="activity"]').textContent = "";
      this.timer = setTimeout(() => this.cancel("Agent timed out. No generated changes were staged.", true), 125000);
      this.dispatch({ type: "workshop:agent-run", requestId: this.request.id, connectionId: this.select("connection").value, model: this.modelInput().value.trim(), serverId: this.select("server").value, instruction, history: this.history, preset, context: this.options.context() });
      if (!retryInstruction)
        this.area("instruction").value = "";
      this.resizeComposer();
    } catch (error) {
      this.cancel(error instanceof Error ? error.message : "Could not start agent.");
    }
  }
  async dispatch(payload) {
    const macroCatalogue = await loadMacroCatalogue();
    if (this.disposed || this.request?.id !== payload.requestId)
      return;
    try {
      this.ctx.sendToBackend({ ...payload, macroCatalogue });
    } catch (error) {
      this.cancel(error instanceof Error ? error.message : "Could not start agent.");
    }
  }
  receive(payload) {
    if (this.disposed || !payload || typeof payload !== "object")
      return;
    const p = payload;
    if (p.type === "workshop:agent-config" && p.requestId === this.configId) {
      this.connections = p.connections ?? [];
      this.select("connection").replaceChildren(new Option("Choose a connection", ""), ...this.connections.map((c) => new Option(`${c.name}${c.model ? ` · ${c.model}` : ""}`, c.id)));
      if (p.connections?.length === 1)
        this.select("connection").value = p.connections[0].id;
      this.resetModel();
      this.loadModels();
      this.select("server").replaceChildren(new Option("Built-in tools", ""), ...(p.servers ?? []).map((s) => new Option(s.name, s.id)));
      this.status(p.error ?? "Ready. Sending shares this preset context with the selected connection.");
      this.updateControls();
      return;
    }
    if (!this.request || p.requestId !== this.request.id)
      return;
    if (p.type === "workshop:agent-thinking") {
      if (this.thinking && p.content) {
        this.thinking.parentElement.hidden = false;
        this.thinking.textContent += `${this.thinking.textContent ? `

` : ""}${p.content}`;
      }
      return;
    }
    if (p.type === "workshop:agent-progress") {
      this.element.querySelector('[data-agent="activity"]').textContent += `${p.content ?? ""}
`;
      return;
    }
    if (p.type !== "workshop:agent-result")
      return;
    const request = this.request;
    this.request = null;
    this.busy = false;
    if (this.timer)
      clearTimeout(this.timer);
    this.timer = null;
    try {
      if (p.error)
        throw Error(p.error);
      const changes = p.preset ? agentBlockChanges(request.before, p.preset.blocks) : [];
      if (p.preset && presetFingerprint(p.preset) !== request.fingerprint)
        this.options.stage(p.preset, request.fingerprint);
      this.history = [...request.history, { role: "assistant", content: p.content ?? "" }];
      this.message("assistant", p.content ?? "Finished.");
      this.status(changes.length ? `Finished. ${changes.length} prompt${changes.length === 1 ? "" : "s"} changed locally. Review changes and preview before Apply.` : "Finished. No prompt changes in this run.");
      if (changes.length) {
        const primary = changes.find((change) => change.kind === "added") ?? changes.find((change) => change.after) ?? changes[0];
        if (primary.after)
          this.selectBlock(primary.id, true, false);
        const card = renderAgentChanges(changes, primary.id, (id) => {
          if (!this.options.snapshot().blocks.some((block) => block.id === id)) {
            this.status("This prompt is no longer in the current draft.");
            return;
          }
          this.selectBlock(id, true);
          this.area("content").scrollIntoView({ block: "nearest" });
        });
        const log = this.element.querySelector('[data-agent="log"]');
        log.append(card);
        log.scrollTop += card.getBoundingClientRect().top - log.getBoundingClientRect().top - 12;
      }
    } catch (error) {
      if (p.error)
        this.failedInstruction = request.instruction;
      if (p.content)
        this.message("assistant", p.content);
      this.status(error instanceof Error ? error.message : "Could not stage agent result.");
    }
    this.refresh();
    this.area("instruction").focus({ preventScroll: true });
  }
  cancel(message = "Stopped. No generated changes were staged.", retry = false) {
    this.failedInstruction = retry ? this.request?.instruction ?? null : null;
    if (this.request)
      this.ctx.sendToBackend({ type: "workshop:agent-cancel", requestId: this.request.id });
    this.request = null;
    this.busy = false;
    if (this.timer)
      clearTimeout(this.timer);
    this.timer = null;
    this.status(message);
    this.updateControls();
  }
  confirmLeave() {
    if (this.exitDialog)
      return Promise.resolve(null);
    const dialog = document.createElement("dialog"), titleId = `agent-exit-${crypto.randomUUID()}`;
    dialog.className = "workshop-agent-exit";
    dialog.setAttribute("aria-labelledby", titleId);
    dialog.innerHTML = `<h2 id="${titleId}">Leave agent mode?</h2><p>Keep drafts returns to Workshop with all local edits intact. Discard removes all unsynced Workshop edits. A running agent will be stopped. Neither option applies changes.</p><button class="workshop-text-button" data-choice="keep">Keep drafts and leave</button><button class="workshop-text-button" data-choice="discard">Discard drafts and leave</button><button class="workshop-text-button" data-choice="stay" autofocus>Stay</button>`;
    this.element.append(dialog);
    this.exitDialog = dialog;
    return new Promise((resolve) => {
      this.finishExit = (choice) => {
        dialog.close();
        dialog.remove();
        this.exitDialog = null;
        this.finishExit = null;
        resolve(choice);
      };
      dialog.addEventListener("cancel", (e) => {
        e.preventDefault();
        this.finishExit?.(null);
      });
      dialog.addEventListener("click", (e) => {
        const choice = e.target.closest("[data-choice]")?.dataset.choice;
        if (choice)
          this.finishExit?.(choice === "stay" ? null : choice);
      });
      dialog.showModal();
    });
  }
  destroy() {
    this.modelFetch?.abort();
    this.modelFetch = null;
    this.cancel();
    this.disposed = true;
    this.finishExit?.(null);
    this.unsubscribe();
    const nav = this.options.navigation, home = this.navigationHome;
    home.parent.insertBefore(nav, home.next);
    nav.id = home.id;
    nav.hidden = home.hidden;
    if (home.label === null)
      nav.removeAttribute("aria-label");
    else
      nav.setAttribute("aria-label", home.label);
    const close = nav.querySelector('[data-action="left"]');
    if (home.buttonLabel === null)
      close.removeAttribute("aria-label");
    else
      close.setAttribute("aria-label", home.buttonLabel);
    this.element.remove();
  }
}

// src/frontend.ts
var PREVIEW_DEBOUNCE_MS = 475;
var CHAT_WATCH_MS = 1250;
var MOBILE_BREAKPOINT = 900;
var LEFT_MIN = 210;
var LEFT_MAX = 480;
var RIGHT_MIN = 250;
var RIGHT_MAX = 560;
var PREVIEW_HEIGHT_MIN = 120;
var PREVIEW_WIDTH_MIN = 300;
var PREVIEW_WIDTH_MAX = 760;
var WORKSHOP_CSS = String.raw`
.workshop-toolbar-root {
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
  min-height: 40px;
  padding: 6px 14px;
  border-bottom: 1px solid var(--lumiverse-border, rgba(255,255,255,.08));
  flex: 0 0 auto;
}
.workshop-launcher {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-width: 0;
  gap: 7px;
  min-height: 36px;
  padding: 0 12px;
  border: 1px solid var(--lumiverse-border-neutral, var(--lumiverse-border));
  border-radius: 8px;
  background: var(--lumiverse-fill-subtle, rgba(255,255,255,.04));
  color: var(--lumiverse-text);
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: border-color var(--lumiverse-transition-fast, 120ms ease), background var(--lumiverse-transition-fast, 120ms ease);
}
.workshop-launcher:hover {
  border-color: var(--lumiverse-primary, currentColor);
  background: var(--lumiverse-primary-010, rgba(255,255,255,.07));
}
.workshop-launcher svg { width: 14px; height: 14px; }

.workshop-shell,
.workshop-shell * { box-sizing: border-box; }
.workshop-shell {
  --wk-left: 268px;
  --wk-right: 336px;
  --wk-preview-height: 300px;
  --wk-preview-width: 430px;
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-rows: 40px minmax(0, 1fr);
  overflow: hidden;
  color: var(--lumiverse-text, #eee);
  background: var(--lumiverse-bg-deep, #101014);
  font: inherit;
}
.workshop-header {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  padding: 0 10px;
  border-bottom: 1px solid var(--lumiverse-border, rgba(255,255,255,.1));
  background: var(--lumiverse-bg-dark, #141419);
}
.workshop-header-left,
.workshop-header-actions { min-width: 0; display: flex; align-items: center; gap: 7px; }
.workshop-header-actions { justify-content: flex-end; }
.workshop-shell.has-unsynced .workshop-header { grid-template-columns: auto minmax(0, 1fr) auto; }
.workshop-shell:not(.has-unsynced) [data-action="apply-drafts"], .workshop-shell:not(.has-unsynced) [data-action="discard-drafts"] { display: none; }
.workshop-shell.has-draft-error { grid-template-rows: 40px auto minmax(0, 1fr); }
.workshop-draft-error { padding: 8px 12px; color: var(--lumiverse-warning, #e8b04c); font-size: 11px; }
.workshop-header-brand { font-size: 12px; font-weight: 800; white-space: nowrap; }
.workshop-preset-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
  color: var(--lumiverse-text-muted, #9ca0aa);
  font-size: 11px;
}
.workshop-header-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--lumiverse-text-muted, #9ca0aa);
  font-size: 11px;
  white-space: nowrap;
}
.workshop-dot { width: 7px; height: 7px; border-radius: 999px; background: var(--lumiverse-text-dim, #777); }
.workshop-dot.is-draft { background: var(--lumiverse-warning, #e8b04c); }
.workshop-icon-button,
.workshop-text-button,
.workshop-segment button,
.workshop-row,
.workshop-variable-card,
.workshop-link-button,
.workshop-diagnostic-row,
.workshop-breakdown-row { font: inherit; }
.workshop-icon-button,
.workshop-text-button,
.workshop-mini-button {
  border: 1px solid var(--lumiverse-border-neutral, var(--lumiverse-border));
  background: var(--lumiverse-fill-subtle, rgba(255,255,255,.04));
  color: var(--lumiverse-text);
  border-radius: 8px;
  cursor: pointer;
}
.workshop-icon-button { width: 34px; height: 34px; display: inline-grid; place-items: center; padding: 0; flex: 0 0 auto; }
.workshop-icon-button svg { width: 16px; height: 16px; }
.workshop-text-button { min-height: 30px; padding: 0 9px; font-size: 11px; }
.workshop-mini-button { width: 24px; height: 24px; display: inline-grid; place-items: center; padding: 0; }
.workshop-mini-button svg { width: 13px; height: 13px; }
.workshop-icon-button:hover,
.workshop-text-button:hover,
.workshop-mini-button:hover,
.workshop-link-button:hover { border-color: var(--lumiverse-primary, currentColor); }

.workshop-body {
  min-height: 0;
  min-width: 0;
  display: grid;
  grid-template-columns: var(--wk-left) 5px minmax(0, 1fr) 5px var(--wk-right);
}
.workshop-shell.left-collapsed { --wk-left: 38px; }
.workshop-shell.right-collapsed { --wk-right: 38px; }
.workshop-rail {
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--lumiverse-bg-dark, #141419);
}
.workshop-rail.left { grid-column: 1; border-right: 1px solid var(--lumiverse-border, rgba(255,255,255,.1)); }
.workshop-rail.right { grid-column: 5; border-left: 1px solid var(--lumiverse-border, rgba(255,255,255,.1)); }
.workshop-rail-header {
  min-height: 42px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 7px 5px 11px;
}
.workshop-rail-title { font-size: 11px; font-weight: 800; letter-spacing: .08em; color: var(--lumiverse-text-muted); }
.workshop-count { margin-left: auto; font-size: 10px; color: var(--lumiverse-text-dim); }
.workshop-rail-collapse { margin-left: 2px; }
.left-collapsed .workshop-rail.left .workshop-rail-title,
.left-collapsed .workshop-rail.left .workshop-count,
.left-collapsed .workshop-rail.left .workshop-search-wrap,
.left-collapsed .workshop-rail.left .workshop-scroll,
.left-collapsed .workshop-rail.left .workshop-rail-note,
.right-collapsed .workshop-rail.right .workshop-rail-title,
.right-collapsed .workshop-rail.right .workshop-count,
.right-collapsed .workshop-rail.right .workshop-search-wrap,
.right-collapsed .workshop-rail.right .workshop-scroll,
.right-collapsed .workshop-rail.right .workshop-variable-workspace,
.right-collapsed .workshop-rail.right .workshop-rail-note { display: none; }
.left-collapsed .workshop-rail.left .workshop-rail-header,
.right-collapsed .workshop-rail.right .workshop-rail-header { justify-content: center; padding: 7px 2px; }
.left-collapsed .workshop-rail-collapse,
.right-collapsed .workshop-rail-collapse { margin: 0; }
.workshop-resizer { position: relative; z-index: 4; cursor: col-resize; touch-action: none; }
.workshop-resizer.left { grid-column: 2; }
.workshop-resizer.right { grid-column: 4; }
.workshop-resizer::after { content: ''; position: absolute; inset: 0 2px; background: transparent; }
.workshop-resizer:hover::after,
.workshop-resizer.is-dragging::after { background: var(--lumiverse-primary-025, rgba(255,255,255,.18)); }
.left-collapsed .workshop-resizer.left,
.right-collapsed .workshop-resizer.right { cursor: default; }

.workshop-center {
  grid-column: 3;
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr) 5px var(--wk-preview-height);
  background: var(--lumiverse-bg-deep, #101014);
}
.workshop-editor-region { grid-column: 1; grid-row: 1; min-width: 0; min-height: 0; overflow: hidden; padding: 12px 16px 16px; }
${FIND_REPLACE_CSS}
${PROMPT_MANAGER_CSS}
.workshop-editor-region { display: flex; flex-direction: column; }
.workshop-preset-tools { flex: none; display: flex; gap: 8px; padding-bottom: 10px; }
.workshop-preset-tools[hidden] { display: none; }
.workshop-editor-stage { width: 100%; height: 100%; min-width: 0; min-height: 0; flex: 1; display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; }
.workshop-editor-stage.dual { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.workshop-editor-slot { min-width: 0; min-height: 0; height: 100%; overflow: hidden; }
.workshop-editor-slot.primary:not(.dual-slot) { width: min(100%, 1500px); margin: 0 auto; }
.workshop-editor-slot > [data-role$="editor-mount"] { width: 100%; height: 100%; min-height: 0; }
.workshop-editor-empty { min-height: 320px; height: 100%; display: grid; place-items: center; text-align: center; color: var(--lumiverse-text-muted, #999); }
.workshop-empty-card { max-width: 420px; padding: 26px; border: 1px dashed var(--lumiverse-border-neutral, var(--lumiverse-border)); border-radius: 14px; background: var(--lumiverse-fill-subtle, rgba(255,255,255,.025)); }
.workshop-empty-card strong { display: block; color: var(--lumiverse-text); margin-bottom: 7px; }
.workshop-native-layout { height: 100% !important; min-height: 0 !important; }
.workshop-native-scroll { min-height: 0 !important; }
.workshop-native-form { width: 100% !important; max-width: none !important; margin-inline: 0 !important; }
.workshop-primary-textarea { min-height: clamp(360px, 48vh, 720px) !important; resize: vertical !important; }
.workshop-native-form.workshop-variable-sidecar { display: grid !important; grid-template-columns: minmax(0, 1fr) minmax(320px, 420px); grid-auto-rows: max-content; column-gap: 22px; align-items: start; }
.workshop-native-form.workshop-variable-sidecar > .workshop-native-main-field { grid-column: 1; }
.workshop-native-form.workshop-variable-sidecar > .workshop-native-variable-root { grid-column: 2; min-width: 0; min-height: 0; align-self: start; position: sticky; top: 0; max-height: var(--wk-native-pane-height, calc(100dvh - 220px)); overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; scrollbar-gutter: stable; padding-right: 4px; }

.workshop-preview-resizer { grid-column: 1; grid-row: 2; position: relative; z-index: 5; cursor: row-resize; touch-action: none; }
.workshop-preview-resizer::after { content: ''; position: absolute; inset: 2px 0; background: transparent; }
.workshop-preview-resizer:hover::after,
.workshop-preview-resizer.is-dragging::after { background: var(--lumiverse-primary-025, rgba(255,255,255,.18)); }
.workshop-preview { grid-column: 1; grid-row: 3; min-width: 0; min-height: 0; display: grid; grid-template-rows: auto minmax(0, 1fr); border-top: 1px solid var(--lumiverse-border, rgba(255,255,255,.1)); background: var(--lumiverse-bg-dark, #141419); }
.workshop-shell.preview-split:not(.preview-collapsed) .workshop-center { grid-template-columns: minmax(0, 1fr) 5px var(--wk-preview-width); grid-template-rows: minmax(0, 1fr); }
.workshop-shell.preview-split:not(.preview-collapsed) .workshop-editor-region { grid-column: 1; grid-row: 1; }
.workshop-shell.preview-split:not(.preview-collapsed) .workshop-preview-resizer { grid-column: 2; grid-row: 1; cursor: col-resize; }
.workshop-shell.preview-split:not(.preview-collapsed) .workshop-preview-resizer::after { inset: 0 2px; }
.workshop-shell.preview-split:not(.preview-collapsed) .workshop-preview { grid-column: 3; grid-row: 1; border-top: 0; border-left: 1px solid var(--lumiverse-border, rgba(255,255,255,.1)); }
.workshop-shell.preview-split:not(.preview-collapsed) .workshop-preview-status { display: none; }
.workshop-shell.preview-collapsed .workshop-center { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) 0 38px; }
.workshop-shell.preview-collapsed .workshop-editor-region { grid-column: 1; grid-row: 1; }
.workshop-shell.preview-collapsed .workshop-preview-resizer { display: none; }
.workshop-shell.preview-collapsed .workshop-preview { grid-column: 1; grid-row: 3; border-left: 0; border-top: 1px solid var(--lumiverse-border, rgba(255,255,255,.1)); }
.workshop-preview-toolbar { min-width: 0; min-height:38px; display: flex; flex-wrap:wrap; align-items: center; gap: 7px; padding: 4px 8px; border-bottom: 1px solid var(--lumiverse-border, rgba(255,255,255,.08)); }
.workshop-preview-search { flex: 1 1 150px; min-width: 86px; max-width: 220px; height: 26px; padding: 0 8px; border: 1px solid var(--lumiverse-border-neutral, var(--lumiverse-border)); border-radius: 7px; outline: none; background: var(--lumiverse-input-bg, var(--lumiverse-bg-deep)); color: var(--lumiverse-text); font: inherit; font-size: 10px; }
.workshop-preview-search:focus { border-color: var(--lumiverse-primary, currentColor); }
.workshop-preview-label { font-size: 11px; font-weight: 750; letter-spacing: .08em; color: var(--lumiverse-text-muted); }
.workshop-preview-status { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--lumiverse-text-dim); }
.workshop-preview-toolbar .spacer { flex: 1; }
.workshop-segment { display: inline-flex; padding: 2px; border: 1px solid var(--lumiverse-border-neutral, var(--lumiverse-border)); border-radius: 7px; background: var(--lumiverse-bg-deep, #101014); }
.workshop-segment button { border: 0; border-radius: 5px; padding: 4px 8px; background: transparent; color: var(--lumiverse-text-muted); cursor: pointer; font-size: 10px; }
.workshop-segment button.active { color: var(--lumiverse-primary-text, var(--lumiverse-text)); background: var(--lumiverse-primary-015, rgba(255,255,255,.09)); }
.workshop-preview-content { overflow: auto; padding: 12px; }
.preview-collapsed .workshop-preview-content { display: none; }
.preview-collapsed .workshop-preview-search,
.preview-collapsed .workshop-preview-status,
.preview-collapsed .workshop-preview-toolbar [data-action="preview-entries-collapse"] { display: none; }
.workshop-shell.preview-split:not(.preview-collapsed) .workshop-preview-label { display: none; }
.workshop-shell.preview-split:not(.preview-collapsed) .workshop-preview-search { min-width: 70px; max-width: none; }
.workshop-preview-state { height: 100%; min-height: 92px; display: grid; place-items: center; text-align: center; color: var(--lumiverse-text-muted); font-size: 12px; padding: 18px; }
.workshop-message,
.workshop-breakdown-row { border: 1px solid var(--lumiverse-border, rgba(255,255,255,.09)); border-radius: 9px; background: var(--lumiverse-bg-deep, #101014); margin-bottom: 9px; overflow: hidden; }
.workshop-message-head,
.workshop-breakdown-head { display: flex; align-items: center; gap: 7px; padding: 7px 9px; border-bottom: 1px solid var(--lumiverse-border, rgba(255,255,255,.07)); color: var(--lumiverse-text-muted); font-size: 10px; text-transform: uppercase; letter-spacing: .05em; }
.workshop-message pre,
.workshop-breakdown-row pre { margin: 0; padding: 10px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--lumiverse-text); font: 11px/1.55 var(--lumiverse-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
.workshop-preview.entries-collapsed .workshop-message pre,
.workshop-preview.entries-collapsed .workshop-breakdown-row pre { display: none; }
.workshop-breakdown-row { width: 100%; text-align: left; color: inherit; cursor: default; }
.workshop-breakdown-row.has-block { cursor: pointer; }
.workshop-breakdown-row.has-block:hover { border-color: var(--lumiverse-primary, currentColor); }

.workshop-search-wrap { padding: 0 10px 10px; }
.workshop-search { width: 100%; height: 32px; padding: 0 10px; border: 1px solid var(--lumiverse-border-neutral, var(--lumiverse-border)); border-radius: 8px; outline: none; background: var(--lumiverse-input-bg, var(--lumiverse-bg-deep)); color: var(--lumiverse-text); font: inherit; font-size: 11px; }
.workshop-search:focus { border-color: var(--lumiverse-primary, currentColor); }
.workshop-scroll { min-height: 0; overflow: auto; padding: 2px 7px 14px; }
.workshop-row-wrap { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 3px; align-items: center; }
.workshop-row-wrap.category-wrap { grid-template-columns: auto minmax(0, 1fr); }
.workshop-category-toggle { width: 24px; height: 28px; display: inline-grid; place-items: center; align-self: center; border: 0; border-radius: 6px; background: transparent; color: var(--lumiverse-text-muted); cursor: pointer; }
.workshop-category-toggle:hover { color: var(--lumiverse-text); background: var(--lumiverse-fill-subtle, rgba(255,255,255,.04)); }
.workshop-row { width: 100%; min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 7px 8px; margin: 1px 0; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--lumiverse-text); text-align: left; cursor: pointer; }
.workshop-row:hover { background: var(--lumiverse-fill-subtle, rgba(255,255,255,.04)); }
.workshop-row.selected { border-color: var(--lumiverse-primary-050, var(--lumiverse-primary)); background: var(--lumiverse-primary-010, rgba(255,255,255,.05)); }
.workshop-row.secondary-selected { border-color: var(--lumiverse-warning, #e8b04c); background: var(--lumiverse-warning-015, rgba(255,180,0,.05)); }
.workshop-row.variable-owner { box-shadow: inset 2px 0 var(--lumiverse-primary, currentColor); }
.workshop-row.variable-reference:not(.variable-owner) { box-shadow: inset 2px 0 var(--lumiverse-warning, #e8b04c); }
.workshop-row.category { margin-top: 8px; color: var(--lumiverse-text-muted); font-size: 10px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
.workshop-row.child { padding-left: 17px; }
.workshop-row-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workshop-row-meta { display: flex; gap: 4px; align-items: center; }
.workshop-pill { min-width: 20px; padding: 1px 5px; border: 1px solid var(--lumiverse-border-neutral, var(--lumiverse-border)); border-radius: 999px; color: var(--lumiverse-text-dim); font-size: 9px; text-align: center; }
.workshop-pill.define { color: var(--lumiverse-primary-text, var(--lumiverse-text)); }
.workshop-row-actions { display: inline-flex; gap: 3px; }
.workshop-category-chevron { width: 13px; height: 13px; flex: 0 0 auto; display: inline-grid; place-items: center; overflow: hidden; vertical-align: middle; transition: transform 120ms ease; }
.workshop-category-chevron svg { width: 13px; height: 13px; display: block; max-width: 13px; max-height: 13px; }
.workshop-category-chevron.collapsed { transform: rotate(-90deg); }
.workshop-rail-note { padding: 8px 10px; font-size: 10px; color: var(--lumiverse-text-dim); border-top: 1px solid var(--lumiverse-border); }
.workshop-rail-tools { display: inline-flex; gap: 3px; align-items: center; }
.left-collapsed .workshop-rail-tools { display: none; }

.workshop-variable-workspace { min-height: 0; display: grid; grid-template-rows: repeat(2, minmax(0, 1fr)); gap: 6px; padding: 0 7px 8px; overflow: hidden; }
.workshop-variable-workspace.has-selection { grid-template-rows: repeat(3, minmax(0, 1fr)); }
.workshop-variable-workspace.has-expanded-pane { grid-template-rows: minmax(0, 1fr); }
.workshop-variable-workspace.has-expanded-pane .workshop-variable-pane:not(.expanded) { display: none; }
.workshop-variable-pane { min-height: 0; display: grid; grid-template-rows: 31px minmax(0, 1fr); border: 1px solid var(--lumiverse-border, rgba(255,255,255,.08)); border-radius: 9px; overflow: hidden; background: var(--lumiverse-bg-deep, #101014); }
.workshop-variable-pane-header { min-width: 0; display: flex; align-items: center; gap: 7px; padding: 0 8px; border-bottom: 1px solid var(--lumiverse-border, rgba(255,255,255,.07)); color: var(--lumiverse-text-muted); }
.workshop-variable-pane-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 9px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
.workshop-variable-pane-count { margin-left: auto; font-size: 9px; color: var(--lumiverse-text-dim); }
.workshop-variable-pane-toggle { border: 0; background: transparent; color: var(--lumiverse-text-muted); cursor: pointer; font: inherit; font-size: 9px; padding: 3px 2px; }
.workshop-variable-pane-toggle:hover { color: var(--lumiverse-text); }
.workshop-variable-pane-body { min-height: 0; overflow: auto; padding: 5px; scrollbar-gutter: stable; }
.workshop-variable-card { width: 100%; display: block; padding: 9px 10px; margin: 4px 0; border: 1px solid var(--lumiverse-border, rgba(255,255,255,.07)); border-radius: 8px; background: var(--lumiverse-fill-subtle, rgba(255,255,255,.018)); color: inherit; text-align: left; cursor: pointer; }
.workshop-variable-card:hover { border-color: var(--lumiverse-border-strong, rgba(255,255,255,.15)); background: var(--lumiverse-fill-subtle, rgba(255,255,255,.04)); }
.workshop-variable-card.selected { border-color: var(--lumiverse-primary-050, var(--lumiverse-primary)); background: var(--lumiverse-primary-010, rgba(255,255,255,.05)); }
.workshop-variable-card-head { min-width: 0; display: flex; align-items: baseline; gap: 6px; }
.workshop-variable-label { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-weight: 700; line-height: 1.35; }
.workshop-variable-refcount { flex: 0 0 auto; color: var(--lumiverse-text-dim); font-size: 9px; }
.workshop-variable-macro { display: block; margin-top: 4px; color: var(--lumiverse-primary-text, var(--lumiverse-text-muted)); font: 9.5px/1.4 var(--lumiverse-font-mono, ui-monospace, monospace); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workshop-variable-owner { display: block; margin-top: 5px; color: var(--lumiverse-text-muted); font-size: 9px; line-height: 1.35; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workshop-section-label { margin: 13px 8px 5px; color: var(--lumiverse-text-dim); font-size: 9px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
.right-collapsed .workshop-rail.right [data-action="reset-mocks"] { display: none; }
.workshop-mock-note { margin: 3px 5px 9px; }
.workshop-mock-group { margin: 5px 0 9px; border: 1px solid var(--lumiverse-border, #333); border-radius: 7px; overflow: hidden; }
.workshop-mock-group > summary { display: flex; align-items: center; gap: 8px; padding: 10px 8px; cursor: pointer; font-size: 11px; font-weight: 700; }
.workshop-mock-group > summary::before { content: '›'; flex: 0 0 auto; }
.workshop-mock-group[open] > summary::before { content: '⌄'; }
.workshop-mock-group > summary > span:first-of-type { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.workshop-mock-row { display: grid; grid-template-columns: minmax(0, 1fr) 28px; align-items: center; gap: 8px; padding: 8px; border-top: 1px solid var(--lumiverse-border, #333); }
.workshop-mock-title { grid-area: 1 / 1; min-height: 28px; padding: 0; border: 0; background: none; color: var(--lumiverse-text); font: inherit; font-size: 11px; text-align: left; line-height: 1.4; overflow-wrap: anywhere; cursor: pointer; }
.workshop-mock-row .workshop-sandbox { grid-area: 2 / 1 / 3 / -1; margin: 0; grid-template-columns: minmax(0, 1fr); align-items: center; }
.workshop-mock-row .workshop-sandbox:has(input[type="range"]) { grid-template-columns: minmax(0, 1fr) 4ch; }
.workshop-mock-row .workshop-sandbox:has(input[role="switch"]) { grid-template-columns: 38px minmax(0, 1fr); }
.workshop-mock-row .workshop-sandbox > input, .workshop-mock-row .workshop-sandbox > textarea, .workshop-mock-row .workshop-sandbox > select { grid-area: 1 / 1; }
.workshop-mock-row > .workshop-text-button { grid-area: 1 / 2; width: 28px; height: 28px; min-height: 28px; padding: 0; }
.workshop-mock-row > .workshop-text-button:disabled { visibility: hidden; }
.workshop-mock-current { grid-area: 1 / 2; font-size: 10px; color: var(--lumiverse-text-muted); font-variant-numeric: tabular-nums; }
.workshop-sandbox { display: grid; gap: 7px; margin: 12px 0 7px; font-size: 11px; }
.workshop-sandbox input:not([type="checkbox"]), .workshop-sandbox textarea, .workshop-sandbox select { box-sizing: border-box; width: 100%; min-width: 0; padding: 6px; color: var(--lumiverse-text); background: var(--lumiverse-bg-deep, #101014); border: 1px solid var(--lumiverse-border); border-radius: 5px; font: inherit; }
.workshop-sandbox input[role="switch"] { appearance: none; box-sizing: border-box; justify-self: start; width: 38px; height: 22px; margin: 0; padding: 2px; border: 1px solid var(--lumiverse-border, #555); border-radius: 999px; background: var(--lumiverse-bg-deep, #101014); cursor: pointer; transition: background .15s; }
.workshop-sandbox input[role="switch"]::before { content: ""; display: block; width: 16px; height: 16px; border-radius: 50%; background: var(--lumiverse-text-muted, #aaa); transition: transform .15s; }
.workshop-sandbox input[role="switch"]:checked { background: var(--lumiverse-primary, #aa88ef); }
.workshop-sandbox input[role="switch"]:checked::before { transform: translateX(16px); background: var(--lumiverse-text, #fff); }
.workshop-sandbox input[role="switch"]:focus-visible { outline: 2px solid var(--lumiverse-primary, #aa88ef); outline-offset: 3px; }
.workshop-sandbox select[multiple] { min-height: 80px; }
.workshop-variable-detail { margin: 3px 2px 10px; padding: 10px; border: 1px solid var(--lumiverse-border, rgba(255,255,255,.09)); border-radius: 10px; background: var(--lumiverse-bg-deep, #101014); }
.workshop-detail-heading { font-size: 12px; font-weight: 750; margin-bottom: 4px; }
.workshop-detail-macro-row { display: flex; gap: 5px; align-items: center; }
.workshop-code { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--lumiverse-primary-text, var(--lumiverse-text)); font: 10px var(--lumiverse-font-mono, ui-monospace, monospace); }
.workshop-copy { margin-left: auto; padding: 3px 6px; border: 1px solid var(--lumiverse-border); border-radius: 6px; background: transparent; color: var(--lumiverse-text-muted); cursor: pointer; font-size: 9px; }
.workshop-detail-grid { display: grid; grid-template-columns: 76px minmax(0,1fr); gap: 5px 8px; margin-top: 10px; font-size: 10px; }
.workshop-detail-key { color: var(--lumiverse-text-dim); }
.workshop-detail-value { min-width: 0; overflow-wrap: anywhere; color: var(--lumiverse-text); white-space: pre-line; }
.workshop-description { margin-top: 9px; color: var(--lumiverse-text-muted); font-size: 10px; line-height: 1.45; }
.workshop-link-button { display: block; width: 100%; margin-top: 4px; padding: 5px 7px; border: 1px solid var(--lumiverse-border, rgba(255,255,255,.08)); border-radius: 6px; background: transparent; color: var(--lumiverse-text); text-align: left; cursor: pointer; font-size: 9px; }
.workshop-review, .workshop-review * { box-sizing: border-box; }
.workshop-review { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--lumiverse-text, #eee); background: var(--lumiverse-bg, #141419); }
.workshop-review svg { width: 17px; height: 17px; flex: 0 0 auto; }
.workshop-review-header { display: flex; align-items: center; gap: 12px; padding: 12px 18px; border-bottom: 1px solid var(--lumiverse-border, #333); }
.workshop-review-brand { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
.workshop-review-brand > svg { width: 22px; height: 22px; color: var(--lumiverse-primary, #aa88ef); }
.workshop-review-brand h2 { margin: 0; font-size: 15px; }
.workshop-review-caption, .workshop-review-eyebrow { font-size: 10px; color: var(--lumiverse-text-muted, #aaa); }
.workshop-review-caption { display: block; margin-top: 3px; }
.workshop-review-progress { padding: 6px 10px; border: 1px solid var(--lumiverse-border, #333); border-radius: 999px; font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.workshop-review-issue { margin: 14px 18px; padding: 14px 16px; border: 1px solid var(--lumiverse-border, #333); border-left: 3px solid var(--lumiverse-warning, #e8b04c); border-radius: 10px; background: linear-gradient(var(--lumiverse-warning-015, rgba(232,176,76,.06)), var(--lumiverse-warning-015, rgba(232,176,76,.06))), var(--lumiverse-bg, #141419); font-size: 12px; line-height: 1.5; }
.workshop-review-issue.is-resolved { border-left-color: var(--lumiverse-primary, #aa88ef); }
.workshop-review-issue-head { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 8px; }
.workshop-review-eyebrow { display: inline-flex; align-items: center; gap: 6px; font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.workshop-review-state { margin-left: auto; padding: 3px 8px; border-radius: 6px; background: var(--lumiverse-warning-015, rgba(232,176,76,.12)); color: var(--lumiverse-warning, #e8b04c); font-size: 11px; font-weight: 650; }
.workshop-review-issue.is-resolved .workshop-review-state { color: var(--lumiverse-primary, #aa88ef); background: var(--lumiverse-primary-010, rgba(170,136,239,.12)); }
.workshop-review-state:empty { display: none; }
.workshop-review-issue h3 { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
.workshop-review-prompt { display: flex; align-items: center; gap: 6px; margin-top: 8px; color: var(--lumiverse-text-muted, #aaa); overflow-wrap: anywhere; }
.workshop-review-issue p { margin: 8px 0 0; }
.workshop-review-editor { flex: 1; min-height: 0; overflow: auto; border-top: 1px solid var(--lumiverse-border, #333); }
.workshop-review-editor > * { height: 100%; min-height: 0; }
.workshop-review-footer { display: grid; grid-template-columns: 1fr auto; gap: 12px 24px; padding: 14px 18px; border-top: 1px solid var(--lumiverse-border, #333); background: linear-gradient(rgba(128,128,160,.08), rgba(128,128,160,.08)), var(--lumiverse-bg, #141419); box-shadow: 0 -6px 24px rgba(0,0,0,.12); }
.workshop-review-controls { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.workshop-review-drafts { border-left: 1px solid var(--lumiverse-border, #333); padding-left: 24px; }
.workshop-review-button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 38px; padding: 8px 12px; border: 1px solid var(--lumiverse-border, #333); border-radius: 8px; background: var(--lumiverse-fill-subtle, rgba(128,128,160,.06)); color: var(--lumiverse-text, #eee); font: inherit; font-size: 12px; cursor: pointer; }
.workshop-review-button:hover:not(:disabled) { border-color: var(--lumiverse-primary, #aa88ef); background: var(--lumiverse-primary-010, rgba(170,136,239,.1)); }
.workshop-review-button:focus-visible { outline: 2px solid var(--lumiverse-primary, #aa88ef); outline-offset: 3px; }
.workshop-review-button:disabled { opacity: .4; cursor: default; }
.workshop-review-button.primary { background: var(--lumiverse-primary, #aa88ef); color: var(--lumiverse-primary-text, #101014); border-color: transparent; font-weight: 700; }
.workshop-review-button.primary:hover:not(:disabled) { background: var(--lumiverse-primary, #aa88ef); filter: brightness(1.08); }
.workshop-review-notice { grid-column: 1 / -1; font-size: 11px; color: var(--lumiverse-text-muted, #aaa); line-height: 1.4; }
.workshop-review-error { color: var(--lumiverse-warning, #e8b04c); }
@media (max-width: 600px) {
  .workshop-review-header { padding: 10px 12px; gap: 8px; }
  .workshop-review-caption { display: none; }
  .workshop-review-issue { margin: 10px 12px; padding: 10px 12px; }
  .workshop-review-footer { padding: 10px 12px; grid-template-columns: 1fr; gap: 10px; }
  .workshop-review-drafts { padding-left: 0; padding-top: 10px; border-left: 0; border-top: 1px solid var(--lumiverse-border, #333); }
  .workshop-review-button { min-height: 36px; padding: 7px 10px; }
}
.workshop-backup-list { flex: 1; min-height: 0; overflow: auto; padding: 0 18px 18px; }
.workshop-backup-row { display: flex; align-items: center; gap: 16px; padding: 16px; margin-bottom: 10px; border: 1px solid var(--lumiverse-border, #333); border-radius: 10px; }
.workshop-icon-button[data-backup-error] {position:relative;color:var(--lumiverse-warning,#e8b04c)}
.workshop-icon-button[data-backup-error]:after {content:"!";position:absolute;right:1px;top:0;font-size:11px;font-weight:750}
.workshop-backup-settings {padding:16px;margin:0 0 16px;border:1px solid var(--lumiverse-border);border-radius:12px;background:var(--lumiverse-bg);display:grid;grid-template-columns:1fr 1fr;gap:14px}
.workshop-backup-settings[hidden] {display:none}
.workshop-backup-settings h3,.workshop-backup-settings p,.workshop-backup-settings .workshop-review-controls,.workshop-backup-switch {grid-column:1 / -1;margin:0}
.workshop-backup-settings label {display:flex;flex-direction:column;gap:7px;font-size:12px}
.workshop-backup-settings p {font-size:11px;line-height:1.5;color:var(--lumiverse-text-muted)}
.workshop-backup-settings input[type=number] {width:100%;min-width:0;padding:10px;border:1px solid var(--lumiverse-border);border-radius:8px;background:var(--lumiverse-bg);color:var(--lumiverse-text)}
.workshop-backup-settings .workshop-backup-switch {flex-direction:row;align-items:center;gap:10px}
.workshop-backup-switch input {appearance:none;flex:0 0 auto;width:36px;height:22px;border:1px solid var(--lumiverse-border);border-radius:20px;background:var(--lumiverse-bg);position:relative;cursor:pointer}
.workshop-backup-switch input:before {content:'';position:absolute;width:16px;height:16px;left:2px;top:2px;border-radius:50%;background:var(--lumiverse-text-muted)}
.workshop-backup-switch input:checked {background:var(--lumiverse-primary,#aa88ef)}
.workshop-backup-switch input:checked:before {left:16px;background:var(--lumiverse-primary-text,#111)}
.workshop-backup-settings input:focus-visible {outline:2px solid var(--lumiverse-primary,#aa88ef);outline-offset:3px}
.workshop-backup-row > div { flex: 1; min-width: 0; }
.workshop-backup-row h3 { margin: 0; font-size: 14px; }
.workshop-backup-row p { font-size: 12px; color: var(--lumiverse-text-muted, #aaa); line-height: 1.5; }
.workshop-backup-row code { display: block; font-size: 10px; overflow-wrap: anywhere; color: var(--lumiverse-text-muted, #aaa); }
@media (max-width: 600px) { .workshop-backup-list { padding: 0 12px 12px; } .workshop-backup-row { flex-direction: column; align-items: stretch; padding: 12px; } }
.workshop-diagnostics { min-height: 0; }
.workshop-diagnostic-row { width: 100%; padding: 6px 7px; margin: 3px 0; border: 1px solid var(--lumiverse-warning-020, var(--lumiverse-border)); border-radius: 7px; background: var(--lumiverse-warning-015, rgba(255,180,0,.06)); color: var(--lumiverse-text); text-align: left; font-size: 9px; }
.workshop-diagnostic-title { display: block; font-weight: 700; }
.workshop-diagnostic-copy { display: block; margin-top: 2px; color: var(--lumiverse-text-muted); }
.workshop-mobile-only { display: none; }

@media (max-width: 1180px) {
  .workshop-native-form.workshop-variable-sidecar { display: block !important; }
  .workshop-native-form.workshop-variable-sidecar > .workshop-native-variable-root { position: static; max-height: none; overflow: visible; scrollbar-gutter: auto; padding-right: 0; }
}

@media (max-width: ${MOBILE_BREAKPOINT}px) {
  .workshop-mobile-only { display: inline-grid; }
  .workshop-header-status { display: none; }
  .workshop-preset-name { max-width: 48vw; }
  .workshop-variable-workspace,
  .workshop-variable-workspace.has-selection { grid-template-rows: repeat(2, minmax(180px, auto)); overflow: auto; }
  .workshop-variable-workspace.has-selection { grid-template-rows: repeat(3, minmax(180px, auto)); }
  .workshop-body,
  .workshop-shell.left-collapsed .workshop-body,
  .workshop-shell.right-collapsed .workshop-body { display: block; position: relative; }
  .workshop-center,
  .workshop-shell.preview-split:not(.preview-collapsed) .workshop-center { position: absolute; inset: 0; display: grid; grid-template-columns: 1fr; grid-template-rows: minmax(0, 1fr) 5px minmax(165px, 30vh); }
  .workshop-shell.preview-collapsed .workshop-center { grid-template-columns: 1fr; grid-template-rows: minmax(0, 1fr) 0 38px; }
  .workshop-editor-region,
  .workshop-shell.preview-split:not(.preview-collapsed) .workshop-editor-region { grid-column: 1; grid-row: 1; padding: 8px; }
  .workshop-preview-resizer,
  .workshop-shell.preview-split:not(.preview-collapsed) .workshop-preview-resizer { grid-column: 1; grid-row: 2; cursor: row-resize; }
  .workshop-preview,
  .workshop-shell.preview-split:not(.preview-collapsed) .workshop-preview { grid-column: 1; grid-row: 3; border-left: 0; border-top: 1px solid var(--lumiverse-border); }
  .workshop-editor-stage.dual { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) minmax(0, 1fr); }
  .workshop-primary-textarea { min-height: 300px !important; }
  .workshop-rail { background: linear-gradient(var(--lumiverse-bg-dark, #141419), var(--lumiverse-bg-dark, #141419)), var(--lumiverse-bg, #141419); position: absolute; top: 0; bottom: 0; z-index: 20; width: min(86vw, 360px) !important; visibility: visible !important; box-shadow: var(--lumiverse-shadow-lg, 0 12px 40px rgba(0,0,0,.35)); transition: transform 160ms ease; }
  .workshop-rail.left { left: 0; transform: translateX(-102%); }
  .workshop-rail.right { right: 0; transform: translateX(102%); }
  .workshop-shell.mobile-left-open .workshop-rail.left { transform: translateX(0); }
  .workshop-shell.mobile-right-open .workshop-rail.right { transform: translateX(0); }
  .workshop-resizer { display: none !important; }
  .left-collapsed .workshop-rail.left .workshop-rail-title,
  .left-collapsed .workshop-rail.left .workshop-count,
  .left-collapsed .workshop-rail.left .workshop-search-wrap,
  .left-collapsed .workshop-rail.left .workshop-scroll,
  .left-collapsed .workshop-rail.left .workshop-rail-note,
  .right-collapsed .workshop-rail.right [data-action="reset-mocks"],
  .right-collapsed .workshop-rail.right .workshop-rail-title,
  .right-collapsed .workshop-rail.right .workshop-count,
  .right-collapsed .workshop-rail.right .workshop-search-wrap,
  .right-collapsed .workshop-rail.right .workshop-scroll,
  .right-collapsed .workshop-rail.right .workshop-rail-note { display: initial; }
  .right-collapsed .workshop-rail.right .workshop-variable-workspace { display: grid; }
  .left-collapsed .workshop-rail-tools { display: inline-flex; }
  .workshop-rail-collapse { display: none; }
}
`;
var ICONS = {
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14"/></svg>',
  workshop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h16"/><path d="M6 20V8l6-4 6 4v12"/><path d="M9 20v-6h6v6"/><path d="M8 10h.01M16 10h.01"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
  right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.34 5.66"/><path d="M20 4v7h-7"/></svg>',
  split: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M13 4v16"/></svg>',
  bottom: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 13h18"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  columns: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg>',
  backups: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7h18v14H3Z M2 3h20v4H2Z M9 11h6"/></svg>',
  review: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="4" width="15" height="17" rx="2"/><path d="M9 4V2h7v2M8 10l1 1 2-2M14 10h3M8 16l1 1 2-2M14 16h3"/></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 10 18H2Z"/><path d="M12 9v4M12 17h.01"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>',
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10h11a7 7 0 0 1 0 14M3 10l5-5M3 10l5 5" transform="translate(0 -3)"/></svg>',
  chevronDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>'
};
function button(className, label, html) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = className;
  el.setAttribute("aria-label", label);
  el.title = label;
  el.innerHTML = html;
  return el;
}
function cloneBlocks(blocks) {
  return blocks.map((block) => ({
    ...block,
    injectionTrigger: [...block.injectionTrigger],
    characterTagTrigger: block.characterTagTrigger ? [...block.characterTagTrigger] : undefined,
    variables: block.variables?.map((variable) => {
      if (variable.type === "select" || variable.type === "multiselect") {
        return { ...variable, options: variable.options.map((option) => ({ ...option })) };
      }
      return { ...variable };
    })
  }));
}
function clonePromptVariableValues(values) {
  return Object.fromEntries(Object.entries(values).map(([blockId, blockValues]) => [
    blockId,
    Object.fromEntries(Object.entries(blockValues).map(([name, value]) => [
      name,
      Array.isArray(value) ? [...value] : value
    ]))
  ]));
}
function editorValueFromHost(ctx) {
  const full = ctx.ui.presetEditor.getState();
  const scoped = ctx.ui.presetEditor.extension.getState();
  if (!full.open || !full.preset || !full.presetId || scoped.presetId !== full.presetId)
    return null;
  return {
    blocks: cloneBlocks(scoped.blocks),
    promptVariableValues: clonePromptVariableValues(scoped.promptVariableValues)
  };
}
function formatDefinitionType(definition) {
  if (definition.type === "multiselect")
    return "Multi-select";
  if (definition.type === "textarea")
    return "Long text";
  return definition.type.charAt(0).toUpperCase() + definition.type.slice(1);
}
function formatDefault(definition) {
  if (definition.type === "select") {
    return definition.options.find((option) => option.id === definition.defaultValue)?.label ?? definition.defaultValue;
  }
  if (definition.type === "multiselect") {
    return definition.defaultValue.map((id) => definition.options.find((option) => option.id === id)?.label ?? id).join(", ") || "None selected";
  }
  if (definition.type === "switch")
    return definition.defaultValue === 1 ? "On" : "Off";
  return String(definition.defaultValue ?? "") || "Empty";
}
function messageContentText(message) {
  if (typeof message.content === "string")
    return message.content;
  return message.content.map((part) => {
    if (part.type === "text")
      return part.text;
    if (part.type === "image")
      return `[image: ${part.mime_type}]`;
    if (part.type === "audio")
      return `[audio: ${part.mime_type}]`;
    if (part.type === "tool_use") {
      let payload = "";
      try {
        payload = JSON.stringify(part.input, null, 2);
      } catch {
        payload = "[unserializable input]";
      }
      return `[tool call: ${part.name}]${payload ? `
${payload}` : ""}`;
    }
    return `[tool result${part.is_error ? " · error" : ""}]
${part.content}`;
  }).join(`

`);
}
function uniqueRequestId(sequence) {
  return `workshop-${Date.now().toString(36)}-${sequence.toString(36)}`;
}
function installFullscreenModalChrome(root) {
  const body = root.parentElement;
  const container = body?.parentElement;
  const backdrop = container?.parentElement;
  const hostHeader = body?.previousElementSibling;
  if (!(body instanceof HTMLElement) || !(container instanceof HTMLElement) || !(backdrop instanceof HTMLElement))
    return () => {};
  const targets = [body, container, backdrop, hostHeader].filter((entry) => entry instanceof HTMLElement);
  const snapshots = targets.map((element) => ({ element, style: element.getAttribute("style") }));
  Object.assign(backdrop.style, {
    alignItems: "stretch",
    justifyContent: "stretch",
    top: "var(--app-interactive-safe-top, 0px)",
    bottom: "auto",
    height: "var(--app-interactive-viewport-height, calc(100dvh - var(--app-interactive-safe-top, 0px)))",
    padding: "0"
  });
  Object.assign(container.style, { width: "100%", maxWidth: "none", height: "100%", maxHeight: "none", borderRadius: "0", border: "0" });
  Object.assign(body.style, { padding: "0", overflow: "hidden", minHeight: "0", height: "100%" });
  if (hostHeader instanceof HTMLElement)
    hostHeader.style.display = "none";
  return () => {
    for (const snapshot of snapshots) {
      if (snapshot.style === null)
        snapshot.element.removeAttribute("style");
      else
        snapshot.element.setAttribute("style", snapshot.style);
    }
  };
}
function createWorkshopSession(ctx, onClosed) {
  const initialState = ctx.ui.presetEditor.getState();
  const initialValue = editorValueFromHost(ctx);
  if (!initialState.open || !initialState.presetId || !initialState.preset || !initialValue)
    return null;
  const sessionPresetId = initialState.presetId;
  const modal = ctx.ui.showModal({
    title: "Workshop",
    width: window.innerWidth,
    maxHeight: window.innerHeight,
    persistent: true
  });
  const root = modal.root;
  const restoreHostModalChrome = installFullscreenModalChrome(root);
  root.className = "workshop-shell";
  root.tabIndex = -1;
  root.innerHTML = `
    <header class="workshop-header">
      <div class="workshop-header-left">
        <button class="workshop-icon-button workshop-mobile-only" type="button" data-action="mobile-left" aria-label="Open prompts">${ICONS.right}</button>
        <span class="workshop-header-brand">Workshop</span>
        <button class="workshop-text-button" type="button" data-action="agent" aria-pressed="false">Agent</button>
      </div>
      <span class="workshop-preset-name"></span>
      <div class="workshop-header-actions">
        <div class="workshop-header-status"><span class="workshop-dot"></span><span class="workshop-status-copy">Synced</span></div>
        <button class="workshop-text-button" type="button" data-action="apply-drafts" disabled>Apply</button>
        <button class="workshop-mini-button" type="button" data-action="discard-drafts" aria-label="Discard drafts" title="Discard all local prompt drafts" disabled>↶</button>
        <button class="workshop-icon-button" type="button" data-action="backups" aria-label="Preset backups" title="Preset backups">${ICONS.backups}</button>
        <button class="workshop-icon-button workshop-mobile-only" type="button" data-action="mobile-right" aria-label="Open variables">${ICONS.left}</button>
        <button class="workshop-icon-button" type="button" data-action="close" aria-label="Close Workshop">${ICONS.close}</button>
      </div>
    </header>
    <span class="workshop-agent-sr-only" data-role="automatic-backup-notice" role="status"></span>
    <div class="workshop-draft-error" data-role="draft-notice" role="alert" hidden></div>
    <div class="workshop-body">
      <aside class="workshop-rail left">
        <div class="workshop-rail-header">
          <span class="workshop-rail-title">PROMPTS</span>
          <span class="workshop-count" data-role="prompt-count"></span>
          <span class="workshop-rail-tools">
            <button class="workshop-mini-button" type="button" data-action="manage-prompts" aria-label="Manage prompts" title="Manage prompts">${ICONS.plus}</button>
            <button class="workshop-mini-button" type="button" data-action="toggle-categories" aria-label="Collapse all categories" title="Collapse all categories">${ICONS.right}</button>
          </span>
          <button class="workshop-mini-button workshop-rail-collapse" type="button" data-action="left" aria-label="Collapse prompts">${ICONS.left}</button>
        </div>
        <div class="workshop-search-wrap"><input class="workshop-search" data-role="prompt-search" type="search" placeholder="Search prompts…" aria-label="Search prompts"></div>
        <div class="workshop-scroll" data-role="prompt-list"></div>
        <div class="workshop-rail-note" data-role="prompt-note"></div>
      </aside>
      <div class="workshop-resizer left" data-resize="left" aria-hidden="true"></div>
      <main class="workshop-center">
        <section class="workshop-editor-region">
          <div class="workshop-preset-tools" role="group" aria-label="Preset tools"><button type="button" class="workshop-text-button" data-action="find-replace">Find and replace</button></div>
          <div class="workshop-editor-stage" data-role="editor-stage">
            <div class="workshop-editor-slot primary" data-role="primary-editor-slot">
              <div data-role="editor-mount"></div>
              <div class="workshop-editor-empty" data-role="editor-empty">
                <div class="workshop-empty-card"><strong>Select a prompt</strong><span>Choose a block from the prompt rail, or jump here from a variable dependency.</span></div>
              </div>
            </div>
            <div class="workshop-editor-slot secondary" data-role="secondary-editor-slot" hidden>
              <div data-role="secondary-editor-mount"></div>
            </div>
          </div>
        </section>
        <div class="workshop-preview-resizer" data-resize="preview" aria-hidden="true"></div>
        <section class="workshop-preview">
          <div class="workshop-preview-toolbar">
            <span class="workshop-preview-label">PREVIEW</span>
            <div class="workshop-segment" data-role="preview-tabs">
              <button type="button" data-preview-tab="resolved" aria-pressed="false">Resolved</button>
              <button type="button" data-preview-tab="stack" class="active" aria-pressed="true">Stack</button>
              <button type="button" data-preview-tab="reference" aria-pressed="false">Reference</button>
            </div>
            <input class="workshop-preview-search" data-role="preview-search" type="search" placeholder="Search dry run…" aria-label="Search dry run">
            <span class="workshop-preview-status" data-role="preview-status"></span>
            <span class="spacer"></span>
            <button class="workshop-text-button" type="button" data-action="preview-entries-collapse">Collapse</button>
            <button class="workshop-icon-button" type="button" data-action="refresh" aria-label="Refresh preview">${ICONS.refresh}</button>
            <button class="workshop-icon-button" type="button" data-action="preview-layout" aria-label="Move preview to the side">${ICONS.split}</button>
            <button class="workshop-text-button" type="button" data-action="preview-collapse">Hide</button>
          </div>
          <div class="workshop-preview-content" data-role="preview-content"></div>
        </section>
      </main>
      <div class="workshop-resizer right" data-resize="right" aria-hidden="true"></div>
      <aside class="workshop-rail right">
        <div class="workshop-rail-header">
          <button class="workshop-mini-button workshop-rail-collapse" type="button" data-action="right" aria-label="Collapse variables">${ICONS.right}</button>
          <span class="workshop-rail-title">VARIABLES</span>
          <span class="workshop-count" data-role="variable-count"></span>
          <button class="workshop-text-button" type="button" data-action="reset-mocks" disabled>Reset mocks</button>
        </div>
        <div class="workshop-search-wrap"><input class="workshop-search" data-role="variable-search" type="search" placeholder="Search variables…" aria-label="Search variables"></div>
        <div class="workshop-variable-workspace" data-role="variable-list"></div>
      </aside>
    </div>
  `;
  const presetName = root.querySelector(".workshop-preset-name");
  const statusDot = root.querySelector(".workshop-dot");
  const statusCopy = root.querySelector(".workshop-status-copy");
  const promptCount = root.querySelector('[data-role="prompt-count"]');
  const promptSearch = root.querySelector('[data-role="prompt-search"]');
  const promptList = root.querySelector('[data-role="prompt-list"]');
  const promptNote = root.querySelector('[data-role="prompt-note"]');
  const variableCount = root.querySelector('[data-role="variable-count"]');
  const variableSearch = root.querySelector('[data-role="variable-search"]');
  const variableList = root.querySelector('[data-role="variable-list"]');
  const editorStage = root.querySelector('[data-role="editor-stage"]');
  const primarySlot = root.querySelector('[data-role="primary-editor-slot"]');
  const secondarySlot = root.querySelector('[data-role="secondary-editor-slot"]');
  const editorMount = root.querySelector('[data-role="editor-mount"]');
  const secondaryEditorMount = root.querySelector('[data-role="secondary-editor-mount"]');
  const editorEmpty = root.querySelector('[data-role="editor-empty"]');
  const previewStatus = root.querySelector('[data-role="preview-status"]');
  const previewContent = root.querySelector('[data-role="preview-content"]');
  const previewSearch = root.querySelector('[data-role="preview-search"]');
  const previewElement = root.querySelector(".workshop-preview");
  const previewLayoutButton = root.querySelector('[data-action="preview-layout"]');
  const previewEntriesCollapseButton = root.querySelector('[data-action="preview-entries-collapse"]');
  const previewCollapseButton = root.querySelector('[data-action="preview-collapse"]');
  const leftRailButton = root.querySelector('[data-action="left"]');
  const rightRailButton = root.querySelector('[data-action="right"]');
  const previewResizer = root.querySelector('[data-resize="preview"]');
  let structureDraftsPending = false;
  let closePromptManager = null;
  let findReplacePending = false;
  let closeFindReplace = null;
  const issueReview = new WorkshopIssueReview;
  let pendingRestore = null;
  let agentWorkspace = null;
  let agentDraftsPending = false;
  let agentBaseline = null;
  let closeBackups = null;
  let closeIssueReview = null;
  let activeReviewSurface = null;
  const variableSandbox = new WorkshopVariableSandbox;
  let destroyed = false;
  let canonicalValue = initialValue;
  let primaryEditorBase = initialValue.blocks;
  let secondaryEditorBase = initialValue.blocks;
  let applyingDrafts = false;
  let primaryDraftValue = null;
  let secondaryDraftValue = null;
  let selectedBlockId = null;
  let secondaryBlockId = null;
  let selectedVariableName = null;
  let promptQuery = "";
  let variableQuery = "";
  let sandboxFormMode = true;
  const openVariableGroups = new Set;
  let previewTab = "stack";
  let previewQuery = "";
  let previewEntriesCollapsed = false;
  let previewCollapsed = false;
  let previewSplit = false;
  let expandedVariablePane = null;
  let previewTimer = null;
  let previewSequence = 0;
  let activePreviewRequestId = null;
  let previewResult = null;
  let previewError = null;
  let previewLoading = false;
  let lastChatId = ctx.getActiveChat().chatId;
  let latestPresetName = initialState.preset.name;
  let derivedValue = overlaySelectedDrafts(canonicalValue, [
    { selectedBlockId, value: primaryDraftValue },
    { selectedBlockId: secondaryBlockId, value: secondaryDraftValue }
  ]);
  let derivedIndex = buildVariableIndex(derivedValue.blocks, derivedValue.promptVariableValues);
  const collapsedCategories = new Set;
  const variablePaneScroll = new Map;
  const cleanups = [restoreHostModalChrome];
  const referenceView = new ReferenceView(ctx, sessionPresetId);
  previewElement.append(referenceView.element);
  cleanups.push(() => referenceView.destroy());
  let editor;
  let secondaryEditor;
  function recomputeDerived() {
    derivedValue = overlaySelectedDrafts(localValue(), [
      { selectedBlockId, value: primaryDraftValue },
      { selectedBlockId: secondaryBlockId, value: secondaryDraftValue }
    ]);
    variableSandbox.overlay(derivedValue.blocks, derivedValue.promptVariableValues);
    derivedIndex = buildVariableIndex(derivedValue.blocks, derivedValue.promptVariableValues);
    const resetMocks = root.querySelector('[data-action="reset-mocks"]');
    resetMocks.disabled = variableSandbox.size === 0;
    resetMocks.textContent = variableSandbox.size ? `Reset mocks (${variableSandbox.size})` : "Reset mocks";
  }
  function localValue() {
    return { blocks: issueReview.overlay(baseBlocks()), promptVariableValues: canonicalValue.promptVariableValues };
  }
  function baseBlocks() {
    return pendingRestore?.preset.blocks ?? canonicalValue.blocks;
  }
  function effectiveValue() {
    return derivedValue;
  }
  function variableIndex() {
    return derivedIndex;
  }
  function blockById(blockId) {
    if (!blockId)
      return null;
    return effectiveValue().blocks.find((block) => block.id === blockId) ?? null;
  }
  function selectedBlock() {
    return blockById(selectedBlockId);
  }
  function secondaryBlock() {
    return blockById(secondaryBlockId);
  }
  function setDraftStatus() {
    const draftCount = Number(Boolean(pendingRestore)) + new Set([...issueReview.blockIds, ...primaryDraftValue && selectedBlockId ? [selectedBlockId] : [], ...secondaryDraftValue && secondaryBlockId ? [secondaryBlockId] : []]).size;
    root.classList.toggle("has-unsynced", draftCount > 0);
    const apply = root.querySelector('[data-action="apply-drafts"]');
    apply.textContent = agentDraftsPending ? "Apply drafts" : structureDraftsPending ? "Apply changes" : pendingRestore ? "Apply restore" : `Apply (${draftCount})`;
    apply.disabled = draftCount === 0 || applyingDrafts;
    root.querySelector('[data-action="discard-drafts"]').disabled = draftCount === 0 || applyingDrafts;
    statusDot.classList.toggle("is-draft", draftCount > 0);
    statusCopy.textContent = agentDraftsPending ? "Unsynced agent drafts" : structureDraftsPending ? "Unsynced prompt list" : pendingRestore ? "Unsynced preset restore" : draftCount === 0 ? "Synced" : draftCount === 1 ? "1 unsynced prompt" : `${draftCount} unsynced prompts`;
  }
  function closeMobileRails() {
    root.classList.remove("mobile-left-open", "mobile-right-open");
  }
  function captureHostScroll() {
    const snapshots = [];
    let cursor = root.parentElement;
    while (cursor) {
      if (cursor.scrollHeight > cursor.clientHeight || cursor.scrollWidth > cursor.clientWidth || cursor.scrollTop || cursor.scrollLeft) {
        snapshots.push({ element: cursor, top: cursor.scrollTop, left: cursor.scrollLeft });
      }
      cursor = cursor.parentElement;
    }
    return snapshots;
  }
  function restoreScroll(snapshots) {
    for (const snapshot of snapshots) {
      if (!snapshot.element.isConnected)
        continue;
      const maxTop = Math.max(0, snapshot.element.scrollHeight - snapshot.element.clientHeight);
      const maxLeft = Math.max(0, snapshot.element.scrollWidth - snapshot.element.clientWidth);
      snapshot.element.scrollTop = Math.min(snapshot.top, maxTop);
      snapshot.element.scrollLeft = Math.min(snapshot.left, maxLeft);
    }
  }
  function preserveHostScrollThroughSelection(work) {
    const snapshots = captureHostScroll();
    work();
    restoreScroll(snapshots);
    requestAnimationFrame(() => {
      if (destroyed)
        return;
      restoreScroll(snapshots);
      requestAnimationFrame(() => {
        if (!destroyed)
          restoreScroll(snapshots);
      });
    });
  }
  function retainEditorDrafts(slots) {
    for (const slot of new Set(slots)) {
      const value = slot === "primary" ? primaryDraftValue : secondaryDraftValue;
      const id = slot === "primary" ? selectedBlockId : secondaryBlockId;
      const base = slot === "primary" ? primaryEditorBase : secondaryEditorBase;
      if (value && id && !issueReview.stage(base, value.blocks, id)) {
        reportWriteFailure(id, "ambiguous local draft");
        return false;
      }
      if (slot === "primary")
        primaryDraftValue = null;
      else
        secondaryDraftValue = null;
    }
    return true;
  }
  function applySelectedBlock(blockId) {
    if (blockId === selectedBlockId)
      return;
    preserveHostScrollThroughSelection(() => {
      if (blockId && blockId === secondaryBlockId) {
        secondaryBlockId = null;
        secondaryDraftValue = null;
        secondaryEditor.update({ selectedBlockId: null });
      }
      primaryDraftValue = null;
      selectedBlockId = blockId;
      primaryEditorBase = baseBlocks();
      recomputeDerived();
      editor.update({ value: localValue(), selectedBlockId: blockId });
      renderEditorVisibility();
      renderPrompts();
      renderVariables();
      setDraftStatus();
      scheduleNativeDecoration();
      schedulePreview();
      closeMobileRails();
    });
  }
  async function requestSelectedBlock(blockId) {
    if (agentWorkspace) {
      agentWorkspace.selectBlock(blockId);
      return;
    }
    if (blockId !== null && !baseBlocks().some((block) => block.id === blockId))
      return;
    if (blockId === selectedBlockId)
      return;
    const discarded = draftSlotsDiscardedBySelection({
      primaryBlockId: selectedBlockId,
      secondaryBlockId,
      primaryDirty: primaryDraftValue !== null,
      secondaryDirty: secondaryDraftValue !== null
    }, "primary", blockId);
    if (!retainEditorDrafts(discarded))
      return;
    applySelectedBlock(blockId);
  }
  function applySecondaryBlock(blockId) {
    if (blockId === secondaryBlockId)
      return;
    preserveHostScrollThroughSelection(() => {
      secondaryDraftValue = null;
      secondaryBlockId = blockId;
      secondaryEditorBase = baseBlocks();
      recomputeDerived();
      secondaryEditor.update({ value: localValue(), selectedBlockId: blockId });
      renderEditorVisibility();
      renderPrompts();
      renderVariables();
      setDraftStatus();
      scheduleNativeDecoration();
      schedulePreview();
      closeMobileRails();
    });
  }
  async function requestSecondaryBlock(blockId) {
    if (blockId !== null) {
      const block = baseBlocks().find((entry) => entry.id === blockId);
      if (!block || block.marker === "category" || blockId === selectedBlockId)
        return;
    }
    if (blockId === secondaryBlockId)
      return;
    const discarded = draftSlotsDiscardedBySelection({
      primaryBlockId: selectedBlockId,
      secondaryBlockId,
      primaryDirty: primaryDraftValue !== null,
      secondaryDirty: secondaryDraftValue !== null
    }, "secondary", blockId);
    if (!retainEditorDrafts(discarded))
      return;
    applySecondaryBlock(blockId);
  }
  function renderEditorVisibility() {
    root.querySelector(".workshop-preset-tools").hidden = Boolean(selectedBlockId || secondaryBlockId || agentWorkspace);
    const dual = Boolean(selectedBlockId && secondaryBlockId);
    editorStage.classList.toggle("dual", dual);
    primarySlot.classList.toggle("dual-slot", dual);
    secondarySlot.hidden = !secondaryBlockId;
    editorMount.style.display = selectedBlockId ? "" : "none";
    editorEmpty.style.display = selectedBlockId ? "none" : "";
  }
  function refreshRailButtons() {
    const leftCollapsed = root.classList.contains("left-collapsed");
    const rightCollapsed = root.classList.contains("right-collapsed");
    leftRailButton.innerHTML = leftCollapsed ? ICONS.right : ICONS.left;
    leftRailButton.title = leftCollapsed ? "Expand prompts" : "Collapse prompts";
    leftRailButton.setAttribute("aria-label", leftRailButton.title);
    rightRailButton.innerHTML = rightCollapsed ? ICONS.left : ICONS.right;
    rightRailButton.title = rightCollapsed ? "Expand variables" : "Collapse variables";
    rightRailButton.setAttribute("aria-label", rightRailButton.title);
  }
  function renderPrompts() {
    root.querySelector('[data-action="manage-prompts"]').disabled = applyingDrafts || Boolean(agentWorkspace);
    root.querySelector(".workshop-preset-tools").hidden = Boolean(selectedBlockId || secondaryBlockId || agentWorkspace);
    const activeBlockId = agentWorkspace?.selectedBlockId ?? selectedBlockId;
    const previousScrollTop = promptList.scrollTop;
    const previousScrollLeft = promptList.scrollLeft;
    const value = effectiveValue();
    const index = variableIndex();
    const query = promptQuery.trim().toLowerCase();
    const selectedVariable = selectedVariableName ? index.byName.get(selectedVariableName) : undefined;
    const owners = new Set(selectedVariable?.definitions.map((definition) => definition.blockId) ?? []);
    const refs = new Set(selectedVariable?.references.map((reference) => reference.blockId) ?? []);
    promptList.replaceChildren();
    let visible = 0;
    const blockMatches = (block) => !query || promptBlockSearchText(block).includes(query);
    const makeMeta = (block) => {
      const stats = blockVariableStats(block);
      const meta = document.createElement("span");
      meta.className = "workshop-row-meta";
      if (stats.definitions > 0) {
        const pill = document.createElement("span");
        pill.className = "workshop-pill define";
        pill.textContent = `D${stats.definitions}`;
        pill.title = `${stats.definitions} variable definition${stats.definitions === 1 ? "" : "s"}`;
        meta.append(pill);
      }
      if (stats.references > 0) {
        const pill = document.createElement("span");
        pill.className = "workshop-pill";
        pill.textContent = `V${stats.references}`;
        pill.title = `${stats.references} referenced variable${stats.references === 1 ? "" : "s"}`;
        meta.append(pill);
      }
      return meta;
    };
    const appendPromptRow = (block, child) => {
      visible += 1;
      const wrap = document.createElement("div");
      wrap.className = "workshop-row-wrap";
      const row = document.createElement("button");
      row.type = "button";
      row.className = `workshop-row${child ? " child" : ""}`;
      if (block.id === activeBlockId) {
        row.classList.add("selected");
        row.setAttribute("aria-current", "true");
      }
      if (!agentWorkspace && block.id === secondaryBlockId)
        row.classList.add("secondary-selected");
      if (owners.has(block.id))
        row.classList.add("variable-owner");
      if (refs.has(block.id))
        row.classList.add("variable-reference");
      row.dataset.blockId = block.id;
      const name = document.createElement("span");
      name.className = "workshop-row-name";
      name.textContent = block.name || "(Untitled block)";
      row.append(name, makeMeta(block));
      row.addEventListener("click", () => {
        requestSelectedBlock(block.id);
      });
      wrap.append(row);
      if (!agentWorkspace && selectedBlockId && block.id !== selectedBlockId) {
        const split = button("workshop-mini-button", block.id === secondaryBlockId ? "Close second prompt" : `Open ${block.name || "prompt"} beside current prompt`, block.id === secondaryBlockId ? ICONS.close : ICONS.columns);
        split.addEventListener("click", () => {
          requestSecondaryBlock(block.id === secondaryBlockId ? null : block.id);
        });
        wrap.append(split);
      }
      promptList.append(wrap);
    };
    for (const group of computePromptGroups(value.blocks)) {
      const category = group.categoryBlock;
      const matchingChildren = query ? group.children.filter(blockMatches) : group.children;
      const categoryMatches = category ? blockMatches(category) : false;
      if (query && !categoryMatches && matchingChildren.length === 0)
        continue;
      if (category) {
        visible += 1;
        const wrap = document.createElement("div");
        wrap.className = "workshop-row-wrap category-wrap";
        const collapsed = collapsedCategories.has(category.id) && !query;
        const toggle = button("workshop-category-toggle", `${collapsed ? "Expand" : "Collapse"} ${category.name || "category"}`, `<span class="workshop-category-chevron${collapsed ? " collapsed" : ""}">${ICONS.chevronDown}</span>`);
        toggle.setAttribute("aria-expanded", String(!collapsed));
        toggle.dataset.categoryId = category.id;
        toggle.addEventListener("click", () => {
          if (collapsedCategories.has(category.id))
            collapsedCategories.delete(category.id);
          else
            collapsedCategories.add(category.id);
          renderPrompts();
          Array.from(promptList.querySelectorAll(".workshop-category-toggle")).find((button) => button.dataset.categoryId === category.id)?.focus({ preventScroll: true });
        });
        wrap.append(toggle);
        const row = document.createElement("button");
        row.type = "button";
        row.className = "workshop-row category";
        if (category.id === activeBlockId) {
          row.classList.add("selected");
          row.setAttribute("aria-current", "true");
        }
        if (owners.has(category.id))
          row.classList.add("variable-owner");
        if (refs.has(category.id))
          row.classList.add("variable-reference");
        const name = document.createElement("span");
        name.className = "workshop-row-name";
        name.textContent = category.name || "(Untitled category)";
        row.append(name, makeMeta(category));
        row.addEventListener("click", () => {
          requestSelectedBlock(category.id);
        });
        wrap.append(row);
        promptList.append(wrap);
        if (!collapsed) {
          for (const child of query ? matchingChildren : group.children)
            appendPromptRow(child, true);
        }
        continue;
      }
      for (const child of query ? matchingChildren : group.children)
        appendPromptRow(child, false);
    }
    const categoryIds = computePromptGroups(value.blocks).map((group) => group.categoryBlock?.id ?? null).filter((id) => Boolean(id));
    const allCategoriesCollapsed = categoryIds.length > 0 && categoryIds.every((id) => collapsedCategories.has(id));
    const categoryBulkButton = root.querySelector('[data-action="toggle-categories"]');
    categoryBulkButton.setAttribute("aria-label", allCategoriesCollapsed ? "Expand all categories" : "Collapse all categories");
    categoryBulkButton.title = allCategoriesCollapsed ? "Expand all categories" : "Collapse all categories";
    categoryBulkButton.innerHTML = allCategoriesCollapsed ? ICONS.chevronDown : ICONS.right;
    promptCount.textContent = `${visible}/${value.blocks.length}`;
    promptNote.textContent = selectedVariable ? "Variable map: owner blocks use the primary marker; reference blocks use the warning marker." : `${index.definitionCount} definitions · ${index.referenceCount} references`;
    promptList.scrollTop = Math.min(previousScrollTop, Math.max(0, promptList.scrollHeight - promptList.clientHeight));
    promptList.scrollLeft = Math.min(previousScrollLeft, Math.max(0, promptList.scrollWidth - promptList.clientWidth));
  }
  function refreshSandbox() {
    const activeVariable = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.mockVariable : undefined;
    recomputeDerived();
    renderVariables();
    if (activeVariable) {
      const replacement = [...root.querySelectorAll("[data-mock-variable]")].find((element) => element.dataset.mockVariable === activeVariable);
      replacement?.focus({ preventScroll: true });
    }
    schedulePreview();
  }
  root.querySelector('[data-action="reset-mocks"]').addEventListener("click", () => {
    variableSandbox.reset();
    refreshSandbox();
  });
  function appendSandboxControl(detail, entry, compact = false) {
    const label = document.createElement(compact ? "div" : "label");
    label.className = "workshop-sandbox";
    const title = document.createElement("span");
    title.textContent = "Mock value · preview only";
    if (!compact)
      label.append(title);
    const primary = entry.definitions[0];
    const definition = primary.definition;
    if (entry.duplicateDefinition || variableIndex().duplicateBlockIds.includes(primary.blockId)) {
      const warning = document.createElement("div");
      warning.textContent = "Resolve duplicate definitions or block IDs to mock this variable.";
      label.append(warning);
      detail.append(label);
      return;
    }
    const values = variableSandbox.overlay(effectiveValue().blocks, effectiveValue().promptVariableValues);
    const value = values[primary.blockId]?.[entry.name] ?? primary.storedValue;
    let control;
    let read;
    if (definition.type === "select" || definition.type === "multiselect") {
      const select = document.createElement("select");
      select.multiple = definition.type === "multiselect";
      for (const option of definition.options) {
        const item = document.createElement("option");
        item.value = option.id;
        item.textContent = option.label;
        item.selected = Array.isArray(value) ? value.includes(option.id) : value === option.id;
        select.append(item);
      }
      control = select;
      read = () => select.multiple ? [...select.selectedOptions].map((option) => option.value) : select.value;
    } else if (definition.type === "textarea") {
      const textarea = document.createElement("textarea");
      textarea.rows = definition.rows ?? 3;
      textarea.value = String(value);
      control = textarea;
      read = () => textarea.value;
    } else {
      const input = document.createElement("input");
      input.type = definition.type === "switch" ? "checkbox" : definition.type === "slider" ? "range" : definition.type === "number" ? "number" : "text";
      if (definition.type === "switch")
        input.setAttribute("role", "switch");
      input.checked = value === 1 || value === "1";
      if (definition.type === "number" || definition.type === "slider") {
        if (definition.min !== undefined)
          input.min = String(definition.min);
        if (definition.max !== undefined)
          input.max = String(definition.max);
        input.step = String(definition.step ?? (definition.type === "slider" ? 1 : "any"));
      }
      input.value = String(value);
      control = input;
      read = () => input.type === "checkbox" ? Number(input.checked) : input.type === "number" || input.type === "range" ? input.valueAsNumber : input.value;
    }
    control.dataset.mockVariable = entry.name;
    control.setAttribute("aria-label", `Mock ${definition.label || entry.name}`);
    control.addEventListener("change", () => {
      if (!control.checkValidity()) {
        control.reportValidity();
        return;
      }
      if (variableSandbox.set(entry, read()))
        refreshSandbox();
    });
    label.append(control);
    detail.append(label);
    const described = describePromptVariableValue(definition, value);
    const resolved = document.createElement("div");
    resolved.className = "workshop-description";
    resolved.textContent = `Preview resolves: ${described.resolved || "Empty"}`;
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "workshop-text-button";
    reset.textContent = compact ? "↶" : "Reset mock";
    reset.setAttribute("aria-label", compact ? `Reset mock ${definition.label || entry.name}` : "Reset mock");
    reset.title = "Reset mock";
    reset.disabled = !variableSandbox.has(entry.name);
    reset.addEventListener("click", () => {
      variableSandbox.reset(entry.name);
      refreshSandbox();
    });
    if (compact) {
      detail.append(reset);
      if (definition.type === "switch" || definition.type === "slider") {
        const valueLabel = document.createElement("span");
        valueLabel.className = "workshop-mock-current";
        valueLabel.textContent = described.display;
        label.append(valueLabel);
      }
    } else
      detail.append(resolved, reset);
  }
  function appendDefinitionDetail(container, entry) {
    const primary = entry.definitions[0];
    if (!primary)
      return;
    const detail = document.createElement("div");
    detail.className = "workshop-variable-detail";
    const heading = document.createElement("div");
    heading.className = "workshop-detail-heading";
    heading.textContent = primary.definition.label || entry.name;
    detail.append(heading);
    const macroRow = document.createElement("div");
    macroRow.className = "workshop-detail-macro-row";
    const macro = document.createElement("span");
    macro.className = "workshop-code";
    macro.textContent = entry.macro;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "workshop-copy";
    copy.textContent = "Copy";
    copy.addEventListener("click", (event) => {
      event.stopPropagation();
      copyText(entry.macro).then(() => {
        copy.textContent = "Copied";
        setTimeout(() => {
          if (!destroyed)
            copy.textContent = "Copy";
        }, 900);
      });
    });
    macroRow.append(macro, copy);
    detail.append(macroRow);
    const grid = document.createElement("div");
    grid.className = "workshop-detail-grid";
    const pairs = [
      ["Type", formatDefinitionType(primary.definition)],
      ["Default", formatDefault(primary.definition)],
      ["Current", primary.displayValue],
      ["Resolves", primary.resolvedValue || "Empty"]
    ];
    if (primary.definition.type === "select" || primary.definition.type === "multiselect") {
      pairs.push(["Options", primary.definition.options.map((option) => option.label === option.value ? option.label : `${option.label} → ${option.value}`).join(`
`) || "None"]);
    } else if (primary.definition.type === "number" || primary.definition.type === "slider") {
      const range = [
        primary.definition.min !== undefined ? `min ${primary.definition.min}` : null,
        primary.definition.max !== undefined ? `max ${primary.definition.max}` : null,
        primary.definition.step !== undefined ? `step ${primary.definition.step}` : null
      ].filter(Boolean).join(" · ");
      if (range)
        pairs.push(["Range", range]);
    }
    for (const [key, value] of pairs) {
      const k = document.createElement("div");
      k.className = "workshop-detail-key";
      k.textContent = key;
      const v = document.createElement("div");
      v.className = "workshop-detail-value";
      v.textContent = value;
      grid.append(k, v);
    }
    detail.append(grid);
    if (!sandboxFormMode)
      appendSandboxControl(detail, entry);
    else {
      const values = variableSandbox.overlay(effectiveValue().blocks, effectiveValue().promptVariableValues);
      const mockValue = values[primary.blockId]?.[entry.name] ?? primary.storedValue;
      const summary = document.createElement("div");
      summary.className = "workshop-description";
      summary.textContent = `Preview value: ${describePromptVariableValue(primary.definition, mockValue).display}`;
      detail.append(summary);
    }
    if (primary.definition.description) {
      const description = document.createElement("div");
      description.className = "workshop-description";
      description.textContent = primary.definition.description;
      detail.append(description);
    }
    const ownerLabel = document.createElement("div");
    ownerLabel.className = "workshop-section-label";
    ownerLabel.textContent = entry.definitions.length > 1 ? "DEFINED BY" : "DEFINED IN";
    detail.append(ownerLabel);
    for (const definition of entry.definitions) {
      const jump = document.createElement("button");
      jump.type = "button";
      jump.className = "workshop-link-button";
      jump.textContent = definition.blockName;
      jump.addEventListener("click", () => {
        requestSelectedBlock(definition.blockId);
      });
      detail.append(jump);
    }
    const refsLabel = document.createElement("div");
    refsLabel.className = "workshop-section-label";
    refsLabel.textContent = `REFERENCED BY · ${entry.references.reduce((sum, ref) => sum + ref.count, 0)}×`;
    detail.append(refsLabel);
    if (entry.references.length === 0) {
      const none = document.createElement("div");
      none.className = "workshop-description";
      none.textContent = "No prompt content currently references this variable.";
      detail.append(none);
    } else {
      for (const reference of entry.references) {
        const jump = document.createElement("button");
        jump.type = "button";
        jump.className = "workshop-link-button";
        jump.textContent = `${reference.blockName} · ${reference.count}×`;
        jump.title = reference.macros.join(`
`);
        jump.addEventListener("click", () => {
          requestSelectedBlock(reference.blockId);
        });
        detail.append(jump);
      }
    }
    container.append(detail);
  }
  function refreshLocalDrafts() {
    if (destroyed || !root.isConnected)
      return;
    if (!retainEditorDrafts(["primary", "secondary"]))
      return;
    recomputeDerived();
    presetName.textContent = pendingRestore?.preset.name ?? latestPresetName;
    editor.update({ value: localValue(), selectedBlockId });
    secondaryEditor.update({ value: localValue(), selectedBlockId: secondaryBlockId });
    renderPrompts();
    renderVariables();
    setDraftStatus();
    schedulePreview();
    scheduleNativeDecoration();
    agentWorkspace?.refresh();
  }
  function discardLocalDrafts() {
    structureDraftsPending = false;
    findReplacePending = false;
    issueReview.clear();
    pendingRestore = null;
    agentDraftsPending = false;
    primaryDraftValue = null;
    secondaryDraftValue = null;
    if (!baseBlocks().some((block) => block.id === selectedBlockId))
      selectedBlockId = null;
    if (!baseBlocks().some((block) => block.id === secondaryBlockId))
      secondaryBlockId = null;
    editor.destroy();
    secondaryEditor.destroy();
    primaryEditorBase = baseBlocks();
    secondaryEditorBase = baseBlocks();
    editor = mountEditorLane("primary");
    secondaryEditor = mountEditorLane("secondary");
    root.querySelector('[data-role="draft-notice"]').hidden = true;
    root.classList.remove("has-draft-error");
    renderEditorVisibility();
    refreshLocalDrafts();
  }
  async function applyLocalDrafts() {
    if (applyingDrafts)
      return "A batch is already being applied.";
    if (agentWorkspace?.busy)
      return "Stop the agent or wait for it to finish before Apply.";
    if (agentWorkspace || agentDraftsPending) {
      const confirmed = await confirmAgentApply(activeReviewSurface ?? root);
      if (!confirmed || destroyed)
        return "Apply cancelled. Drafts remain local.";
      if (applyingDrafts || agentWorkspace?.busy)
        return "The workspace changed during confirmation. Try Apply again.";
    }
    if (!retainEditorDrafts(["primary", "secondary"]))
      return "A prompt draft has an ambiguous identity.";
    if (issueReview.size === 0 && !pendingRestore) {
      refreshLocalDrafts();
      return null;
    }
    const host = ctx.ui.presetEditor.getState();
    if (!host.open || !host.preset || host.presetId !== sessionPresetId)
      return "The active preset changed. Reopen Workshop.";
    let applied = false;
    let conflict = null;
    applyingDrafts = true;
    root.inert = true;
    root.setAttribute("aria-busy", "true");
    if (activeReviewSurface) {
      activeReviewSurface.inert = true;
      activeReviewSurface.setAttribute("aria-busy", "true");
    }
    setDraftStatus();
    statusCopy.textContent = "Creating pre-Apply backup…";
    const reviewNotice = activeReviewSurface?.querySelector('[data-review="notice"]');
    if (reviewNotice)
      reviewNotice.textContent = "Creating pre-Apply backup…";
    try {
      await requestBackup({ type: "workshop:backup-create", preset: host.preset, kind: findReplacePending ? "before-find-replace" : "before-apply" });
      if (destroyed)
        return "Workshop closed before Apply.";
      ctx.ui.presetEditor.updatePreset((latest) => {
        if (presetFingerprint(latest) !== presetFingerprint(host.preset)) {
          conflict = "preset";
          return latest;
        }
        const restored = pendingRestore ? pendingRestore.apply(latest) : latest;
        if (!restored) {
          conflict = "preset restore";
          return latest;
        }
        const result = issueReview.apply(restored.blocks);
        if (!result.ok) {
          conflict = result.conflict;
          return latest;
        }
        applied = true;
        return { ...restored, blocks: result.blocks };
      });
      if (!applied)
        return `Prompt ${conflict} changed or disappeared outside Workshop. Your local drafts are retained. Discard drafts to restart from the latest preset.`;
      issueReview.clear();
      structureDraftsPending = false;
      findReplacePending = false;
      pendingRestore = null;
      agentDraftsPending = false;
      agentBaseline = agentWorkspace ? presetFingerprint(ctx.ui.presetEditor.getState().preset) : null;
      await ctx.ui.presetEditor.flush();
      return null;
    } catch (error) {
      return applied ? "Applied to the preset draft, but persistence failed. Retry saving the preset." : `${error instanceof Error ? error.message : "Could not create a backup or apply the draft batch."} Local edits are retained.`;
    } finally {
      applyingDrafts = false;
      root.inert = false;
      root.removeAttribute("aria-busy");
      if (activeReviewSurface) {
        activeReviewSurface.inert = false;
        activeReviewSurface.removeAttribute("aria-busy");
      }
      refreshLocalDrafts();
    }
  }
  root.querySelector('[data-action="apply-drafts"]').addEventListener("click", async () => {
    const error = await applyLocalDrafts();
    if (destroyed)
      return;
    const notice = root.querySelector('[data-role="draft-notice"]');
    notice.textContent = error ?? "";
    notice.hidden = !error;
    root.classList.toggle("has-draft-error", Boolean(error));
    if (error)
      root.querySelector('[data-action="apply-drafts"]').focus();
    else
      root.focus({ preventScroll: true });
  });
  root.querySelector('[data-action="discard-drafts"]').addEventListener("click", async () => {
    const result = await ctx.ui.showConfirm({ title: "Discard local drafts?", message: "Discard all unsynced prompt edits and return to the current preset?", variant: "warning", confirmLabel: "Discard drafts" });
    if (!result.confirmed || destroyed || applyingDrafts)
      return;
    discardLocalDrafts();
  });
  const backupRequests = new Map;
  cleanups.push(ctx.onBackendMessage((payload) => {
    if (!isWorkshopBackupResponse(payload))
      return;
    const pending = backupRequests.get(payload.requestId);
    if (!pending)
      return;
    clearTimeout(pending.timer);
    backupRequests.delete(payload.requestId);
    if (payload.error)
      pending.reject(new Error(payload.error));
    else
      pending.resolve(payload);
  }));
  cleanups.push(() => {
    for (const pending of backupRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Workshop closed."));
    }
    backupRequests.clear();
  });
  function requestBackup(request) {
    const requestId = uniqueRequestId(++previewSequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        backupRequests.delete(requestId);
        reject(new Error("Backup storage timed out."));
      }, 30000);
      backupRequests.set(requestId, { resolve, reject, timer });
      try {
        ctx.sendToBackend({ ...request, requestId });
      } catch {
        clearTimeout(timer);
        backupRequests.delete(requestId);
        reject(new Error("Could not reach backup storage."));
      }
    });
  }
  let backupSettings = { ...DEFAULT_BACKUP_SETTINGS };
  let backupSettingsRevision = 0;
  let automaticBackupError = "";
  let refreshBackupPanel = null;
  const automaticBackups = new AutomaticBackups(async () => {
    if (destroyed || applyingDrafts)
      return;
    await requestBackup({ type: "workshop:backup-create", preset: currentBackupSnapshot(), kind: "automatic" });
    setAutomaticBackupError("");
    refreshBackupPanel?.();
  }, (error) => {
    setAutomaticBackupError(error instanceof Error ? error.message : "Automatic backup failed.");
    statusCopy.textContent = "Automatic backup failed. Open Preset backups for details.";
    refreshBackupPanel?.();
  });
  cleanups.push(() => automaticBackups.destroy());
  function setAutomaticBackupError(error) {
    automaticBackupError = error;
    if (!error)
      setDraftStatus();
    const launcher = root.querySelector('[data-action="backups"]');
    launcher.toggleAttribute("data-backup-error", !!error);
    launcher.title = error ? "Automatic backup failed. Open Preset backups for details." : "Preset backups";
    root.querySelector('[data-role="automatic-backup-notice"]').textContent = error ? "Automatic backup failed. Open Preset backups for details." : "";
  }
  function configureBackups(settings) {
    const changed = backupSettings.automatic !== settings.automatic || backupSettings.intervalMinutes !== settings.intervalMinutes;
    backupSettings = { ...settings };
    if (changed)
      automaticBackups.configure(settings);
  }
  const agentButton = root.querySelector('[data-action="agent"]');
  const previewHome = previewElement.parentElement;
  const previewNext = previewElement.nextSibling;
  async function leaveAgent() {
    const workspace = agentWorkspace;
    if (!workspace)
      return;
    const choice = await workspace.confirmLeave();
    if (!choice || destroyed || agentWorkspace !== workspace) {
      if (!destroyed)
        agentButton.focus();
      return;
    }
    agentWorkspace = null;
    workspace.cancel();
    previewHome.insertBefore(previewElement, previewNext);
    workspace.destroy();
    root.classList.remove("agent-mode");
    refreshRailButtons();
    renderPrompts();
    agentButton.textContent = "Agent";
    agentButton.setAttribute("aria-pressed", "false");
    if (choice === "discard")
      discardLocalDrafts();
    agentButton.focus({ preventScroll: true });
  }
  agentButton.addEventListener("click", () => {
    if (applyingDrafts || destroyed)
      return;
    if (agentWorkspace) {
      leaveAgent();
      return;
    }
    if (closeIssueReview || closeBackups || !retainEditorDrafts(["primary", "secondary"]))
      return;
    closeMobileRails();
    const host = ctx.ui.presetEditor.getState().preset;
    if (!host)
      return;
    const existing = issueReview.apply(pendingRestore?.preset.blocks ?? host.blocks);
    if (!existing.ok || pendingRestore && !pendingRestore.matches(host)) {
      const notice = root.querySelector('[data-role="draft-notice"]');
      notice.textContent = "Existing local drafts conflict with the host preset. Resolve or discard them before entering agent mode.";
      notice.hidden = false;
      root.classList.add("has-draft-error");
      return;
    }
    agentBaseline = presetFingerprint(host);
    const workspace = new AgentWorkspace(ctx, {
      snapshot: currentBackupSnapshot,
      navigation: root.querySelector(".workshop-rail.left"),
      initialBlockId: selectedBlockId,
      onSelection: (id, reveal) => {
        if (reveal && id) {
          promptQuery = "";
          promptSearch.value = "";
          const category = computePromptGroups(effectiveValue().blocks).find((group) => group.children.some((block) => block.id === id))?.categoryBlock;
          if (category)
            collapsedCategories.delete(category.id);
        }
        renderPrompts();
        if (reveal && id) {
          const row = Array.from(promptList.querySelectorAll("[data-block-id]")).find((row) => row.dataset.blockId === id);
          if (row && row.offsetParent !== null) {
            const bounds = row.getBoundingClientRect(), viewport = promptList.getBoundingClientRect();
            if (bounds.top < viewport.top)
              promptList.scrollTop -= viewport.top - bounds.top;
            else if (bounds.bottom > viewport.bottom)
              promptList.scrollTop += bounds.bottom - viewport.bottom;
          }
        }
      },
      context: () => ({ values: structuredClone(canonicalValue.promptVariableValues), mocks: variableSandbox.overlay(effectiveValue().blocks, canonicalValue.promptVariableValues), preview: structuredClone(previewResult), changes: [...issueReview.blockIds, ...pendingRestore ? ["Whole preset draft"] : []] }),
      stage: (preset, baseline) => {
        if (destroyed || applyingDrafts)
          throw Error("Workshop is unavailable for edits.");
        const latest = ctx.ui.presetEditor.getState().preset;
        if (!latest || latest.id !== sessionPresetId || agentBaseline !== null && presetFingerprint(latest) !== agentBaseline)
          throw Error("The host preset changed during agent mode. Changes were not staged; leave and reopen agent mode.");
        if (presetFingerprint(currentBackupSnapshot()) !== baseline)
          throw Error("Local drafts changed during the run. Generated edits were not staged; run again against the current draft.");
        if (preset.id !== latest.id)
          throw Error("Agent result targets another preset.");
        if (!issueReview.apply(pendingRestore?.preset.blocks ?? latest.blocks).ok)
          throw Error("Existing prompt drafts conflict with the host; generated changes were not staged.");
        if (pendingRestore && !pendingRestore.matches(latest))
          throw Error("An earlier preset draft conflicts with the host. Discard or resolve it first.");
        pendingRestore = new PresetRestoreDraft(latest, preset);
        issueReview.clear();
        primaryDraftValue = null;
        secondaryDraftValue = null;
        agentDraftsPending = true;
        if (!baseBlocks().some((block) => block.id === selectedBlockId))
          selectedBlockId = null;
        if (!baseBlocks().some((block) => block.id === secondaryBlockId))
          secondaryBlockId = null;
        primaryEditorBase = baseBlocks();
        secondaryEditorBase = baseBlocks();
        renderEditorVisibility();
        refreshLocalDrafts();
      }
    });
    agentWorkspace = workspace;
    root.classList.add("agent-mode");
    root.append(workspace.element);
    workspace.element.append(previewElement);
    agentButton.textContent = "Leave agent";
    agentButton.setAttribute("aria-pressed", "true");
    renderPrompts();
    workspace.element.querySelector('[data-agent="prompts"]')?.focus();
  });
  function currentBackupSnapshot() {
    if (!retainEditorDrafts(["primary", "secondary"]))
      throw new Error("Save or discard the ambiguous prompt draft first.");
    const host = ctx.ui.presetEditor.getState();
    if (!host.preset || host.presetId !== sessionPresetId)
      throw new Error("The active preset changed.");
    return { ...structuredClone(pendingRestore?.preset ?? host.preset), blocks: structuredClone(localValue().blocks) };
  }
  function openBackups() {
    if (destroyed || closeBackups || closeIssueReview || applyingDrafts)
      return;
    const panel = ctx.ui.showModal({ title: "Preset backups", width: window.innerWidth, maxHeight: window.innerHeight, persistent: true });
    const surface = panel.root;
    const restoreChrome = installFullscreenModalChrome(surface);
    surface.className = "workshop-review workshop-backups";
    const settingsId = `backup-settings-${crypto.randomUUID()}`;
    surface.innerHTML = `<header class="workshop-review-header"><div class="workshop-review-brand">${ICONS.backups}<div><h2>Preset backups</h2><span class="workshop-review-caption"></span></div></div><button type="button" class="workshop-review-button" data-backup="close">${ICONS.close}<span>Close</span></button></header><section class="workshop-review-issue" aria-label="Backup retention"><h3>One week of recovery</h3><p>Snapshots before Apply, manual snapshots, and optional timed backups of local work. Restore stays local until Apply.</p><p>Includes prompt blocks, variable definitions and preset settings. Lumi keeps live variable selections; preview mocks are excluded.</p><p>Stored in Workshop’s transient storage under storage/&lt;preset-name&gt;/backups/. Filenames use UTC date and time. Backups expire after seven days, including across restarts. A count limit can remove older backups sooner.</p><p data-backup="timing"></p></section><div class="workshop-backup-list"><form class="workshop-backup-settings" id="${settingsId}" aria-label="Backup settings" hidden><h3>Backup settings</h3><label class="workshop-backup-switch"><input type="checkbox" role="switch" data-backup="automatic">Automatic timed backups</label><label>Interval in minutes<input type="number" data-backup="interval" min="1" max="1440" step="1" required></label><label>Maximum backups to keep<input type="number" data-backup="keep" min="0" max="10000" step="1" required></label><p>Per preset. Timed backups run while Workshop is open, include unsynced edits, and skip unchanged snapshots. Closing Workshop stops the timer. Use 0 for no count limit. Saving a smaller limit removes the oldest backups now, including manual and pre-Apply snapshots, across this preset’s previous names. Seven-day expiry still applies.</p><div class="workshop-review-controls"><button type="submit" class="workshop-review-button primary" data-backup="save-settings">Save settings</button><button type="button" class="workshop-review-button" data-backup="cancel-settings">Cancel settings</button></div></form><div data-backup="list" aria-label="Available backups"></div></div><footer class="workshop-review-footer"><div class="workshop-review-controls"><button type="button" class="workshop-review-button primary" data-backup="create">${ICONS.backups}<span>Create backup</span></button><button type="button" class="workshop-review-button" data-backup="refresh">${ICONS.refresh}<span>Refresh</span></button><button type="button" class="workshop-review-button" data-backup="settings" aria-controls="${settingsId}" aria-expanded="false">Settings</button></div><span class="workshop-review-notice" data-backup="notice" role="status"></span></footer>`;
    surface.querySelector(".workshop-review-caption").textContent = latestPresetName;
    const list = surface.querySelector('[data-backup="list"]');
    const notice = surface.querySelector('[data-backup="notice"]');
    const settingsForm = surface.querySelector(".workshop-backup-settings");
    const settingsButton = surface.querySelector('[data-backup="settings"]');
    const field = (name) => settingsForm.querySelector(`[data-backup="${name}"]`);
    const paintSettings = () => {
      field("automatic").checked = backupSettings.automatic;
      field("interval").value = String(backupSettings.intervalMinutes);
      field("keep").value = String(backupSettings.keep);
    };
    const timing = () => {
      surface.querySelector('[data-backup="timing"]').textContent = `${backupSettings.automatic ? `Timed backups every ${backupSettings.intervalMinutes} minutes while Workshop is open.` : "Timed backups are off."} ${backupSettings.keep ? `Keep newest ${backupSettings.keep} backups.` : "No count limit."}${automaticBackupError ? ` Last automatic backup failed: ${automaticBackupError}` : ""}`;
    };
    let settingsFocusPending = false;
    const showSettings = (show) => {
      if (show)
        paintSettings();
      settingsForm.hidden = !show;
      settingsButton.setAttribute("aria-expanded", String(show));
      if (show)
        field("automatic").focus();
      else if (busy)
        settingsFocusPending = true;
      else
        settingsButton.focus();
    };
    let closed = false;
    let busy = false;
    const setBusy = (next) => {
      busy = next;
      for (const button of surface.querySelectorAll("button"))
        if (button.dataset.backup !== "close")
          button.disabled = next;
      for (const input of settingsForm.querySelectorAll("input"))
        input.disabled = next;
      notice.textContent = next ? "Working with backup storage…" : "";
      if (!next && settingsFocusPending) {
        settingsFocusPending = false;
        settingsButton.focus();
      }
    };
    const run = async (action) => {
      if (closed || busy)
        return;
      setBusy(true);
      let message = "";
      try {
        await action();
      } catch (error) {
        message = error instanceof Error ? error.message : "Backup operation failed.";
      } finally {
        if (!closed) {
          setBusy(false);
          notice.textContent = message || "Ready. Restoring stages changes locally; Apply syncs them.";
        }
      }
    };
    const load = async () => {
      const response = await requestBackup({ type: "workshop:backup-list", presetId: sessionPresetId });
      timing();
      if (closed)
        return;
      list.replaceChildren();
      if (!response.backups?.length) {
        const empty = document.createElement("p");
        empty.textContent = "No backups yet. Create one now, or Apply a draft batch to save its previous state automatically.";
        list.append(empty);
      }
      for (const backup of response.backups ?? []) {
        const row = document.createElement("article");
        row.className = "workshop-backup-row";
        const info = document.createElement("div");
        const title = document.createElement("h3");
        title.textContent = new Date(backup.createdAt).toLocaleString();
        const copy = document.createElement("p");
        copy.textContent = `${backup.kind === "manual" ? "Manual · local work" : backup.kind === "automatic" ? "Timed · local work" : backup.kind === "before-find-replace" ? "Before Find and Replace" : "Before Apply"} · ${backup.blockCount} prompts · expires ${new Date(backup.expiresAt).toLocaleString()}`;
        const path = document.createElement("code");
        path.textContent = backup.path;
        info.append(title, copy, path);
        const restore = document.createElement("button");
        restore.type = "button";
        restore.className = "workshop-review-button";
        restore.innerHTML = `${ICONS.undo}<span>Restore locally</span>`;
        restore.setAttribute("aria-label", `Restore locally, backup from ${title.textContent}, ${backup.path.split("/").pop()}`);
        restore.disabled = busy;
        restore.addEventListener("click", () => {
          run(async () => {
            const response = await requestBackup({ type: "workshop:backup-read", presetId: sessionPresetId, path: backup.path });
            if (closed || !response.backup)
              throw new Error("Backup is unavailable.");
            const host = ctx.ui.presetEditor.getState().preset;
            if (!host || host.id !== sessionPresetId)
              throw new Error("The active preset changed.");
            await requestBackup({ type: "workshop:backup-create", preset: currentBackupSnapshot(), kind: "manual" });
            if (closed)
              return;
            const latest = ctx.ui.presetEditor.getState().preset;
            if (!latest || presetFingerprint(latest) !== presetFingerprint(host))
              throw new Error("The preset changed while loading. Refresh and try again.");
            issueReview.clear();
            primaryDraftValue = null;
            secondaryDraftValue = null;
            structureDraftsPending = false;
            pendingRestore = new PresetRestoreDraft(latest, response.backup.preset);
            if (!baseBlocks().some((block) => block.id === selectedBlockId))
              selectedBlockId = null;
            if (!baseBlocks().some((block) => block.id === secondaryBlockId))
              secondaryBlockId = null;
            editor.destroy();
            secondaryEditor.destroy();
            primaryEditorBase = baseBlocks();
            secondaryEditorBase = baseBlocks();
            editor = mountEditorLane("primary");
            secondaryEditor = mountEditorLane("secondary");
            recomputeDerived();
            renderEditorVisibility();
            refreshLocalDrafts();
            finish();
          });
        });
        row.append(info, restore);
        list.append(row);
      }
    };
    const finish = () => {
      if (closed)
        return;
      closed = true;
      closeBackups = null;
      refreshBackupPanel = null;
      restoreChrome();
      unsubscribe();
      panel.dismiss();
      if (!destroyed)
        root.querySelector('[data-action="backups"]').focus();
    };
    const unsubscribe = panel.onDismiss(finish);
    closeBackups = finish;
    surface.querySelector('[data-backup="close"]').addEventListener("click", finish);
    surface.querySelector('[data-backup="refresh"]').addEventListener("click", () => {
      run(load);
    });
    surface.querySelector('[data-backup="create"]').addEventListener("click", () => {
      run(async () => {
        await requestBackup({ type: "workshop:backup-create", preset: currentBackupSnapshot(), kind: "manual" });
        await load();
        refreshLocalDrafts();
      });
    });
    settingsButton.addEventListener("click", () => showSettings(settingsForm.hidden));
    surface.querySelector('[data-backup="cancel-settings"]').addEventListener("click", () => showSettings(false));
    settingsForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const settings = { automatic: field("automatic").checked, intervalMinutes: Number(field("interval").value), keep: Number(field("keep").value) };
      if (!isBackupSettings(settings)) {
        notice.textContent = "Use an interval of 1–1440 minutes and a count of 0–10000.";
        return;
      }
      run(async () => {
        ++backupSettingsRevision;
        const response = await requestBackup({ type: "workshop:backup-settings", presetId: sessionPresetId, settings });
        if (destroyed)
          return;
        if (!response.settings)
          throw Error("Backup settings were not saved.");
        configureBackups(response.settings);
        setAutomaticBackupError("");
        if (closed)
          return;
        await load();
        showSettings(false);
      });
    });
    refreshBackupPanel = () => {
      run(load);
    };
    surface.querySelector('[data-backup="close"]').focus();
    run(async () => {
      const revision = backupSettingsRevision;
      const response = await requestBackup({ type: "workshop:backup-settings", presetId: sessionPresetId });
      if (!closed && !destroyed && revision === backupSettingsRevision && response.settings)
        configureBackups(response.settings);
      await load();
    });
  }
  root.querySelector('[data-action="backups"]').addEventListener("click", openBackups);
  root.querySelector('[data-action="manage-prompts"]').addEventListener("click", () => {
    if (closePromptManager || destroyed || applyingDrafts || agentWorkspace || closeIssueReview || closeBackups)
      return;
    const notice = root.querySelector('[data-role="draft-notice"]');
    try {
      const initial = currentBackupSnapshot();
      const host = ctx.ui.presetEditor.getState().preset;
      if (pendingRestore && !pendingRestore.matches(host) || !issueReview.apply(baseBlocks()).ok)
        throw Error("Local drafts conflict with the host preset. Resolve or discard them before managing prompts.");
      const hostBaseline = presetFingerprint(host), localBaseline = presetFingerprint(initial);
      closePromptManager = openPromptManager(root, initial.blocks, (blocks, createdId) => {
        try {
          if (destroyed || applyingDrafts || agentWorkspace)
            return "Workshop is busy. Try again after the current action finishes.";
          const latest = ctx.ui.presetEditor.getState().preset;
          if (!latest || presetFingerprint(latest) !== hostBaseline || presetFingerprint(currentBackupSnapshot()) !== localBaseline)
            return "The preset or local drafts changed while this dialog was open. Cancel and reopen Manage prompts; your existing Workshop edits are retained.";
          if (pendingRestore && !pendingRestore.matches(latest) || !issueReview.apply(baseBlocks()).ok)
            return "Local drafts conflict with the host preset. Cancel and resolve them first.";
          pendingRestore = new PresetRestoreDraft(latest, { ...initial, blocks });
          structureDraftsPending = true;
          issueReview.clear();
          primaryDraftValue = null;
          secondaryDraftValue = null;
          if (createdId) {
            selectedBlockId = createdId;
            promptQuery = "";
            promptSearch.value = "";
          }
          if (!blocks.some((block) => block.id === selectedBlockId))
            selectedBlockId = null;
          if (!blocks.some((block) => block.id === secondaryBlockId) || selectedBlockId === secondaryBlockId)
            secondaryBlockId = null;
          if (selectedBlockId)
            for (const group of computePromptGroups(blocks)) {
              if (group.children.some((block) => block.id === selectedBlockId) && group.categoryBlock)
                collapsedCategories.delete(group.categoryBlock.id);
            }
          editor.destroy();
          secondaryEditor.destroy();
          primaryEditorBase = baseBlocks();
          secondaryEditorBase = baseBlocks();
          editor = mountEditorLane("primary");
          secondaryEditor = mountEditorLane("secondary");
          recomputeDerived();
          renderEditorVisibility();
          refreshLocalDrafts();
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : "Could not retain prompt list changes.";
        }
      }, () => {
        closePromptManager = null;
      });
      setDraftStatus();
    } catch (error) {
      notice.textContent = error instanceof Error ? error.message : "Could not open Manage prompts.";
      notice.hidden = false;
      root.classList.add("has-draft-error");
    }
  });
  cleanups.push(() => closePromptManager?.());
  root.querySelector('[data-action="find-replace"]').addEventListener("click", () => {
    if (closeFindReplace || destroyed || applyingDrafts || agentWorkspace)
      return;
    closeFindReplace = openFindReplace(root, () => localValue().blocks, (changes) => {
      if (destroyed || applyingDrafts)
        return "Workshop is busy. Try again after Apply finishes.";
      const current = localValue().blocks;
      if (changes.some((change) => {
        const matches = current.filter((block) => block.id === change.before.id);
        return matches.length !== 1 || JSON.stringify(matches[0]) !== JSON.stringify(change.before) || baseBlocks().filter((block) => block.id === change.before.id).length !== 1;
      }))
        return "A matching prompt changed. Refresh the preview before replacing.";
      for (const change of changes)
        issueReview.stage(baseBlocks(), [change.after], change.before.id);
      findReplacePending = true;
      refreshLocalDrafts();
      return null;
    }, () => {
      closeFindReplace = null;
    });
  });
  cleanups.push(() => closeFindReplace?.());
  function openIssueReview() {
    if (destroyed || closeIssueReview)
      return;
    const reviewModal = ctx.ui.showModal({ title: "Review issues", width: window.innerWidth, maxHeight: window.innerHeight, persistent: true });
    const returnFocus = root.querySelector('[data-action="review-issues"]');
    const surface = reviewModal.root;
    activeReviewSurface = surface;
    const restoreChrome = installFullscreenModalChrome(surface);
    surface.className = "workshop-review";
    surface.innerHTML = `<header class="workshop-review-header"><div class="workshop-review-brand">${ICONS.review}<div><h2>Review issues</h2><span class="workshop-review-caption">Preset diagnostics</span></div></div><span class="workshop-review-progress" data-review="position"></span><button type="button" class="workshop-review-button" data-review="close">${ICONS.close}<span>Close</span></button></header>
      <section class="workshop-review-issue" aria-label="Current issue"><div class="workshop-review-issue-head"><span class="workshop-review-eyebrow">${ICONS.warning}Current issue</span><span class="workshop-review-state" data-review="state" role="status"></span></div><h3 data-review="title"></h3><div class="workshop-review-prompt">${ICONS.pencil}<span data-review="prompt"></span></div><p data-review="message"></p></section>
      <section class="workshop-review-editor" data-review="editor" aria-label="Prompt editor"></section>
      <footer class="workshop-review-footer"><nav aria-label="Issue navigation"><span class="workshop-review-eyebrow">Review queue</span><div class="workshop-review-controls"><button class="workshop-review-button" type="button" data-review="previous">${ICONS.left}<span>Previous</span></button><button class="workshop-review-button" type="button" data-review="next"><span>Next</span>${ICONS.right}</button><button class="workshop-review-button" type="button" data-review="recheck">${ICONS.refresh}<span>Recheck</span></button></div></nav><div class="workshop-review-drafts" role="group" aria-label="Local drafts"><span class="workshop-review-eyebrow" data-review="drafts">No unsynced drafts</span><div class="workshop-review-controls"><button class="workshop-review-button" type="button" data-review="discard">${ICONS.undo}<span>Discard drafts</span></button><button class="workshop-review-button primary" type="button" data-review="apply">${ICONS.check}<span>Apply</span></button></div></div><span class="workshop-review-notice" data-review="notice">Save keeps edits local. Apply syncs your draft batch.</span></footer>`;
    const el = (name) => surface.querySelector(`[data-review="${name}"]`);
    const button = (name) => el(name);
    retainEditorDrafts(["primary", "secondary"]);
    let queue = buildReviewIssues(localValue().blocks, canonicalValue.promptVariableValues);
    let position = 0;
    let transient = null;
    let editorBase = baseBlocks();
    let error = "";
    let closed = false;
    let applying = false;
    let reviewEditor = null;
    const current = () => queue[position];
    const value = () => localValue();
    const editable = () => Boolean(current()?.editable && baseBlocks().filter((block) => block.id === current().blockId).length === 1);
    const retain = () => {
      if (transient && current() && !issueReview.stage(editorBase, transient.blocks, current().blockId))
        error = "This prompt no longer has a unique identity. Its edit could not be retained.";
      transient = null;
    };
    const render = () => {
      const issue = current();
      const blocks = transient?.blocks ?? localValue().blocks;
      const activeIssues = buildReviewIssues(blocks, canonicalValue.promptVariableValues);
      el("position").textContent = issue ? `${position + 1} / ${queue.length}` : "0 issues";
      el("title").textContent = issue?.title ?? "No remaining issues";
      el("prompt").textContent = issue ? blocks.find((block) => block.id === issue.blockId)?.name ?? issue.blockId : "";
      el("message").textContent = issue?.message ?? "Recheck to refresh the review queue, or Apply your local fixes.";
      el("state").textContent = issue ? !editable() ? "Editing unavailable: missing or ambiguous prompt identity." : activeIssues.some((next) => next.key === issue.key) ? "Still present" : "Resolved locally" : "";
      el("drafts").textContent = structureDraftsPending ? "Unsynced prompt list" : pendingRestore ? "Unsynced preset restore" : issueReview.size ? `${issueReview.size} unsynced prompt${issueReview.size === 1 ? "" : "s"}` : "No unsynced drafts";
      el("notice").textContent = error || "Save keeps edits local. Apply syncs your draft batch.";
      if (error)
        el("notice").setAttribute("role", "alert");
      else
        el("notice").removeAttribute("role");
      surface.querySelector(".workshop-review-issue").classList.toggle("is-resolved", Boolean(issue && !activeIssues.some((next) => next.key === issue.key)));
      el("notice").classList.toggle("workshop-review-error", Boolean(error));
      button("previous").disabled = position === 0;
      button("next").disabled = position >= queue.length - 1;
      button("apply").disabled = applying || issueReview.size === 0 && !transient && !pendingRestore || primaryDraftValue !== null || secondaryDraftValue !== null;
      for (const action of ["previous", "next", "recheck", "discard", "close"])
        if (applying)
          button(action).disabled = true;
      button("discard").disabled = issueReview.size === 0 && !transient && !pendingRestore;
      if (primaryDraftValue || secondaryDraftValue)
        el("notice").textContent = "Save or discard the open Workshop prompt drafts before applying review fixes.";
    };
    const load = () => {
      editorBase = baseBlocks();
      reviewEditor?.update({ value: value(), selectedBlockId: editable() ? current().blockId : null, readOnly: !editable() });
      el("editor").hidden = !editable();
      requestAnimationFrame(() => {
        if (!closed)
          decorateNativeMount(el("editor"), false);
      });
      render();
    };
    reviewEditor = ctx.components.mountLoomBlockEditor(el("editor"), {
      value: value(),
      selectedBlockId: editable() ? current().blockId : null,
      compact: false,
      readOnly: !editable(),
      onDraftChange: (next) => {
        if (closed)
          return;
        transient = next;
        render();
      },
      onChange: (next) => {
        if (closed || !current())
          return;
        if (!issueReview.stage(editorBase, next.blocks, current().blockId))
          error = "Could not retain an ambiguous prompt edit.";
        transient = null;
        setDraftStatus();
        render();
      },
      onSelectedBlockChange: () => {
        if (!closed)
          load();
      }
    });
    const finish = () => {
      if (closed)
        return;
      retain();
      closed = true;
      closeIssueReview = null;
      activeReviewSurface = null;
      reviewEditor?.destroy();
      restoreChrome();
      unsubscribe();
      reviewModal.dismiss();
      if (!destroyed) {
        refreshLocalDrafts();
        const launcher = root.querySelector('[data-action="review-issues"]');
        if (launcher && !launcher.disabled)
          launcher.focus();
        else if (returnFocus?.isConnected)
          returnFocus.focus();
        else
          root.focus();
      }
    };
    const unsubscribe = reviewModal.onDismiss(finish);
    closeIssueReview = finish;
    button("close").addEventListener("click", finish);
    for (const [name, delta] of [["previous", -1], ["next", 1]])
      button(name).addEventListener("click", () => {
        retain();
        position = Math.max(0, Math.min(queue.length - 1, position + delta));
        load();
        setDraftStatus();
      });
    button("recheck").addEventListener("click", () => {
      retain();
      queue = buildReviewIssues(localValue().blocks, canonicalValue.promptVariableValues);
      position = 0;
      load();
      setDraftStatus();
    });
    button("discard").addEventListener("click", () => {
      transient = null;
      discardLocalDrafts();
      error = "";
      queue = buildReviewIssues(canonicalValue.blocks, canonicalValue.promptVariableValues);
      position = 0;
      finish();
      openIssueReview();
    });
    button("apply").addEventListener("click", async () => {
      if (applying)
        return;
      retain();
      applying = true;
      render();
      error = await applyLocalDrafts() ?? "";
      applying = false;
      if (closed || destroyed)
        return;
      button("close").disabled = false;
      button("recheck").disabled = false;
      if (error) {
        render();
        button("apply").focus();
        return;
      }
      queue = buildReviewIssues(canonicalValue.blocks, canonicalValue.promptVariableValues);
      position = 0;
      load();
      setDraftStatus();
      renderVariables();
      button("recheck").focus();
    });
    load();
    button("close").focus();
  }
  function diagnosticCount(index) {
    return index.missing.length + index.variables.filter((variable) => variable.duplicateDefinition || variable.unused).length + index.duplicateBlockIds.length;
  }
  function renderDiagnostics(container, index) {
    const diagnostics = document.createElement("div");
    diagnostics.className = "workshop-diagnostics";
    let count = 0;
    for (const missing of index.missing) {
      count += 1;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "workshop-diagnostic-row";
      const title = document.createElement("span");
      title.className = "workshop-diagnostic-title";
      title.textContent = `Unknown ${missing.macro}`;
      const copy = document.createElement("span");
      copy.className = "workshop-diagnostic-copy";
      copy.textContent = `Referenced by ${missing.references.map((ref) => ref.blockName).join(", ") || "unknown block"}`;
      row.append(title, copy);
      row.addEventListener("click", () => {
        const first = missing.references[0];
        if (first)
          requestSelectedBlock(first.blockId);
      });
      diagnostics.append(row);
    }
    for (const entry of index.variables.filter((variable) => variable.duplicateDefinition || variable.unused)) {
      count += 1;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "workshop-diagnostic-row";
      const title = document.createElement("span");
      title.className = "workshop-diagnostic-title";
      title.textContent = entry.duplicateDefinition ? `Duplicate ${entry.macro}` : `Unused ${entry.macro}`;
      const copy = document.createElement("span");
      copy.className = "workshop-diagnostic-copy";
      copy.textContent = entry.duplicateDefinition ? `Defined by ${entry.definitions.map((definition) => definition.blockName).join(", ")}` : `Defined in ${entry.definitions[0]?.blockName ?? "unknown block"}`;
      row.append(title, copy);
      row.addEventListener("click", () => {
        selectedVariableName = entry.name;
        expandedVariablePane = "detail";
        renderVariables();
        renderPrompts();
      });
      diagnostics.append(row);
    }
    for (const duplicateId of index.duplicateBlockIds) {
      count += 1;
      const row = document.createElement("div");
      row.className = "workshop-diagnostic-row";
      const title = document.createElement("span");
      title.className = "workshop-diagnostic-title";
      title.textContent = `Duplicate block id: ${duplicateId}`;
      const copy = document.createElement("span");
      copy.className = "workshop-diagnostic-copy";
      copy.textContent = "Workshop will refuse an ambiguous targeted write.";
      row.append(title, copy);
      diagnostics.append(row);
    }
    if (count === 0) {
      const clean = document.createElement("div");
      clean.className = "workshop-description";
      clean.textContent = "No obvious variable topology problems.";
      diagnostics.append(clean);
    }
    container.append(diagnostics);
  }
  function renderVariables() {
    for (const body of variableList.querySelectorAll("[data-variable-pane-body]")) {
      variablePaneScroll.set(body.dataset.variablePaneBody ?? "", body.scrollTop);
    }
    const index = variableIndex();
    const query = variableQuery.trim().toLowerCase();
    variableList.replaceChildren();
    variableCount.textContent = `${index.variables.length}`;
    if (selectedVariableName && !index.byName.has(selectedVariableName))
      selectedVariableName = null;
    const selectedEntry = selectedVariableName ? index.byName.get(selectedVariableName) : undefined;
    if (!selectedEntry && expandedVariablePane === "detail")
      expandedVariablePane = null;
    variableList.classList.toggle("has-selection", Boolean(selectedEntry));
    variableList.classList.toggle("has-expanded-pane", Boolean(expandedVariablePane));
    const makePane = (id, title, count) => {
      const pane = document.createElement("section");
      pane.className = `workshop-variable-pane${expandedVariablePane === id ? " expanded" : ""}`;
      pane.dataset.variablePane = id;
      const header = document.createElement("div");
      header.className = "workshop-variable-pane-header";
      const heading = document.createElement("span");
      heading.className = "workshop-variable-pane-title";
      heading.textContent = title;
      const badge = document.createElement("span");
      badge.className = "workshop-variable-pane-count";
      badge.textContent = String(count);
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "workshop-variable-pane-toggle";
      toggle.textContent = expandedVariablePane === id ? "Show sections" : "Show more";
      toggle.addEventListener("click", () => {
        expandedVariablePane = expandedVariablePane === id ? null : id;
        renderVariables();
      });
      header.append(heading, badge);
      if (id === "all") {
        const mode = document.createElement("button");
        mode.type = "button";
        mode.className = "workshop-variable-pane-toggle";
        mode.textContent = sandboxFormMode ? "Variable map" : "Mock values";
        mode.addEventListener("click", () => {
          sandboxFormMode = !sandboxFormMode;
          renderVariables();
        });
        header.append(mode);
      }
      if (id === "diagnostics") {
        const review = document.createElement("button");
        review.type = "button";
        review.dataset.action = "review-issues";
        review.className = "workshop-variable-pane-toggle";
        review.textContent = issueReview.size ? `Review issues (${issueReview.size} edits)` : "Review issues";
        review.disabled = count === 0 && issueReview.size === 0;
        review.addEventListener("click", openIssueReview);
        header.append(review);
      }
      header.append(toggle);
      const body = document.createElement("div");
      body.className = "workshop-variable-pane-body";
      body.dataset.variablePaneBody = id;
      pane.append(header, body);
      variableList.append(pane);
      return { pane, body };
    };
    if (selectedEntry) {
      const detailPane = makePane("detail", selectedEntry.definitions[0]?.definition.label || selectedEntry.name, "Selected");
      appendDefinitionDetail(detailPane.body, selectedEntry);
    }
    const current = selectedBlock();
    const currentNames = current ? new Set([
      ...(current.variables ?? []).map((variable) => variable.name),
      ...parsePromptVariableReferences(current.content ?? "").map((reference) => reference.name)
    ]) : new Set;
    const visibleEntries = index.variables.filter((entry) => {
      const primary = entry.definitions[0];
      const haystack = [
        entry.name,
        entry.macro,
        primary?.definition.label ?? "",
        primary?.definition.description ?? "",
        ...entry.definitions.map((definition) => definition.blockName),
        ...entry.references.map((reference) => reference.blockName)
      ].join(`
`).toLowerCase();
      return !query || haystack.includes(query);
    });
    const allPane = makePane("all", "All variables", visibleEntries.length);
    if (sandboxFormMode) {
      const note = document.createElement("div");
      note.className = "workshop-description workshop-mock-note";
      note.textContent = "Mock values · preview only";
      allPane.body.append(note);
      const groups = new Map;
      const visibleNames = new Set(visibleEntries.map((entry) => entry.name));
      for (const block of effectiveValue().blocks) {
        for (const definition of block.variables ?? []) {
          const entry = index.byName.get(definition.name);
          if (!entry || !visibleNames.has(entry.name) || entry.definitions[0]?.blockId !== block.id)
            continue;
          const entries = groups.get(block.id) ?? [];
          if (!entries.some((item) => item.name === entry.name))
            entries.push(entry);
          groups.set(block.id, entries);
        }
      }
      for (const [blockId, entries] of groups) {
        const section = document.createElement("details");
        section.className = "workshop-mock-group";
        section.dataset.variableGroup = blockId;
        section.open = Boolean(query) || openVariableGroups.has(blockId);
        const summary = document.createElement("summary");
        const title = document.createElement("span");
        title.textContent = entries[0].definitions[0].blockName;
        const count = document.createElement("span");
        count.className = "workshop-variable-refcount";
        count.textContent = `${entries.length} variable${entries.length === 1 ? "" : "s"}`;
        summary.append(title, count);
        section.append(summary);
        summary.addEventListener("click", () => {
          if (query)
            return;
          if (section.open)
            openVariableGroups.delete(blockId);
          else
            openVariableGroups.add(blockId);
        });
        for (const entry of entries) {
          const row = document.createElement("div");
          row.className = "workshop-mock-row";
          row.dataset.variableName = entry.name;
          const label = document.createElement("button");
          label.type = "button";
          label.className = "workshop-mock-title";
          label.textContent = `${entry.definitions[0].definition.label || entry.name}${variableSandbox.has(entry.name) ? " · Mock" : ""}`;
          label.setAttribute("aria-label", `Inspect ${entry.definitions[0].definition.label || entry.name}`);
          label.title = "View definition and dependencies";
          label.addEventListener("click", () => {
            selectedVariableName = selectedVariableName === entry.name ? null : entry.name;
            expandedVariablePane = null;
            renderVariables();
            renderPrompts();
          });
          row.append(label);
          appendSandboxControl(row, entry, true);
          section.append(row);
        }
        allPane.body.append(section);
      }
      if (groups.size === 0) {
        const empty = document.createElement("div");
        empty.className = "workshop-description";
        empty.textContent = query ? "No variables match this search." : "No variables are defined in this preset.";
        allPane.body.append(empty);
      }
    } else {
      const appendCards = (title, entries) => {
        if (entries.length === 0)
          return;
        if (title) {
          const section = document.createElement("div");
          section.className = "workshop-section-label";
          section.textContent = title;
          allPane.body.append(section);
        }
        for (const entry of entries) {
          const primary = entry.definitions[0];
          const refCount = entry.references.reduce((sum, ref) => sum + ref.count, 0);
          const card = document.createElement("button");
          card.type = "button";
          card.className = "workshop-variable-card";
          if (entry.name === selectedVariableName)
            card.classList.add("selected");
          const head = document.createElement("span");
          head.className = "workshop-variable-card-head";
          const label = document.createElement("span");
          label.className = "workshop-variable-label";
          label.textContent = `${primary?.definition.label || entry.name}${variableSandbox.has(entry.name) ? " · Mock" : ""}`;
          const refs = document.createElement("span");
          refs.className = "workshop-variable-refcount";
          refs.textContent = `${refCount} ref${refCount === 1 ? "" : "s"}`;
          head.append(label, refs);
          const macro = document.createElement("span");
          macro.className = "workshop-variable-macro";
          macro.textContent = entry.macro;
          const owner = document.createElement("span");
          owner.className = "workshop-variable-owner";
          owner.textContent = primary ? entry.definitions.length > 1 ? `Defined in ${entry.definitions.length} prompts` : `Defined in ${primary.blockName}` : "Missing definition";
          card.append(head, macro, owner);
          card.addEventListener("click", () => {
            selectedVariableName = selectedVariableName === entry.name ? null : entry.name;
            expandedVariablePane = null;
            renderVariables();
            renderPrompts();
          });
          allPane.body.append(card);
        }
      };
      const contextual = visibleEntries.filter((entry) => currentNames.has(entry.name));
      const contextualNames = new Set(contextual.map((entry) => entry.name));
      appendCards(current ? "This prompt" : "", contextual);
      appendCards(current ? "Everything else" : "", visibleEntries.filter((entry) => !contextualNames.has(entry.name)));
    }
    const diagnosticsPane = makePane("diagnostics", "Diagnostics", diagnosticCount(index));
    renderDiagnostics(diagnosticsPane.body, index);
    for (const body of variableList.querySelectorAll("[data-variable-pane-body]")) {
      const saved = variablePaneScroll.get(body.dataset.variablePaneBody ?? "") ?? 0;
      body.scrollTop = Math.min(saved, Math.max(0, body.scrollHeight - body.clientHeight));
    }
  }
  function renderPreview() {
    const reference = previewTab === "reference";
    root.classList.toggle("reference-mode", reference);
    referenceView.element.hidden = !reference || previewCollapsed;
    previewContent.hidden = reference;
    previewSearch.hidden = reference;
    previewEntriesCollapseButton.hidden = reference;
    root.querySelector('[data-action="refresh"]').setAttribute("aria-label", reference ? "Refresh reference preset" : "Refresh preview");
    if (reference) {
      if (!previewCollapsed)
        referenceView.activate();
      previewStatus.textContent = "Read-only reference";
      return;
    }
    previewContent.replaceChildren();
    previewElement.classList.toggle("entries-collapsed", previewEntriesCollapsed);
    if (previewCollapsed)
      return;
    const chatId = ctx.getActiveChat().chatId;
    if (!chatId) {
      const state = document.createElement("div");
      state.className = "workshop-preview-state";
      state.textContent = "Open a chat to resolve runtime macros and assemble the effective prompt.";
      previewContent.append(state);
      previewStatus.textContent = "No active chat";
      return;
    }
    if (previewLoading && !previewResult) {
      const state = document.createElement("div");
      state.className = "workshop-preview-state";
      state.textContent = "Assembling preview…";
      previewContent.append(state);
      return;
    }
    if (previewError) {
      const state = document.createElement("div");
      state.className = "workshop-preview-state";
      state.textContent = previewError;
      previewContent.append(state);
      return;
    }
    if (!previewResult) {
      const state = document.createElement("div");
      state.className = "workshop-preview-state";
      state.textContent = "Preview will appear here.";
      previewContent.append(state);
      return;
    }
    const query = previewQuery.trim().toLowerCase();
    if (previewTab === "resolved") {
      const visible = previewResult.messages.map((message, index) => ({ message, index, content: messageContentText(message) })).filter(({ message, content }) => !query || [message.role, message.name ?? "", content].join(`
`).toLowerCase().includes(query));
      previewStatus.textContent = query ? `${visible.length}/${previewResult.messages.length} messages` : `${previewResult.messages.length} messages`;
      for (const { message, index, content } of visible) {
        const card = document.createElement("article");
        card.className = "workshop-message";
        const head = document.createElement("div");
        head.className = "workshop-message-head";
        head.textContent = `${index + 1} · ${message.role}${message.name ? ` · ${message.name}` : ""}`;
        const pre = document.createElement("pre");
        pre.textContent = content;
        card.append(head, pre);
        previewContent.append(card);
      }
      if (visible.length === 0) {
        const state = document.createElement("div");
        state.className = "workshop-preview-state";
        state.textContent = "No dry-run messages match this search.";
        previewContent.append(state);
      }
    } else {
      const visible = previewResult.breakdown.map((entry, index) => ({ entry, index })).filter(({ entry }) => !query || [entry.type, entry.name ?? "", entry.role ?? "", entry.content ?? ""].join(`
`).toLowerCase().includes(query));
      previewStatus.textContent = query ? `${visible.length}/${previewResult.breakdown.length} stack entries` : `${previewResult.breakdown.length} stack entries`;
      for (const { entry, index } of visible) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = `workshop-breakdown-row${entry.blockId ? " has-block" : ""}`;
        const head = document.createElement("div");
        head.className = "workshop-breakdown-head";
        const metadata = [
          `${index + 1}`,
          entry.type,
          entry.name,
          entry.role,
          entry.messageCount !== undefined ? `${entry.messageCount} msg` : undefined,
          entry.preCountedTokens !== undefined ? `${entry.preCountedTokens}t` : undefined
        ].filter(Boolean).join(" · ");
        head.textContent = metadata;
        row.append(head);
        if (entry.content) {
          const pre = document.createElement("pre");
          pre.textContent = entry.content;
          row.append(pre);
        }
        if (entry.blockId)
          row.addEventListener("click", () => {
            requestSelectedBlock(entry.blockId);
          });
        previewContent.append(row);
      }
      if (visible.length === 0) {
        const state = document.createElement("div");
        state.className = "workshop-preview-state";
        state.textContent = "No dry-run stack entries match this search.";
        previewContent.append(state);
      }
    }
  }
  function schedulePreview(immediate = false) {
    if (destroyed || previewCollapsed || previewTab === "reference")
      return;
    if (previewTimer)
      clearTimeout(previewTimer);
    const run = () => {
      previewTimer = null;
      if (destroyed || previewCollapsed || previewTab === "reference")
        return;
      const chatId = ctx.getActiveChat().chatId;
      lastChatId = chatId;
      if (!chatId) {
        activePreviewRequestId = null;
        previewResult = null;
        previewError = null;
        previewLoading = false;
        renderPreview();
        return;
      }
      const value = effectiveValue();
      const requestId = uniqueRequestId(++previewSequence);
      activePreviewRequestId = requestId;
      previewLoading = true;
      previewError = null;
      previewStatus.textContent = "Assembling…";
      renderPreview();
      ctx.sendToBackend({
        type: "workshop:assemble",
        requestId,
        chatId,
        blocks: value.blocks,
        promptVariables: variableSandbox.overlay(value.blocks, value.promptVariableValues)
      });
    };
    previewTimer = setTimeout(run, immediate ? 0 : PREVIEW_DEBOUNCE_MS);
  }
  function decorateNativeMount(mount, sidecar) {
    const layout = mount.firstElementChild;
    if (!(layout instanceof HTMLElement))
      return;
    layout.classList.add("workshop-native-layout");
    const textarea = mount.querySelector("textarea");
    if (textarea instanceof HTMLTextAreaElement)
      textarea.classList.add("workshop-primary-textarea");
    let scroll = null;
    if (textarea) {
      let cursor = textarea.parentElement;
      while (cursor && cursor !== layout) {
        if (cursor.parentElement === layout) {
          scroll = cursor;
          break;
        }
        cursor = cursor.parentElement;
      }
    }
    if (!scroll) {
      const children = [...layout.children].filter((child) => child instanceof HTMLElement);
      scroll = children.find((child) => child.querySelector("textarea")) ?? null;
    }
    if (!scroll)
      return;
    scroll.classList.add("workshop-native-scroll");
    const form = scroll.firstElementChild;
    if (!(form instanceof HTMLElement))
      return;
    form.classList.add("workshop-native-form");
    form.classList.remove("workshop-variable-sidecar");
    form.style.removeProperty("--wk-native-pane-height");
    for (const child of [...form.children]) {
      if (!(child instanceof HTMLElement))
        continue;
      child.classList.remove("workshop-native-main-field", "workshop-native-variable-root");
      child.style.removeProperty("grid-row");
    }
    if (!sidecar)
      return;
    const variableRoot = form.lastElementChild;
    if (!(variableRoot instanceof HTMLElement))
      return;
    const mainFields = [...form.children].filter((child) => child instanceof HTMLElement && child !== variableRoot);
    const formStyle = getComputedStyle(form);
    const paddingTop = Number.parseFloat(formStyle.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(formStyle.paddingBottom) || 0;
    const nativeViewportHeight = Math.min(scroll.clientHeight, mount.clientHeight || scroll.clientHeight);
    const availablePaneHeight = Math.floor(nativeViewportHeight - paddingTop - paddingBottom);
    if (availablePaneHeight > 0)
      form.style.setProperty("--wk-native-pane-height", `${availablePaneHeight}px`);
    form.classList.add("workshop-variable-sidecar");
    variableRoot.style.gridRow = `1 / span ${Math.max(1, mainFields.length)}`;
    for (const child of [...form.children]) {
      if (!(child instanceof HTMLElement))
        continue;
      child.classList.add(child === variableRoot ? "workshop-native-variable-root" : "workshop-native-main-field");
    }
  }
  let decorationFrame = null;
  function scheduleNativeDecoration() {
    if (destroyed || decorationFrame !== null)
      return;
    decorationFrame = requestAnimationFrame(() => {
      decorationFrame = null;
      const primary = selectedBlock();
      const useSidecar = Boolean(primary && !secondaryBlockId && primarySlot.clientWidth >= 980 && (primary.variables?.length ?? 0) > 0);
      decorateNativeMount(editorMount, useSidecar);
      decorateNativeMount(secondaryEditorMount, false);
    });
  }
  const primaryObserver = new MutationObserver(scheduleNativeDecoration);
  const secondaryObserver = new MutationObserver(scheduleNativeDecoration);
  primaryObserver.observe(editorMount, { childList: true, subtree: true });
  secondaryObserver.observe(secondaryEditorMount, { childList: true, subtree: true });
  const editorResizeObserver = new ResizeObserver(scheduleNativeDecoration);
  editorResizeObserver.observe(primarySlot);
  editorResizeObserver.observe(secondarySlot);
  cleanups.push(() => primaryObserver.disconnect(), () => secondaryObserver.disconnect(), () => editorResizeObserver.disconnect());
  const onViewportResize = () => {
    scheduleNativeDecoration();
  };
  window.addEventListener("resize", onViewportResize);
  cleanups.push(() => window.removeEventListener("resize", onViewportResize));
  function reportWriteFailure(targetId, failure) {
    if (!failure)
      return;
    console.error(`[Workshop] Refused ambiguous Loom block write for ${targetId}: ${failure}`);
    previewError = `Workshop refused an ambiguous write (${failure}). Reopen the preset before editing further.`;
    renderPreview();
  }
  function commitEditorValue(targetId, value, lane) {
    if (!targetId) {
      console.warn(`[Workshop] Ignored ${lane} native Loom commit without a selected block.`);
      return;
    }
    const base = lane === "primary" ? primaryEditorBase : secondaryEditorBase;
    if (!issueReview.stage(base, value.blocks, targetId)) {
      reportWriteFailure(targetId, "ambiguous local draft");
      return;
    }
    if (lane === "primary")
      primaryDraftValue = null;
    else
      secondaryDraftValue = null;
    recomputeDerived();
    setDraftStatus();
    renderPrompts();
    renderVariables();
    schedulePreview();
  }
  function syncCanonicalFromHost() {
    const state = ctx.ui.presetEditor.getState();
    if (!state.open || !state.preset || state.presetId !== sessionPresetId)
      return false;
    const next = editorValueFromHost(ctx);
    if (!next)
      return false;
    retainEditorDrafts(["primary", "secondary"]);
    canonicalValue = next;
    latestPresetName = state.preset.name;
    presetName.textContent = pendingRestore?.preset.name ?? latestPresetName;
    if (selectedBlockId && !baseBlocks().some((block) => block.id === selectedBlockId)) {
      selectedBlockId = null;
      primaryDraftValue = null;
    }
    if (secondaryBlockId && !baseBlocks().some((block) => block.id === secondaryBlockId)) {
      secondaryBlockId = null;
      secondaryDraftValue = null;
    }
    if (secondaryBlockId && secondaryBlockId === selectedBlockId) {
      secondaryBlockId = null;
      secondaryDraftValue = null;
    }
    recomputeDerived();
    primaryEditorBase = baseBlocks();
    secondaryEditorBase = baseBlocks();
    editor.update({ value: localValue(), selectedBlockId });
    secondaryEditor.update({ value: localValue(), selectedBlockId: secondaryBlockId });
    renderEditorVisibility();
    renderPrompts();
    renderVariables();
    setDraftStatus();
    scheduleNativeDecoration();
    schedulePreview();
    agentWorkspace?.refresh();
    return true;
  }
  const editorGenerations = { primary: 0, secondary: 0 };
  function mountEditorLane(lane) {
    const generation = ++editorGenerations[lane];
    const alive = () => !destroyed && editorGenerations[lane] === generation;
    return ctx.components.mountLoomBlockEditor(lane === "primary" ? editorMount : secondaryEditorMount, {
      value: localValue(),
      selectedBlockId: lane === "primary" ? selectedBlockId : secondaryBlockId,
      onSelectedBlockChange: (blockId) => {
        if (!alive())
          return;
        if (lane === "primary")
          requestSelectedBlock(blockId);
        else
          requestSecondaryBlock(blockId === selectedBlockId ? null : blockId);
      },
      onDraftChange: (value) => {
        if (!alive())
          return;
        if (lane === "primary")
          primaryDraftValue = value;
        else
          secondaryDraftValue = value;
        recomputeDerived();
        setDraftStatus();
        renderPrompts();
        renderVariables();
        scheduleNativeDecoration();
        schedulePreview();
      },
      onChange: (value) => {
        if (!alive())
          return;
        commitEditorValue(lane === "primary" ? selectedBlockId : secondaryBlockId, value, lane);
      },
      compact: false,
      readOnly: false
    });
  }
  editor = mountEditorLane("primary");
  secondaryEditor = mountEditorLane("secondary");
  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  async function closeWorkshop(force = false) {
    if (destroyed)
      return;
    if (!force && agentWorkspace) {
      await leaveAgent();
      return;
    }
    if (agentWorkspace) {
      agentWorkspace.destroy();
      agentWorkspace = null;
    }
    closePromptManager?.();
    closeIssueReview?.();
    closeBackups?.();
    const dirtyBlocks = [
      primaryDraftValue ? selectedBlock() : null,
      secondaryDraftValue ? secondaryBlock() : null
    ].filter((block) => block !== null);
    if (!force && (dirtyBlocks.length > 0 || issueReview.size > 0 || pendingRestore !== null)) {
      const names = dirtyBlocks.map((block) => block.name || block.id).join(", ");
      const result = await ctx.ui.showConfirm({
        title: dirtyBlocks.length > 1 ? "Discard prompt drafts?" : "Discard prompt draft?",
        message: `${names || (structureDraftsPending ? "Prompt list" : pendingRestore ? "Preset restore" : "Issue review")} has unapplied edits${issueReview.size ? `, including ${issueReview.size} locally saved prompts` : ""}. Close Workshop and discard them?`,
        variant: "warning",
        confirmLabel: "Discard and close"
      });
      if (!result.confirmed)
        return;
    }
    destroyed = true;
    if (previewTimer)
      clearTimeout(previewTimer);
    if (decorationFrame !== null)
      cancelAnimationFrame(decorationFrame);
    if (activePreviewRequestId) {
      ctx.sendToBackend({ type: "workshop:cancel-preview", requestId: activePreviewRequestId });
    }
    for (const cleanup of cleanups.splice(0))
      cleanup();
    editor.destroy();
    secondaryEditor.destroy();
    if (!force) {
      try {
        await ctx.ui.presetEditor.flush();
      } catch (error) {
        console.warn("[Workshop] Preset flush failed while closing:", error);
      }
    }
    modal.dismiss();
    onClosed();
  }
  const modalDismissUnsubscribe = modal.onDismiss(() => {
    if (!destroyed)
      closeWorkshop(true);
  });
  cleanups.push(modalDismissUnsubscribe);
  const presetUnsubscribe = ctx.ui.presetEditor.onChange((state) => {
    if (destroyed)
      return;
    if (!state.open || !state.preset || state.presetId !== sessionPresetId) {
      closeWorkshop(true);
      return;
    }
    syncCanonicalFromHost();
  });
  cleanups.push(presetUnsubscribe);
  const backendUnsubscribe = ctx.onBackendMessage((payload) => {
    if (destroyed || !isWorkshopBackendMessage(payload))
      return;
    if (payload.requestId !== activePreviewRequestId)
      return;
    previewLoading = false;
    if (payload.type === "workshop:assembly-error") {
      previewResult = null;
      previewError = payload.error;
      previewStatus.textContent = "Preview failed";
    } else {
      previewResult = payload.result;
      previewError = null;
      previewStatus.textContent = `${payload.result.messages.length} messages · ${payload.result.breakdown.length} stack entries`;
    }
    renderPreview();
  });
  cleanups.push(backendUnsubscribe);
  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      if (root.querySelector("dialog[open]") || activeReviewSurface?.querySelector("dialog[open]"))
        return;
      if (agentWorkspace?.closeNavigation())
        return;
      if (root.classList.contains("mobile-left-open") || root.classList.contains("mobile-right-open")) {
        closeMobileRails();
        return;
      }
      closeWorkshop();
    }
  };
  window.addEventListener("keydown", onKeyDown);
  cleanups.push(() => window.removeEventListener("keydown", onKeyDown));
  const chatWatch = setInterval(() => {
    if (destroyed)
      return;
    const current = ctx.getActiveChat().chatId;
    if (current !== lastChatId) {
      lastChatId = current;
      previewResult = null;
      previewError = null;
      schedulePreview(true);
    }
  }, CHAT_WATCH_MS);
  cleanups.push(() => clearInterval(chatWatch));
  promptSearch.addEventListener("input", () => {
    promptQuery = promptSearch.value;
    renderPrompts();
  });
  variableSearch.addEventListener("input", () => {
    variableQuery = variableSearch.value;
    renderVariables();
  });
  previewSearch.addEventListener("input", () => {
    previewQuery = previewSearch.value;
    renderPreview();
  });
  root.querySelector('[data-action="toggle-categories"]').addEventListener("click", () => {
    const groups = computePromptGroups(effectiveValue().blocks);
    const categoryIds = groups.map((group) => group.categoryBlock?.id ?? null).filter((id) => Boolean(id));
    const allCategoriesCollapsed = categoryIds.length > 0 && categoryIds.every((id) => collapsedCategories.has(id));
    if (allCategoriesCollapsed) {
      collapsedCategories.clear();
    } else {
      collapsedCategories.clear();
      for (const id of categoryIds)
        collapsedCategories.add(id);
    }
    renderPrompts();
  });
  root.querySelectorAll("[data-preview-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      previewTab = tab.dataset.previewTab === "reference" ? "reference" : tab.dataset.previewTab === "stack" ? "stack" : "resolved";
      root.querySelectorAll("[data-preview-tab]").forEach((other) => {
        other.classList.toggle("active", other === tab);
        other.setAttribute("aria-pressed", String(other === tab));
      });
      if (previewTab === "reference") {
        if (previewTimer)
          clearTimeout(previewTimer);
        previewTimer = null;
        if (activePreviewRequestId)
          ctx.sendToBackend({ type: "workshop:cancel-preview", requestId: activePreviewRequestId });
        activePreviewRequestId = null;
        previewLoading = false;
      } else
        schedulePreview(true);
      renderPreview();
    });
  });
  root.querySelector('[data-action="close"]').addEventListener("click", () => {
    closeWorkshop();
  });
  leftRailButton.addEventListener("click", () => {
    if (agentWorkspace) {
      agentWorkspace.toggleNavigation();
      return;
    }
    root.classList.toggle("left-collapsed");
    refreshRailButtons();
    scheduleNativeDecoration();
  });
  rightRailButton.addEventListener("click", () => {
    root.classList.toggle("right-collapsed");
    refreshRailButtons();
    scheduleNativeDecoration();
  });
  root.querySelector('[data-action="mobile-left"]').addEventListener("click", () => {
    root.classList.toggle("mobile-left-open");
    root.classList.remove("mobile-right-open");
  });
  root.querySelector('[data-action="mobile-right"]').addEventListener("click", () => {
    root.classList.toggle("mobile-right-open");
    root.classList.remove("mobile-left-open");
  });
  root.querySelector('[data-action="refresh"]').addEventListener("click", () => {
    if (previewTab === "reference")
      referenceView.refresh();
    else
      schedulePreview(true);
  });
  previewLayoutButton.addEventListener("click", () => {
    previewSplit = !previewSplit;
    root.classList.toggle("preview-split", previewSplit);
    previewLayoutButton.innerHTML = previewSplit ? ICONS.bottom : ICONS.split;
    previewLayoutButton.title = previewSplit ? "Move preview to the bottom" : "Move preview to the side";
    previewLayoutButton.setAttribute("aria-label", previewLayoutButton.title);
    scheduleNativeDecoration();
  });
  previewEntriesCollapseButton.addEventListener("click", () => {
    previewEntriesCollapsed = !previewEntriesCollapsed;
    previewEntriesCollapseButton.textContent = previewEntriesCollapsed ? "Expand" : "Collapse";
    renderPreview();
  });
  previewCollapseButton.addEventListener("click", () => {
    previewCollapsed = !previewCollapsed;
    root.classList.toggle("preview-collapsed", previewCollapsed);
    previewCollapseButton.textContent = previewCollapsed ? "Show" : "Hide";
    if (previewCollapsed) {
      if (previewTimer) {
        clearTimeout(previewTimer);
        previewTimer = null;
      }
      if (activePreviewRequestId) {
        ctx.sendToBackend({ type: "workshop:cancel-preview", requestId: activePreviewRequestId });
        activePreviewRequestId = null;
      }
      previewLoading = false;
      renderPreview();
    } else {
      renderPreview();
      schedulePreview(true);
    }
  });
  function installResizer(side) {
    const handle = root.querySelector(`[data-resize="${side}"]`);
    const onPointerDown = (event) => {
      if (window.innerWidth <= MOBILE_BREAKPOINT)
        return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      handle.classList.add("is-dragging");
      const startX = event.clientX;
      const style = getComputedStyle(root);
      const startSize = Number.parseFloat(style.getPropertyValue(side === "left" ? "--wk-left" : "--wk-right")) || (side === "left" ? 268 : 336);
      const onMove = (move) => {
        const delta = side === "left" ? move.clientX - startX : startX - move.clientX;
        const min = side === "left" ? LEFT_MIN : RIGHT_MIN;
        const max = side === "left" ? LEFT_MAX : RIGHT_MAX;
        const size = Math.max(min, Math.min(max, startSize + delta));
        root.style.setProperty(side === "left" ? "--wk-left" : "--wk-right", `${Math.round(size)}px`);
      };
      const onUp = () => {
        handle.classList.remove("is-dragging");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    };
    handle.addEventListener("pointerdown", onPointerDown);
    cleanups.push(() => handle.removeEventListener("pointerdown", onPointerDown));
  }
  installResizer("left");
  installResizer("right");
  const onPreviewPointerDown = (event) => {
    if (previewCollapsed)
      return;
    event.preventDefault();
    previewResizer.setPointerCapture(event.pointerId);
    previewResizer.classList.add("is-dragging");
    const style = getComputedStyle(root);
    const sideMode = previewSplit && window.innerWidth > MOBILE_BREAKPOINT;
    const start = sideMode ? Number.parseFloat(style.getPropertyValue("--wk-preview-width")) || 430 : Number.parseFloat(style.getPropertyValue("--wk-preview-height")) || 300;
    const startPoint = sideMode ? event.clientX : event.clientY;
    const onMove = (move) => {
      if (sideMode) {
        const delta = startPoint - move.clientX;
        const max = Math.min(PREVIEW_WIDTH_MAX, Math.max(PREVIEW_WIDTH_MIN, root.clientWidth - 360));
        const size = Math.max(PREVIEW_WIDTH_MIN, Math.min(max, start + delta));
        root.style.setProperty("--wk-preview-width", `${Math.round(size)}px`);
      } else {
        const delta = startPoint - move.clientY;
        const max = Math.max(PREVIEW_HEIGHT_MIN, root.clientHeight - 210);
        const size = Math.max(PREVIEW_HEIGHT_MIN, Math.min(max, start + delta));
        root.style.setProperty("--wk-preview-height", `${Math.round(size)}px`);
      }
      scheduleNativeDecoration();
    };
    const onUp = () => {
      previewResizer.classList.remove("is-dragging");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };
  previewResizer.addEventListener("pointerdown", onPreviewPointerDown);
  cleanups.push(() => previewResizer.removeEventListener("pointerdown", onPreviewPointerDown));
  const initialBackupSettingsRevision = backupSettingsRevision;
  requestBackup({ type: "workshop:backup-settings", presetId: sessionPresetId }).then((response) => {
    if (!destroyed && initialBackupSettingsRevision === backupSettingsRevision && response.settings)
      configureBackups(response.settings);
  }).catch(() => {
    if (!destroyed)
      setAutomaticBackupError("Could not load automatic backup settings. Open Preset backups and retry.");
  });
  presetName.textContent = latestPresetName;
  renderEditorVisibility();
  renderPrompts();
  renderVariables();
  setDraftStatus();
  refreshRailButtons();
  scheduleNativeDecoration();
  schedulePreview(true);
  return {
    destroy: closeWorkshop,
    focus() {
      root.focus({ preventScroll: true });
    }
  };
}
function setup(ctx) {
  const removeStyle = ctx.dom.addStyle(WORKSHOP_CSS + AGENT_CSS + REFERENCE_CSS);
  const toolbarRoot = ctx.ui.mount("preset_editor_toolbar");
  const launcher = button("workshop-launcher", "Open Workshop", `${ICONS.workshop}<span>Workshop</span>`);
  toolbarRoot.classList.add("workshop-toolbar-root");
  toolbarRoot.replaceChildren(launcher);
  let session = null;
  let opening = false;
  const open = () => {
    if (opening)
      return;
    if (session) {
      session.focus();
      return;
    }
    opening = true;
    try {
      session = createWorkshopSession(ctx, () => {
        session = null;
      });
      if (!session)
        console.warn("[Workshop] Cannot open without an active Loom preset draft.");
    } finally {
      opening = false;
    }
  };
  launcher.addEventListener("click", open);
  const unsubscribe = ctx.ui.presetEditor.onChange((state) => {
    if (session && (!state.open || !state.presetId || !state.preset)) {
      session.destroy(true).finally(() => {
        session = null;
      });
    }
  });
  return () => {
    launcher.removeEventListener("click", open);
    unsubscribe();
    toolbarRoot.replaceChildren();
    toolbarRoot.classList.remove("workshop-toolbar-root");
    removeStyle();
    const active = session;
    session = null;
    if (active)
      active.destroy(true);
  };
}
export {
  setup
};
