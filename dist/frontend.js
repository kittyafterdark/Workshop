// src/shared.ts
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
.workshop-editor-stage { width: 100%; height: 100%; min-width: 0; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; }
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
.workshop-preview { grid-column: 1; grid-row: 3; min-width: 0; min-height: 0; display: grid; grid-template-rows: 38px minmax(0, 1fr); border-top: 1px solid var(--lumiverse-border, rgba(255,255,255,.1)); background: var(--lumiverse-bg-dark, #141419); }
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
.workshop-preview-toolbar { min-width: 0; display: flex; align-items: center; gap: 7px; padding: 0 8px; border-bottom: 1px solid var(--lumiverse-border, rgba(255,255,255,.08)); }
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
  .workshop-rail { position: absolute; top: 0; bottom: 0; z-index: 20; width: min(86vw, 360px) !important; visibility: visible !important; box-shadow: var(--lumiverse-shadow-lg, 0 12px 40px rgba(0,0,0,.35)); transition: transform 160ms ease; }
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
  workshop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h16"/><path d="M6 20V8l6-4 6 4v12"/><path d="M9 20v-6h6v6"/><path d="M8 10h.01M16 10h.01"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
  right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.34 5.66"/><path d="M20 4v7h-7"/></svg>',
  split: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M13 4v16"/></svg>',
  bottom: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 13h18"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  columns: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg>',
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
      </div>
      <span class="workshop-preset-name"></span>
      <div class="workshop-header-actions">
        <div class="workshop-header-status"><span class="workshop-dot"></span><span class="workshop-status-copy">Synced</span></div>
        <button class="workshop-icon-button workshop-mobile-only" type="button" data-action="mobile-right" aria-label="Open variables">${ICONS.left}</button>
        <button class="workshop-icon-button" type="button" data-action="close" aria-label="Close Workshop">${ICONS.close}</button>
      </div>
    </header>
    <div class="workshop-body">
      <aside class="workshop-rail left">
        <div class="workshop-rail-header">
          <span class="workshop-rail-title">PROMPTS</span>
          <span class="workshop-count" data-role="prompt-count"></span>
          <span class="workshop-rail-tools">
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
              <button type="button" data-preview-tab="resolved">Resolved</button>
              <button type="button" data-preview-tab="stack" class="active">Stack</button>
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
  let destroyed = false;
  let canonicalValue = initialValue;
  let primaryDraftValue = null;
  let secondaryDraftValue = null;
  let selectedBlockId = null;
  let secondaryBlockId = null;
  let selectedVariableName = null;
  let promptQuery = "";
  let variableQuery = "";
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
  let editor;
  let secondaryEditor;
  function recomputeDerived() {
    derivedValue = overlaySelectedDrafts(canonicalValue, [
      { selectedBlockId, value: primaryDraftValue },
      { selectedBlockId: secondaryBlockId, value: secondaryDraftValue }
    ]);
    derivedIndex = buildVariableIndex(derivedValue.blocks, derivedValue.promptVariableValues);
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
    const draftCount = Number(primaryDraftValue !== null) + Number(secondaryDraftValue !== null);
    statusDot.classList.toggle("is-draft", draftCount > 0);
    statusCopy.textContent = draftCount === 0 ? "Synced" : draftCount === 1 ? "1 unsaved prompt draft" : "2 unsaved prompt drafts";
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
  let discardNavigationConfirmOpen = false;
  function blockForDraftSlot(slot) {
    return slot === "primary" ? selectedBlock() : secondaryBlock();
  }
  async function confirmDraftDiscard(slots) {
    const uniqueSlots = [...new Set(slots)];
    if (uniqueSlots.length === 0)
      return true;
    if (discardNavigationConfirmOpen)
      return false;
    const dirtyBlocks = uniqueSlots.map(blockForDraftSlot).filter((block) => block !== null);
    if (dirtyBlocks.length === 0)
      return true;
    discardNavigationConfirmOpen = true;
    try {
      const names = dirtyBlocks.map((block) => block.name || block.id).join(", ");
      const result = await ctx.ui.showConfirm({
        title: "Discard unsaved prompt edits?",
        message: `${names} ${dirtyBlocks.length > 1 ? "have" : "has"} edits that have not been saved. Leave ${dirtyBlocks.length > 1 ? "these prompts" : "this prompt"} and discard the changes?`,
        variant: "warning",
        confirmLabel: "Discard changes"
      });
      return result.confirmed;
    } finally {
      discardNavigationConfirmOpen = false;
    }
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
      recomputeDerived();
      editor.update({ selectedBlockId: blockId });
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
    if (blockId !== null && !canonicalValue.blocks.some((block) => block.id === blockId))
      return;
    if (blockId === selectedBlockId)
      return;
    const discarded = draftSlotsDiscardedBySelection({
      primaryBlockId: selectedBlockId,
      secondaryBlockId,
      primaryDirty: primaryDraftValue !== null,
      secondaryDirty: secondaryDraftValue !== null
    }, "primary", blockId);
    if (!await confirmDraftDiscard(discarded))
      return;
    applySelectedBlock(blockId);
  }
  function applySecondaryBlock(blockId) {
    if (blockId === secondaryBlockId)
      return;
    preserveHostScrollThroughSelection(() => {
      secondaryDraftValue = null;
      secondaryBlockId = blockId;
      recomputeDerived();
      secondaryEditor.update({ selectedBlockId: blockId });
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
      const block = canonicalValue.blocks.find((entry) => entry.id === blockId);
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
    if (!await confirmDraftDiscard(discarded))
      return;
    applySecondaryBlock(blockId);
  }
  function renderEditorVisibility() {
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
      if (block.id === selectedBlockId)
        row.classList.add("selected");
      if (block.id === secondaryBlockId)
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
      if (selectedBlockId && block.id !== selectedBlockId) {
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
        toggle.addEventListener("click", () => {
          if (collapsedCategories.has(category.id))
            collapsedCategories.delete(category.id);
          else
            collapsedCategories.add(category.id);
          renderPrompts();
        });
        wrap.append(toggle);
        const row = document.createElement("button");
        row.type = "button";
        row.className = "workshop-row category";
        if (category.id === selectedBlockId)
          row.classList.add("selected");
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
      header.append(heading, badge, toggle);
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
        label.textContent = primary?.definition.label || entry.name;
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
    const diagnosticsPane = makePane("diagnostics", "Diagnostics", diagnosticCount(index));
    renderDiagnostics(diagnosticsPane.body, index);
    for (const body of variableList.querySelectorAll("[data-variable-pane-body]")) {
      const saved = variablePaneScroll.get(body.dataset.variablePaneBody ?? "") ?? 0;
      body.scrollTop = Math.min(saved, Math.max(0, body.scrollHeight - body.clientHeight));
    }
  }
  function renderPreview() {
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
    if (destroyed || previewCollapsed)
      return;
    if (previewTimer)
      clearTimeout(previewTimer);
    const run = () => {
      previewTimer = null;
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
        promptVariables: value.promptVariableValues
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
    let failure = null;
    ctx.ui.presetEditor.updatePreset((latest) => {
      const patched = replaceUniqueBlock(latest.blocks, value.blocks, targetId);
      if (!patched.ok) {
        failure = patched.reason ?? "unknown";
        return latest;
      }
      return { ...latest, blocks: patched.blocks };
    });
    reportWriteFailure(targetId, failure);
  }
  function syncCanonicalFromHost() {
    const state = ctx.ui.presetEditor.getState();
    if (!state.open || !state.preset || state.presetId !== sessionPresetId)
      return false;
    const next = editorValueFromHost(ctx);
    if (!next)
      return false;
    canonicalValue = next;
    latestPresetName = state.preset.name;
    presetName.textContent = latestPresetName;
    if (selectedBlockId && !canonicalValue.blocks.some((block) => block.id === selectedBlockId)) {
      selectedBlockId = null;
      primaryDraftValue = null;
    }
    if (secondaryBlockId && !canonicalValue.blocks.some((block) => block.id === secondaryBlockId)) {
      secondaryBlockId = null;
      secondaryDraftValue = null;
    }
    if (secondaryBlockId && secondaryBlockId === selectedBlockId) {
      secondaryBlockId = null;
      secondaryDraftValue = null;
    }
    recomputeDerived();
    editor.update({ value: canonicalValue, selectedBlockId });
    secondaryEditor.update({ value: canonicalValue, selectedBlockId: secondaryBlockId });
    renderEditorVisibility();
    renderPrompts();
    renderVariables();
    setDraftStatus();
    scheduleNativeDecoration();
    schedulePreview();
    return true;
  }
  editor = ctx.components.mountLoomBlockEditor(editorMount, {
    value: canonicalValue,
    selectedBlockId: null,
    onSelectedBlockChange: (blockId) => {
      if (destroyed)
        return;
      requestSelectedBlock(blockId);
    },
    onDraftChange: (value) => {
      if (destroyed)
        return;
      primaryDraftValue = value;
      recomputeDerived();
      setDraftStatus();
      renderPrompts();
      renderVariables();
      scheduleNativeDecoration();
      schedulePreview();
    },
    onChange: (value) => {
      if (destroyed)
        return;
      commitEditorValue(selectedBlockId, value, "primary");
    },
    compact: false,
    readOnly: false
  });
  secondaryEditor = ctx.components.mountLoomBlockEditor(secondaryEditorMount, {
    value: canonicalValue,
    selectedBlockId: null,
    onSelectedBlockChange: (blockId) => {
      if (destroyed)
        return;
      if (blockId === selectedBlockId) {
        requestSecondaryBlock(null);
        return;
      }
      requestSecondaryBlock(blockId);
    },
    onDraftChange: (value) => {
      if (destroyed)
        return;
      secondaryDraftValue = value;
      recomputeDerived();
      setDraftStatus();
      renderPrompts();
      renderVariables();
      scheduleNativeDecoration();
      schedulePreview();
    },
    onChange: (value) => {
      if (destroyed)
        return;
      commitEditorValue(secondaryBlockId, value, "secondary");
    },
    compact: false,
    readOnly: false
  });
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
    const dirtyBlocks = [
      primaryDraftValue ? selectedBlock() : null,
      secondaryDraftValue ? secondaryBlock() : null
    ].filter((block) => block !== null);
    if (!force && dirtyBlocks.length > 0) {
      const names = dirtyBlocks.map((block) => block.name || block.id).join(", ");
      const result = await ctx.ui.showConfirm({
        title: dirtyBlocks.length > 1 ? "Discard prompt drafts?" : "Discard prompt draft?",
        message: `${names} ${dirtyBlocks.length > 1 ? "have" : "has"} edits that have not been saved in the native Loom editor. Close Workshop and discard them?`,
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
      previewTab = tab.dataset.previewTab === "stack" ? "stack" : "resolved";
      root.querySelectorAll("[data-preview-tab]").forEach((other) => other.classList.toggle("active", other === tab));
      renderPreview();
    });
  });
  root.querySelector('[data-action="close"]').addEventListener("click", () => {
    closeWorkshop();
  });
  leftRailButton.addEventListener("click", () => {
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
  root.querySelector('[data-action="refresh"]').addEventListener("click", () => schedulePreview(true));
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
  const removeStyle = ctx.dom.addStyle(WORKSHOP_CSS);
  const toolbar = ctx.ui.registerPresetEditorToolbarItem({
    id: "workshop-launcher",
    ariaLabel: "Open Workshop"
  });
  const launcher = button("workshop-launcher", "Open Workshop", `${ICONS.workshop}<span>Workshop</span>`);
  toolbar.root.style.display = "block";
  toolbar.root.style.width = "100%";
  toolbar.root.append(launcher);
  toolbar.setVisible(true);
  const styledToolbarHosts = new Map;
  const fitToolbarHost = () => {
    const host = toolbar.root.parentElement;
    if (!(host instanceof HTMLElement))
      return;
    if (!styledToolbarHosts.has(host)) {
      styledToolbarHosts.set(host, {
        flex: host.style.flex,
        width: host.style.width,
        alignSelf: host.style.alignSelf
      });
    }
    host.style.flex = "1 1 100%";
    host.style.width = "100%";
    host.style.alignSelf = "stretch";
    toolbar.root.style.width = "100%";
  };
  let setupDestroyed = false;
  let toolbarRepairTimer = null;
  let toolbarReopenFrame = null;
  let toolbarRepairAttempts = 0;
  const MAX_TOOLBAR_REPAIR_ATTEMPTS = 3;
  const scheduleToolbarRepair = () => {
    if (setupDestroyed || toolbarRepairTimer !== null || toolbarReopenFrame !== null)
      return;
    toolbarRepairTimer = window.setTimeout(() => {
      toolbarRepairTimer = null;
      if (setupDestroyed)
        return;
      fitToolbarHost();
      if (toolbar.root.isConnected) {
        toolbarRepairAttempts = 0;
        return;
      }
      let state;
      try {
        state = ctx.ui.presetEditor.getState();
      } catch {
        return;
      }
      if (!state.open || toolbarRepairAttempts >= MAX_TOOLBAR_REPAIR_ATTEMPTS)
        return;
      toolbarRepairAttempts += 1;
      try {
        toolbar.setVisible(false);
      } catch {
        return;
      }
      toolbarReopenFrame = requestAnimationFrame(() => {
        toolbarReopenFrame = null;
        if (setupDestroyed)
          return;
        try {
          toolbar.setVisible(true);
        } catch {
          return;
        }
        scheduleToolbarRepair();
      });
    }, 80);
  };
  fitToolbarHost();
  scheduleToolbarRepair();
  const toolbarHostObserver = new MutationObserver(() => {
    fitToolbarHost();
    scheduleToolbarRepair();
  });
  toolbarHostObserver.observe(document.body, { childList: true, subtree: true });
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
    fitToolbarHost();
    scheduleToolbarRepair();
    if (session && (!state.open || !state.presetId || !state.preset)) {
      session.destroy(true).finally(() => {
        session = null;
      });
    }
  });
  return () => {
    setupDestroyed = true;
    launcher.removeEventListener("click", open);
    unsubscribe();
    toolbarHostObserver.disconnect();
    if (toolbarRepairTimer !== null)
      window.clearTimeout(toolbarRepairTimer);
    if (toolbarReopenFrame !== null)
      cancelAnimationFrame(toolbarReopenFrame);
    for (const [host, previous] of styledToolbarHosts) {
      host.style.flex = previous.flex;
      host.style.width = previous.width;
      host.style.alignSelf = previous.alignSelf;
    }
    toolbar.destroy();
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
