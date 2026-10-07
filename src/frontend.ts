import type {
  AssemblyBreakdownEntryDTO,
  LlmMessageDTO,
  PromptBlockDTO,
  PromptVariableDefDTO,
  PromptVariableValuesDTO,
  PromptVariableValueDTO,
  SpindleFrontendContext,
  SpindleLoomBlockEditorHandle,
  SpindleLoomBlockEditorValue,
  SpindlePresetEditorDraft,
} from 'lumiverse-spindle-types'
import { isWorkshopBackendMessage } from './shared.js'
import {
  WorkshopVariableSandbox,
  WorkshopIssueReview,
  buildReviewIssues,
  blockVariableStats,
  buildVariableIndex,
  computePromptGroups,
  draftSlotsDiscardedBySelection,
  describePromptVariableValue,
  overlaySelectedDrafts,
  parsePromptVariableReferences,
  promptBlockSearchText,
  type VariableIndexEntry,
  type WorkshopEditorSlot,
  type WorkshopVariableIndex,
} from './workshop-core.js'

const PREVIEW_DEBOUNCE_MS = 475
const CHAT_WATCH_MS = 1250
const MOBILE_BREAKPOINT = 900
const LEFT_MIN = 210
const LEFT_MAX = 480
const RIGHT_MIN = 250
const RIGHT_MAX = 560
const PREVIEW_HEIGHT_MIN = 120
const PREVIEW_WIDTH_MIN = 300
const PREVIEW_WIDTH_MAX = 760

const WORKSHOP_CSS = String.raw`
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
.workshop-review { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--lumiverse-text, #eee); background: var(--lumiverse-bg, #141419); }
.workshop-review-header, .workshop-review-footer { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px; border-bottom: 1px solid var(--lumiverse-border, #333); }
.workshop-review-header strong { flex: 1; }
.workshop-review-issue { padding: 12px; border-bottom: 1px solid var(--lumiverse-border, #333); font-size: 12px; line-height: 1.5; }
.workshop-review-issue h3 { margin: 0 0 4px; font-size: 14px; }
.workshop-review-issue p { margin: 4px 0; }
.workshop-review-editor { flex: 1; min-height: 0; overflow: auto; }
.workshop-review-editor > * { height: 100%; min-height: 0; }
.workshop-review-footer { border-bottom: 0; border-top: 1px solid var(--lumiverse-border, #333); }
.workshop-review-notice { flex: 1 1 100%; font-size: 11px; color: var(--lumiverse-text-muted, #aaa); }
.workshop-review-error { color: var(--lumiverse-warning, #e8b04c); }
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
`
const ICONS = {
  workshop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h16"/><path d="M6 20V8l6-4 6 4v12"/><path d="M9 20v-6h6v6"/><path d="M8 10h.01M16 10h.01"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
  right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.34 5.66"/><path d="M20 4v7h-7"/></svg>',
  split: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M13 4v16"/></svg>',
  bottom: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 13h18"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  columns: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg>',
  chevronDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
}

function button(className: string, label: string, html: string): HTMLButtonElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = className
  el.setAttribute('aria-label', label)
  el.title = label
  el.innerHTML = html
  return el
}

function cloneBlocks(blocks: readonly PromptBlockDTO[]): PromptBlockDTO[] {
  return blocks.map((block) => ({
    ...block,
    injectionTrigger: [...block.injectionTrigger],
    characterTagTrigger: block.characterTagTrigger ? [...block.characterTagTrigger] : undefined,
    variables: block.variables?.map((variable) => {
      if (variable.type === 'select' || variable.type === 'multiselect') {
        return { ...variable, options: variable.options.map((option) => ({ ...option })) }
      }
      return { ...variable }
    }),
  }))
}

function clonePromptVariableValues(values: Readonly<PromptVariableValuesDTO>): PromptVariableValuesDTO {
  return Object.fromEntries(Object.entries(values).map(([blockId, blockValues]) => [
    blockId,
    Object.fromEntries(Object.entries(blockValues).map(([name, value]) => [
      name,
      Array.isArray(value) ? [...value] : value,
    ])),
  ]))
}

function editorValueFromHost(ctx: SpindleFrontendContext): SpindleLoomBlockEditorValue | null {
  const full = ctx.ui.presetEditor.getState()
  const scoped = ctx.ui.presetEditor.extension.getState()
  if (!full.open || !full.preset || !full.presetId || scoped.presetId !== full.presetId) return null
  return {
    blocks: cloneBlocks(scoped.blocks),
    promptVariableValues: clonePromptVariableValues(scoped.promptVariableValues),
  }
}

function formatDefinitionType(definition: PromptVariableDefDTO): string {
  if (definition.type === 'multiselect') return 'Multi-select'
  if (definition.type === 'textarea') return 'Long text'
  return definition.type.charAt(0).toUpperCase() + definition.type.slice(1)
}

function formatDefault(definition: PromptVariableDefDTO): string {
  if (definition.type === 'select') {
    return definition.options.find((option) => option.id === definition.defaultValue)?.label ?? definition.defaultValue
  }
  if (definition.type === 'multiselect') {
    return definition.defaultValue
      .map((id) => definition.options.find((option) => option.id === id)?.label ?? id)
      .join(', ') || 'None selected'
  }
  if (definition.type === 'switch') return definition.defaultValue === 1 ? 'On' : 'Off'
  return String(definition.defaultValue ?? '') || 'Empty'
}

function messageContentText(message: LlmMessageDTO): string {
  if (typeof message.content === 'string') return message.content
  return message.content.map((part) => {
    if (part.type === 'text') return part.text
    if (part.type === 'image') return `[image: ${part.mime_type}]`
    if (part.type === 'audio') return `[audio: ${part.mime_type}]`
    if (part.type === 'tool_use') {
      let payload = ''
      try { payload = JSON.stringify(part.input, null, 2) } catch { payload = '[unserializable input]' }
      return `[tool call: ${part.name}]${payload ? `\n${payload}` : ''}`
    }
    return `[tool result${part.is_error ? ' · error' : ''}]\n${part.content}`
  }).join('\n\n')
}

function uniqueRequestId(sequence: number): string {
  return `workshop-${Date.now().toString(36)}-${sequence.toString(36)}`
}

interface WorkshopSession {
  destroy(force?: boolean): Promise<void>
  focus(): void
}

function installFullscreenModalChrome(root: HTMLElement): () => void {
  const body = root.parentElement
  const container = body?.parentElement
  const backdrop = container?.parentElement
  const hostHeader = body?.previousElementSibling
  if (!(body instanceof HTMLElement) || !(container instanceof HTMLElement) || !(backdrop instanceof HTMLElement)) return () => {}

  const targets = [body, container, backdrop, hostHeader].filter((entry): entry is HTMLElement => entry instanceof HTMLElement)
  const snapshots = targets.map((element) => ({ element, style: element.getAttribute('style') }))

  Object.assign(backdrop.style, {
    alignItems: 'stretch',
    justifyContent: 'stretch',
    top: 'var(--app-interactive-safe-top, 0px)',
    bottom: 'auto',
    height: 'var(--app-interactive-viewport-height, calc(100dvh - var(--app-interactive-safe-top, 0px)))',
    padding: '0',
  })
  Object.assign(container.style, { width: '100%', maxWidth: 'none', height: '100%', maxHeight: 'none', borderRadius: '0', border: '0' })
  Object.assign(body.style, { padding: '0', overflow: 'hidden', minHeight: '0', height: '100%' })
  if (hostHeader instanceof HTMLElement) hostHeader.style.display = 'none'

  return () => {
    for (const snapshot of snapshots) {
      if (snapshot.style === null) snapshot.element.removeAttribute('style')
      else snapshot.element.setAttribute('style', snapshot.style)
    }
  }
}

function createWorkshopSession(ctx: SpindleFrontendContext, onClosed: () => void): WorkshopSession | null {
  const initialState = ctx.ui.presetEditor.getState()
  const initialValue = editorValueFromHost(ctx)
  if (!initialState.open || !initialState.presetId || !initialState.preset || !initialValue) return null

  const sessionPresetId = initialState.presetId
  const modal = ctx.ui.showModal({
    title: 'Workshop',
    width: window.innerWidth,
    maxHeight: window.innerHeight,
    persistent: true,
  })
  const root = modal.root
  const restoreHostModalChrome = installFullscreenModalChrome(root)
  root.className = 'workshop-shell'
  root.tabIndex = -1
  root.innerHTML = `
    <header class="workshop-header">
      <div class="workshop-header-left">
        <button class="workshop-icon-button workshop-mobile-only" type="button" data-action="mobile-left" aria-label="Open prompts">${ICONS.right}</button>
        <span class="workshop-header-brand">Workshop</span>
      </div>
      <span class="workshop-preset-name"></span>
      <div class="workshop-header-actions">
        <div class="workshop-header-status"><span class="workshop-dot"></span><span class="workshop-status-copy">Synced</span></div>
        <button class="workshop-text-button" type="button" data-action="apply-drafts" disabled>Apply</button>
        <button class="workshop-mini-button" type="button" data-action="discard-drafts" aria-label="Discard drafts" title="Discard all local prompt drafts" disabled>↶</button>
        <button class="workshop-icon-button workshop-mobile-only" type="button" data-action="mobile-right" aria-label="Open variables">${ICONS.left}</button>
        <button class="workshop-icon-button" type="button" data-action="close" aria-label="Close Workshop">${ICONS.close}</button>
      </div>
    </header>
    <div class="workshop-draft-error" data-role="draft-notice" role="alert" hidden></div>
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
          <button class="workshop-text-button" type="button" data-action="reset-mocks" disabled>Reset mocks</button>
        </div>
        <div class="workshop-search-wrap"><input class="workshop-search" data-role="variable-search" type="search" placeholder="Search variables…" aria-label="Search variables"></div>
        <div class="workshop-variable-workspace" data-role="variable-list"></div>
      </aside>
    </div>
  `

  const presetName = root.querySelector<HTMLElement>('.workshop-preset-name')!
  const statusDot = root.querySelector<HTMLElement>('.workshop-dot')!
  const statusCopy = root.querySelector<HTMLElement>('.workshop-status-copy')!
  const promptCount = root.querySelector<HTMLElement>('[data-role="prompt-count"]')!
  const promptSearch = root.querySelector<HTMLInputElement>('[data-role="prompt-search"]')!
  const promptList = root.querySelector<HTMLElement>('[data-role="prompt-list"]')!
  const promptNote = root.querySelector<HTMLElement>('[data-role="prompt-note"]')!
  const variableCount = root.querySelector<HTMLElement>('[data-role="variable-count"]')!
  const variableSearch = root.querySelector<HTMLInputElement>('[data-role="variable-search"]')!
  const variableList = root.querySelector<HTMLElement>('[data-role="variable-list"]')!
  const editorStage = root.querySelector<HTMLElement>('[data-role="editor-stage"]')!
  const primarySlot = root.querySelector<HTMLElement>('[data-role="primary-editor-slot"]')!
  const secondarySlot = root.querySelector<HTMLElement>('[data-role="secondary-editor-slot"]')!
  const editorMount = root.querySelector<HTMLElement>('[data-role="editor-mount"]')!
  const secondaryEditorMount = root.querySelector<HTMLElement>('[data-role="secondary-editor-mount"]')!
  const editorEmpty = root.querySelector<HTMLElement>('[data-role="editor-empty"]')!
  const previewStatus = root.querySelector<HTMLElement>('[data-role="preview-status"]')!
  const previewContent = root.querySelector<HTMLElement>('[data-role="preview-content"]')!
  const previewSearch = root.querySelector<HTMLInputElement>('[data-role="preview-search"]')!
  const previewElement = root.querySelector<HTMLElement>('.workshop-preview')!
  const previewLayoutButton = root.querySelector<HTMLButtonElement>('[data-action="preview-layout"]')!
  const previewEntriesCollapseButton = root.querySelector<HTMLButtonElement>('[data-action="preview-entries-collapse"]')!
  const previewCollapseButton = root.querySelector<HTMLButtonElement>('[data-action="preview-collapse"]')!
  const leftRailButton = root.querySelector<HTMLButtonElement>('[data-action="left"]')!
  const rightRailButton = root.querySelector<HTMLButtonElement>('[data-action="right"]')!
  const previewResizer = root.querySelector<HTMLElement>('[data-resize="preview"]')!

  const issueReview = new WorkshopIssueReview()
  let closeIssueReview: (() => void) | null = null
  const variableSandbox = new WorkshopVariableSandbox()
  let destroyed = false
  let canonicalValue = initialValue
  let primaryEditorBase = initialValue.blocks
  let secondaryEditorBase = initialValue.blocks
  let applyingDrafts = false
  let primaryDraftValue: SpindleLoomBlockEditorValue | null = null
  let secondaryDraftValue: SpindleLoomBlockEditorValue | null = null
  let selectedBlockId: string | null = null
  let secondaryBlockId: string | null = null
  let selectedVariableName: string | null = null
  let promptQuery = ''
  let variableQuery = ''
  let sandboxFormMode = true
  const openVariableGroups = new Set<string>()
  let previewTab: 'resolved' | 'stack' = 'stack'
  let previewQuery = ''
  let previewEntriesCollapsed = false
  let previewCollapsed = false
  let previewSplit = false
  let expandedVariablePane: 'detail' | 'all' | 'diagnostics' | null = null
  let previewTimer: ReturnType<typeof setTimeout> | null = null
  let previewSequence = 0
  let activePreviewRequestId: string | null = null
  let previewResult: { messages: LlmMessageDTO[]; breakdown: AssemblyBreakdownEntryDTO[] } | null = null
  let previewError: string | null = null
  let previewLoading = false
  let lastChatId = ctx.getActiveChat().chatId
  let latestPresetName = initialState.preset.name
  let derivedValue = overlaySelectedDrafts(canonicalValue, [
    { selectedBlockId, value: primaryDraftValue },
    { selectedBlockId: secondaryBlockId, value: secondaryDraftValue },
  ])
  let derivedIndex = buildVariableIndex(derivedValue.blocks, derivedValue.promptVariableValues)
  const collapsedCategories = new Set<string>()
  const variablePaneScroll = new Map<string, number>()
  const cleanups: Array<() => void> = [restoreHostModalChrome]
  let editor!: SpindleLoomBlockEditorHandle
  let secondaryEditor!: SpindleLoomBlockEditorHandle

  function recomputeDerived(): void {
    derivedValue = overlaySelectedDrafts(localValue(), [
      { selectedBlockId, value: primaryDraftValue },
      { selectedBlockId: secondaryBlockId, value: secondaryDraftValue },
    ])
    variableSandbox.overlay(derivedValue.blocks, derivedValue.promptVariableValues)
    derivedIndex = buildVariableIndex(derivedValue.blocks, derivedValue.promptVariableValues)
    const resetMocks = root.querySelector<HTMLButtonElement>('[data-action="reset-mocks"]')!
    resetMocks.disabled = variableSandbox.size === 0
    resetMocks.textContent = variableSandbox.size ? `Reset mocks (${variableSandbox.size})` : 'Reset mocks'
  }

  function localValue(): SpindleLoomBlockEditorValue {
    return { blocks: issueReview.overlay(canonicalValue.blocks), promptVariableValues: canonicalValue.promptVariableValues }
  }

  function effectiveValue(): SpindleLoomBlockEditorValue {
    return derivedValue
  }

  function variableIndex(): WorkshopVariableIndex {
    return derivedIndex
  }

  function blockById(blockId: string | null): PromptBlockDTO | null {
    if (!blockId) return null
    return effectiveValue().blocks.find((block) => block.id === blockId) ?? null
  }

  function selectedBlock(): PromptBlockDTO | null {
    return blockById(selectedBlockId)
  }

  function secondaryBlock(): PromptBlockDTO | null {
    return blockById(secondaryBlockId)
  }

  function setDraftStatus(): void {
    const draftCount = new Set([...issueReview.blockIds, ...(primaryDraftValue && selectedBlockId ? [selectedBlockId] : []), ...(secondaryDraftValue && secondaryBlockId ? [secondaryBlockId] : [])]).size
    root.classList.toggle('has-unsynced', draftCount > 0)
    const apply = root.querySelector<HTMLButtonElement>('[data-action="apply-drafts"]')!
    apply.textContent = `Apply (${draftCount})`
    apply.disabled = draftCount === 0 || applyingDrafts
    root.querySelector<HTMLButtonElement>('[data-action="discard-drafts"]')!.disabled = draftCount === 0 || applyingDrafts
    statusDot.classList.toggle('is-draft', draftCount > 0)
    statusCopy.textContent = draftCount === 0
      ? 'Synced'
      : draftCount === 1
        ? '1 unsynced prompt'
        : `${draftCount} unsynced prompts`
  }

  function closeMobileRails(): void {
    root.classList.remove('mobile-left-open', 'mobile-right-open')
  }

  type ScrollSnapshot = { element: HTMLElement; top: number; left: number }

  function captureHostScroll(): ScrollSnapshot[] {
    const snapshots: ScrollSnapshot[] = []
    let cursor: HTMLElement | null = root.parentElement
    while (cursor) {
      if (cursor.scrollHeight > cursor.clientHeight || cursor.scrollWidth > cursor.clientWidth || cursor.scrollTop || cursor.scrollLeft) {
        snapshots.push({ element: cursor, top: cursor.scrollTop, left: cursor.scrollLeft })
      }
      cursor = cursor.parentElement
    }
    return snapshots
  }

  function restoreScroll(snapshots: ScrollSnapshot[]): void {
    for (const snapshot of snapshots) {
      if (!snapshot.element.isConnected) continue
      const maxTop = Math.max(0, snapshot.element.scrollHeight - snapshot.element.clientHeight)
      const maxLeft = Math.max(0, snapshot.element.scrollWidth - snapshot.element.clientWidth)
      snapshot.element.scrollTop = Math.min(snapshot.top, maxTop)
      snapshot.element.scrollLeft = Math.min(snapshot.left, maxLeft)
    }
  }

  function preserveHostScrollThroughSelection(work: () => void): void {
    const snapshots = captureHostScroll()
    work()
    restoreScroll(snapshots)
    requestAnimationFrame(() => {
      if (destroyed) return
      restoreScroll(snapshots)
      requestAnimationFrame(() => {
        if (!destroyed) restoreScroll(snapshots)
      })
    })
  }

  function retainEditorDrafts(slots: readonly WorkshopEditorSlot[]): boolean {
    for (const slot of new Set(slots)) {
      const value = slot === 'primary' ? primaryDraftValue : secondaryDraftValue
      const id = slot === 'primary' ? selectedBlockId : secondaryBlockId
      const base = slot === 'primary' ? primaryEditorBase : secondaryEditorBase
      if (value && id && !issueReview.stage(base, value.blocks, id)) {
        reportWriteFailure(id, 'ambiguous local draft')
        return false
      }
      if (slot === 'primary') primaryDraftValue = null
      else secondaryDraftValue = null
    }
    return true
  }

  function applySelectedBlock(blockId: string | null): void {
    if (blockId === selectedBlockId) return
    preserveHostScrollThroughSelection(() => {
      if (blockId && blockId === secondaryBlockId) {
        secondaryBlockId = null
        secondaryDraftValue = null
        secondaryEditor.update({ selectedBlockId: null })
      }
      primaryDraftValue = null
      selectedBlockId = blockId
      primaryEditorBase = canonicalValue.blocks
      recomputeDerived()
      editor.update({ value: localValue(), selectedBlockId: blockId })
      renderEditorVisibility()
      renderPrompts()
      renderVariables()
      setDraftStatus()
      scheduleNativeDecoration()
      schedulePreview()
      closeMobileRails()
    })
  }

  async function requestSelectedBlock(blockId: string | null): Promise<void> {
    if (blockId !== null && !canonicalValue.blocks.some((block) => block.id === blockId)) return
    if (blockId === selectedBlockId) return
    const discarded = draftSlotsDiscardedBySelection({
      primaryBlockId: selectedBlockId,
      secondaryBlockId,
      primaryDirty: primaryDraftValue !== null,
      secondaryDirty: secondaryDraftValue !== null,
    }, 'primary', blockId)
    if (!retainEditorDrafts(discarded)) return
    applySelectedBlock(blockId)
  }

  function applySecondaryBlock(blockId: string | null): void {
    if (blockId === secondaryBlockId) return
    preserveHostScrollThroughSelection(() => {
      secondaryDraftValue = null
      secondaryBlockId = blockId
      secondaryEditorBase = canonicalValue.blocks
      recomputeDerived()
      secondaryEditor.update({ value: localValue(), selectedBlockId: blockId })
      renderEditorVisibility()
      renderPrompts()
      renderVariables()
      setDraftStatus()
      scheduleNativeDecoration()
      schedulePreview()
      closeMobileRails()
    })
  }

  async function requestSecondaryBlock(blockId: string | null): Promise<void> {
    if (blockId !== null) {
      const block = canonicalValue.blocks.find((entry) => entry.id === blockId)
      if (!block || block.marker === 'category' || blockId === selectedBlockId) return
    }
    if (blockId === secondaryBlockId) return
    const discarded = draftSlotsDiscardedBySelection({
      primaryBlockId: selectedBlockId,
      secondaryBlockId,
      primaryDirty: primaryDraftValue !== null,
      secondaryDirty: secondaryDraftValue !== null,
    }, 'secondary', blockId)
    if (!retainEditorDrafts(discarded)) return
    applySecondaryBlock(blockId)
  }

  function renderEditorVisibility(): void {
    const dual = Boolean(selectedBlockId && secondaryBlockId)
    editorStage.classList.toggle('dual', dual)
    primarySlot.classList.toggle('dual-slot', dual)
    secondarySlot.hidden = !secondaryBlockId
    editorMount.style.display = selectedBlockId ? '' : 'none'
    editorEmpty.style.display = selectedBlockId ? 'none' : ''
  }

  function refreshRailButtons(): void {
    const leftCollapsed = root.classList.contains('left-collapsed')
    const rightCollapsed = root.classList.contains('right-collapsed')
    leftRailButton.innerHTML = leftCollapsed ? ICONS.right : ICONS.left
    leftRailButton.title = leftCollapsed ? 'Expand prompts' : 'Collapse prompts'
    leftRailButton.setAttribute('aria-label', leftRailButton.title)
    rightRailButton.innerHTML = rightCollapsed ? ICONS.left : ICONS.right
    rightRailButton.title = rightCollapsed ? 'Expand variables' : 'Collapse variables'
    rightRailButton.setAttribute('aria-label', rightRailButton.title)
  }

  function renderPrompts(): void {
    const previousScrollTop = promptList.scrollTop
    const previousScrollLeft = promptList.scrollLeft
    const value = effectiveValue()
    const index = variableIndex()
    const query = promptQuery.trim().toLowerCase()
    const selectedVariable = selectedVariableName ? index.byName.get(selectedVariableName) : undefined
    const owners = new Set(selectedVariable?.definitions.map((definition) => definition.blockId) ?? [])
    const refs = new Set(selectedVariable?.references.map((reference) => reference.blockId) ?? [])
    promptList.replaceChildren()

    let visible = 0
    const blockMatches = (block: PromptBlockDTO) => !query || promptBlockSearchText(block).includes(query)

    const makeMeta = (block: PromptBlockDTO): HTMLElement => {
      const stats = blockVariableStats(block)
      const meta = document.createElement('span')
      meta.className = 'workshop-row-meta'
      if (stats.definitions > 0) {
        const pill = document.createElement('span')
        pill.className = 'workshop-pill define'
        pill.textContent = `D${stats.definitions}`
        pill.title = `${stats.definitions} variable definition${stats.definitions === 1 ? '' : 's'}`
        meta.append(pill)
      }
      if (stats.references > 0) {
        const pill = document.createElement('span')
        pill.className = 'workshop-pill'
        pill.textContent = `V${stats.references}`
        pill.title = `${stats.references} referenced variable${stats.references === 1 ? '' : 's'}`
        meta.append(pill)
      }
      return meta
    }

    const appendPromptRow = (block: PromptBlockDTO, child: boolean) => {
      visible += 1
      const wrap = document.createElement('div')
      wrap.className = 'workshop-row-wrap'

      const row = document.createElement('button')
      row.type = 'button'
      row.className = `workshop-row${child ? ' child' : ''}`
      if (block.id === selectedBlockId) row.classList.add('selected')
      if (block.id === secondaryBlockId) row.classList.add('secondary-selected')
      if (owners.has(block.id)) row.classList.add('variable-owner')
      if (refs.has(block.id)) row.classList.add('variable-reference')
      row.dataset.blockId = block.id

      const name = document.createElement('span')
      name.className = 'workshop-row-name'
      name.textContent = block.name || '(Untitled block)'
      row.append(name, makeMeta(block))
      row.addEventListener('click', () => { void requestSelectedBlock(block.id) })
      wrap.append(row)

      if (selectedBlockId && block.id !== selectedBlockId) {
        const split = button(
          'workshop-mini-button',
          block.id === secondaryBlockId ? 'Close second prompt' : `Open ${block.name || 'prompt'} beside current prompt`,
          block.id === secondaryBlockId ? ICONS.close : ICONS.columns,
        )
        split.addEventListener('click', () => { void requestSecondaryBlock(block.id === secondaryBlockId ? null : block.id) })
        wrap.append(split)
      }
      promptList.append(wrap)
    }

    for (const group of computePromptGroups(value.blocks)) {
      const category = group.categoryBlock
      const matchingChildren = query ? group.children.filter(blockMatches) : group.children
      const categoryMatches = category ? blockMatches(category) : false
      if (query && !categoryMatches && matchingChildren.length === 0) continue

      if (category) {
        visible += 1
        const wrap = document.createElement('div')
        wrap.className = 'workshop-row-wrap category-wrap'
        const collapsed = collapsedCategories.has(category.id) && !query

        const toggle = button(
          'workshop-category-toggle',
          `${collapsed ? 'Expand' : 'Collapse'} ${category.name || 'category'}`,
          `<span class="workshop-category-chevron${collapsed ? ' collapsed' : ''}">${ICONS.chevronDown}</span>`,
        )
        toggle.addEventListener('click', () => {
          if (collapsedCategories.has(category.id)) collapsedCategories.delete(category.id)
          else collapsedCategories.add(category.id)
          renderPrompts()
        })
        wrap.append(toggle)

        const row = document.createElement('button')
        row.type = 'button'
        row.className = 'workshop-row category'
        if (category.id === selectedBlockId) row.classList.add('selected')
        if (owners.has(category.id)) row.classList.add('variable-owner')
        if (refs.has(category.id)) row.classList.add('variable-reference')

        const name = document.createElement('span')
        name.className = 'workshop-row-name'
        name.textContent = category.name || '(Untitled category)'
        row.append(name, makeMeta(category))
        row.addEventListener('click', () => { void requestSelectedBlock(category.id) })
        wrap.append(row)
        promptList.append(wrap)

        if (!collapsed) {
          for (const child of (query ? matchingChildren : group.children)) appendPromptRow(child, true)
        }
        continue
      }

      for (const child of (query ? matchingChildren : group.children)) appendPromptRow(child, false)
    }

    const categoryIds = computePromptGroups(value.blocks)
      .map((group) => group.categoryBlock?.id ?? null)
      .filter((id): id is string => Boolean(id))
    const allCategoriesCollapsed = categoryIds.length > 0 && categoryIds.every((id) => collapsedCategories.has(id))
    const categoryBulkButton = root.querySelector<HTMLButtonElement>('[data-action="toggle-categories"]')!
    categoryBulkButton.setAttribute('aria-label', allCategoriesCollapsed ? 'Expand all categories' : 'Collapse all categories')
    categoryBulkButton.title = allCategoriesCollapsed ? 'Expand all categories' : 'Collapse all categories'
    categoryBulkButton.innerHTML = allCategoriesCollapsed ? ICONS.chevronDown : ICONS.right

    promptCount.textContent = `${visible}/${value.blocks.length}`
    promptNote.textContent = selectedVariable
      ? 'Variable map: owner blocks use the primary marker; reference blocks use the warning marker.'
      : `${index.definitionCount} definitions · ${index.referenceCount} references`
    promptList.scrollTop = Math.min(previousScrollTop, Math.max(0, promptList.scrollHeight - promptList.clientHeight))
    promptList.scrollLeft = Math.min(previousScrollLeft, Math.max(0, promptList.scrollWidth - promptList.clientWidth))
  }

  function refreshSandbox(): void {
    const activeVariable = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.mockVariable : undefined
    recomputeDerived()
    renderVariables()
    if (activeVariable) {
      const replacement = [...root.querySelectorAll<HTMLElement>('[data-mock-variable]')]
        .find((element) => element.dataset.mockVariable === activeVariable)
      replacement?.focus({ preventScroll: true })
    }
    schedulePreview()
  }

  root.querySelector('[data-action="reset-mocks"]')!.addEventListener('click', () => {
    variableSandbox.reset()
    refreshSandbox()
  })

  function appendSandboxControl(detail: HTMLElement, entry: VariableIndexEntry, compact = false): void {
    const label = document.createElement(compact ? 'div' : 'label')
    label.className = 'workshop-sandbox'
    const title = document.createElement('span')
    title.textContent = 'Mock value · preview only'
    if (!compact) label.append(title)
    const primary = entry.definitions[0]
    const definition = primary.definition
    if (entry.duplicateDefinition || variableIndex().duplicateBlockIds.includes(primary.blockId)) {
      const warning = document.createElement('div')
      warning.textContent = 'Resolve duplicate definitions or block IDs to mock this variable.'
      label.append(warning)
      detail.append(label)
      return
    }
    const values = variableSandbox.overlay(effectiveValue().blocks, effectiveValue().promptVariableValues)
    const value = values[primary.blockId]?.[entry.name] ?? primary.storedValue
    let control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    let read: () => PromptVariableValueDTO
    if (definition.type === 'select' || definition.type === 'multiselect') {
      const select = document.createElement('select')
      select.multiple = definition.type === 'multiselect'
      for (const option of definition.options) {
        const item = document.createElement('option')
        item.value = option.id
        item.textContent = option.label
        item.selected = Array.isArray(value) ? value.includes(option.id) : value === option.id
        select.append(item)
      }
      control = select
      read = () => select.multiple ? [...select.selectedOptions].map((option) => option.value) : select.value
    } else if (definition.type === 'textarea') {
      const textarea = document.createElement('textarea')
      textarea.rows = definition.rows ?? 3
      textarea.value = String(value)
      control = textarea
      read = () => textarea.value
    } else {
      const input = document.createElement('input')
      input.type = definition.type === 'switch' ? 'checkbox'
        : definition.type === 'slider' ? 'range' : definition.type === 'number' ? 'number' : 'text'
      if (definition.type === 'switch') input.setAttribute('role', 'switch')
      input.checked = value === 1 || value === '1'
      if (definition.type === 'number' || definition.type === 'slider') {
        if (definition.min !== undefined) input.min = String(definition.min)
        if (definition.max !== undefined) input.max = String(definition.max)
        input.step = String(definition.step ?? (definition.type === 'slider' ? 1 : 'any'))
      }
      input.value = String(value)
      control = input
      read = () => input.type === 'checkbox' ? Number(input.checked)
        : input.type === 'number' || input.type === 'range' ? input.valueAsNumber : input.value
    }
    control.dataset.mockVariable = entry.name
    control.setAttribute('aria-label', `Mock ${definition.label || entry.name}`)
    control.addEventListener('change', () => {
      if (!control.checkValidity()) { control.reportValidity(); return }
      if (variableSandbox.set(entry, read())) refreshSandbox()
    })
    label.append(control)
    detail.append(label)
    const described = describePromptVariableValue(definition, value)
    const resolved = document.createElement('div')
    resolved.className = 'workshop-description'
    resolved.textContent = `Preview resolves: ${described.resolved || 'Empty'}`
    const reset = document.createElement('button')
    reset.type = 'button'
    reset.className = 'workshop-text-button'
    reset.textContent = compact ? '↶' : 'Reset mock'
    reset.setAttribute('aria-label', compact ? `Reset mock ${definition.label || entry.name}` : 'Reset mock')
    reset.title = 'Reset mock'
    reset.disabled = !variableSandbox.has(entry.name)
    reset.addEventListener('click', () => { variableSandbox.reset(entry.name); refreshSandbox() })
    if (compact) {
      detail.append(reset)
      if (definition.type === 'switch' || definition.type === 'slider') {
        const valueLabel = document.createElement('span')
        valueLabel.className = 'workshop-mock-current'
        valueLabel.textContent = described.display
        label.append(valueLabel)
      }
    } else detail.append(resolved, reset)
  }

  function appendDefinitionDetail(container: HTMLElement, entry: VariableIndexEntry): void {
    const primary = entry.definitions[0]
    if (!primary) return
    const detail = document.createElement('div')
    detail.className = 'workshop-variable-detail'

    const heading = document.createElement('div')
    heading.className = 'workshop-detail-heading'
    heading.textContent = primary.definition.label || entry.name
    detail.append(heading)

    const macroRow = document.createElement('div')
    macroRow.className = 'workshop-detail-macro-row'
    const macro = document.createElement('span')
    macro.className = 'workshop-code'
    macro.textContent = entry.macro
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'workshop-copy'
    copy.textContent = 'Copy'
    copy.addEventListener('click', (event) => {
      event.stopPropagation()
      void copyText(entry.macro).then(() => {
        copy.textContent = 'Copied'
        setTimeout(() => { if (!destroyed) copy.textContent = 'Copy' }, 900)
      })
    })
    macroRow.append(macro, copy)
    detail.append(macroRow)

    const grid = document.createElement('div')
    grid.className = 'workshop-detail-grid'
    const pairs: Array<[string, string]> = [
      ['Type', formatDefinitionType(primary.definition)],
      ['Default', formatDefault(primary.definition)],
      ['Current', primary.displayValue],
      ['Resolves', primary.resolvedValue || 'Empty'],
    ]
    if (primary.definition.type === 'select' || primary.definition.type === 'multiselect') {
      pairs.push(['Options', primary.definition.options
        .map((option) => option.label === option.value ? option.label : `${option.label} → ${option.value}`)
        .join('\n') || 'None'])
    } else if (primary.definition.type === 'number' || primary.definition.type === 'slider') {
      const range = [
        primary.definition.min !== undefined ? `min ${primary.definition.min}` : null,
        primary.definition.max !== undefined ? `max ${primary.definition.max}` : null,
        primary.definition.step !== undefined ? `step ${primary.definition.step}` : null,
      ].filter(Boolean).join(' · ')
      if (range) pairs.push(['Range', range])
    }
    for (const [key, value] of pairs) {
      const k = document.createElement('div')
      k.className = 'workshop-detail-key'
      k.textContent = key
      const v = document.createElement('div')
      v.className = 'workshop-detail-value'
      v.textContent = value
      grid.append(k, v)
    }
    detail.append(grid)
    if (!sandboxFormMode) appendSandboxControl(detail, entry)
    else {
      const values = variableSandbox.overlay(effectiveValue().blocks, effectiveValue().promptVariableValues)
      const mockValue = values[primary.blockId]?.[entry.name] ?? primary.storedValue
      const summary = document.createElement('div')
      summary.className = 'workshop-description'
      summary.textContent = `Preview value: ${describePromptVariableValue(primary.definition, mockValue).display}`
      detail.append(summary)
    }

    if (primary.definition.description) {
      const description = document.createElement('div')
      description.className = 'workshop-description'
      description.textContent = primary.definition.description
      detail.append(description)
    }

    const ownerLabel = document.createElement('div')
    ownerLabel.className = 'workshop-section-label'
    ownerLabel.textContent = entry.definitions.length > 1 ? 'DEFINED BY' : 'DEFINED IN'
    detail.append(ownerLabel)
    for (const definition of entry.definitions) {
      const jump = document.createElement('button')
      jump.type = 'button'
      jump.className = 'workshop-link-button'
      jump.textContent = definition.blockName
      jump.addEventListener('click', () => { void requestSelectedBlock(definition.blockId) })
      detail.append(jump)
    }

    const refsLabel = document.createElement('div')
    refsLabel.className = 'workshop-section-label'
    refsLabel.textContent = `REFERENCED BY · ${entry.references.reduce((sum, ref) => sum + ref.count, 0)}×`
    detail.append(refsLabel)
    if (entry.references.length === 0) {
      const none = document.createElement('div')
      none.className = 'workshop-description'
      none.textContent = 'No prompt content currently references this variable.'
      detail.append(none)
    } else {
      for (const reference of entry.references) {
        const jump = document.createElement('button')
        jump.type = 'button'
        jump.className = 'workshop-link-button'
        jump.textContent = `${reference.blockName} · ${reference.count}×`
        jump.title = reference.macros.join('\n')
        jump.addEventListener('click', () => { void requestSelectedBlock(reference.blockId) })
        detail.append(jump)
      }
    }

    container.append(detail)
  }

  function refreshLocalDrafts(): void {
    if (destroyed || !root.isConnected) return
    if (!retainEditorDrafts(['primary', 'secondary'])) return
    recomputeDerived()
    editor.update({ value: localValue(), selectedBlockId })
    secondaryEditor.update({ value: localValue(), selectedBlockId: secondaryBlockId })
    renderPrompts()
    renderVariables()
    setDraftStatus()
    schedulePreview()
    scheduleNativeDecoration()
  }

  function discardLocalDrafts(): void {
    issueReview.clear()
    primaryDraftValue = null
    secondaryDraftValue = null
    editor.destroy()
    secondaryEditor.destroy()
    primaryEditorBase = canonicalValue.blocks
    secondaryEditorBase = canonicalValue.blocks
    editor = mountEditorLane('primary')
    secondaryEditor = mountEditorLane('secondary')
    root.querySelector<HTMLElement>('[data-role="draft-notice"]')!.hidden = true
    root.classList.remove('has-draft-error')
    refreshLocalDrafts()
  }

  async function applyLocalDrafts(): Promise<string | null> {
    if (applyingDrafts) return 'A batch is already being applied.'
    if (!retainEditorDrafts(['primary', 'secondary'])) return 'A prompt draft has an ambiguous identity.'
    if (issueReview.size === 0) { refreshLocalDrafts(); return null }
    const host = ctx.ui.presetEditor.getState()
    if (!host.open || host.presetId !== sessionPresetId) return 'The active preset changed. Reopen Workshop.'
    let applied = false
    let conflict: string | null = null
    applyingDrafts = true
    setDraftStatus()
    try {
      ctx.ui.presetEditor.updatePreset((latest: SpindlePresetEditorDraft) => {
        const result = issueReview.apply(latest.blocks)
        if (!result.ok) { conflict = result.conflict; return latest }
        applied = true
        return { ...latest, blocks: result.blocks }
      })
      if (!applied) return `Prompt ${conflict} changed or disappeared outside Workshop. Your local drafts are retained. Discard drafts to restart from the latest preset.`
      issueReview.clear()
      await ctx.ui.presetEditor.flush()
      return null
    } catch {
      return applied ? 'Applied to the preset draft, but persistence failed. Retry saving the preset.' : 'Could not apply the draft batch. Local edits are retained.'
    } finally {
      applyingDrafts = false
      refreshLocalDrafts()
    }
  }

  root.querySelector<HTMLButtonElement>('[data-action="apply-drafts"]')!.addEventListener('click', async () => {
    const error = await applyLocalDrafts()
    if (destroyed) return
    const notice = root.querySelector<HTMLElement>('[data-role="draft-notice"]')!
    notice.textContent = error ?? ''
    notice.hidden = !error
    root.classList.toggle('has-draft-error', Boolean(error))
  })
  root.querySelector<HTMLButtonElement>('[data-action="discard-drafts"]')!.addEventListener('click', async () => {
    const result = await ctx.ui.showConfirm({ title: 'Discard local drafts?', message: 'Discard all unsynced prompt edits and return to the current preset?', variant: 'warning', confirmLabel: 'Discard drafts' })
    if (!result.confirmed || destroyed || applyingDrafts) return
    discardLocalDrafts()
  })

  function openIssueReview(): void {
    if (destroyed || closeIssueReview) return
    // The review owns an independent editor and only writes on its final Apply.
    const reviewModal = ctx.ui.showModal({ title: 'Review issues', width: window.innerWidth, maxHeight: window.innerHeight, persistent: true })
    const surface = reviewModal.root
    const restoreChrome = installFullscreenModalChrome(surface)
    surface.className = 'workshop-review'
    surface.innerHTML = `<header class="workshop-review-header"><strong>Review issues</strong><span data-review="position"></span><button type="button" class="workshop-text-button" data-review="close">Close</button></header>
      <section class="workshop-review-issue" aria-live="polite"><h3 data-review="title"></h3><p data-review="prompt"></p><p data-review="message"></p><p data-review="state"></p></section>
      <div class="workshop-review-editor" data-review="editor"></div>
      <footer class="workshop-review-footer"><span class="workshop-review-notice" data-review="notice"></span><button class="workshop-text-button" type="button" data-review="previous">Previous</button><button class="workshop-text-button" type="button" data-review="next">Next</button><button class="workshop-text-button" type="button" data-review="recheck">Recheck</button><button class="workshop-text-button" type="button" data-review="discard">Discard drafts</button><button class="workshop-text-button" type="button" data-review="apply">Apply</button></footer>`
    const el = (name: string) => surface.querySelector<HTMLElement>(`[data-review="${name}"]`)!
    const button = (name: string) => el(name) as HTMLButtonElement
    retainEditorDrafts(['primary', 'secondary'])
    let queue = buildReviewIssues(issueReview.overlay(canonicalValue.blocks), canonicalValue.promptVariableValues)
    let position = 0
    let transient: SpindleLoomBlockEditorValue | null = null
    let editorBase = canonicalValue.blocks
    let error = ''
    let closed = false
    let applying = false
    let reviewEditor: SpindleLoomBlockEditorHandle | null = null
    const current = () => queue[position]
    const value = (): SpindleLoomBlockEditorValue => ({ blocks: issueReview.overlay(canonicalValue.blocks), promptVariableValues: canonicalValue.promptVariableValues })
    const editable = () => Boolean(current()?.editable && canonicalValue.blocks.filter((block) => block.id === current().blockId).length === 1)
    const retain = () => {
      if (transient && current() && !issueReview.stage(editorBase, transient.blocks, current().blockId)) error = 'This prompt no longer has a unique identity. Its edit could not be retained.'
      transient = null
    }
    const render = () => {
      const issue = current()
      const blocks = transient?.blocks ?? issueReview.overlay(canonicalValue.blocks)
      const activeIssues = buildReviewIssues(blocks, canonicalValue.promptVariableValues)
      el('position').textContent = issue ? `${position + 1} / ${queue.length}` : '0 issues'
      el('title').textContent = issue?.title ?? 'No remaining issues'
      el('prompt').textContent = issue ? (blocks.find((block) => block.id === issue.blockId)?.name ?? issue.blockId) : ''
      el('message').textContent = issue?.message ?? 'Recheck to refresh the review queue, or Apply your local fixes.'
      el('state').textContent = issue ? (!editable() ? 'Editing unavailable: missing or ambiguous prompt identity.' : activeIssues.some((next) => next.key === issue.key) ? 'Still present' : 'Resolved locally') : ''
      el('notice').textContent = error || `${issueReview.size} prompt drafts kept locally. Save and navigation retain valid drafts here; Apply writes all local drafts to the preset.`
      el('notice').classList.toggle('workshop-review-error', Boolean(error))
      button('previous').disabled = position === 0
      button('next').disabled = position >= queue.length - 1
      button('apply').disabled = applying || (issueReview.size === 0 && !transient) || primaryDraftValue !== null || secondaryDraftValue !== null
      for (const action of ['previous', 'next', 'recheck', 'discard', 'close']) if (applying) button(action).disabled = true
      button('discard').disabled = issueReview.size === 0 && !transient
      if (primaryDraftValue || secondaryDraftValue) el('notice').textContent = 'Save or discard the open Workshop prompt drafts before applying review fixes.'
    }
    const load = () => {
      editorBase = canonicalValue.blocks
      reviewEditor?.update({ value: value(), selectedBlockId: editable() ? current().blockId : null, readOnly: !editable() })
      el('editor').hidden = !editable()
      requestAnimationFrame(() => { if (!closed) decorateNativeMount(el('editor'), false) })
      render()
    }
    reviewEditor = ctx.components.mountLoomBlockEditor(el('editor'), {
      value: value(), selectedBlockId: editable() ? current().blockId : null, compact: false, readOnly: !editable(),
      onDraftChange: (next) => { if (closed) return; transient = next; render() },
      onChange: (next) => {
        if (closed || !current()) return
        if (!issueReview.stage(editorBase, next.blocks, current().blockId)) error = 'Could not retain an ambiguous prompt edit.'
        transient = null
        setDraftStatus()
        render()
      },
      onSelectedBlockChange: () => { if (!closed) load() },
    })
    const finish = () => {
      if (closed) return
      retain()
      closed = true
      closeIssueReview = null
      reviewEditor?.destroy()
      restoreChrome()
      unsubscribe()
      reviewModal.dismiss()
      if (!destroyed) refreshLocalDrafts()
    }
    const unsubscribe = reviewModal.onDismiss(finish)
    closeIssueReview = finish
    button('close').addEventListener('click', finish)
    for (const [name, delta] of [['previous', -1], ['next', 1]] as const) button(name).addEventListener('click', () => {
      retain()
      position = Math.max(0, Math.min(queue.length - 1, position + delta))
      load()
      setDraftStatus()
    })
    button('recheck').addEventListener('click', () => {
      retain()
      queue = buildReviewIssues(issueReview.overlay(canonicalValue.blocks), canonicalValue.promptVariableValues)
      position = 0
      load()
      setDraftStatus()
    })
    button('discard').addEventListener('click', () => {
      transient = null
      discardLocalDrafts()
      error = ''
      queue = buildReviewIssues(canonicalValue.blocks, canonicalValue.promptVariableValues)
      position = 0
      // A fresh mount discards the native editor's currently held draft too.
      finish()
      openIssueReview()
    })
    button('apply').addEventListener('click', async () => {
      if (applying) return
      retain()
      applying = true
      render()
      error = await applyLocalDrafts() ?? ''
      applying = false
      if (closed || destroyed) return
      button('close').disabled = false
      button('recheck').disabled = false
      if (error) { render(); return }
      queue = buildReviewIssues(canonicalValue.blocks, canonicalValue.promptVariableValues)
      position = 0
      load()
      setDraftStatus()
      renderVariables()
    })
    load()
    button('close').focus()
  }

  function diagnosticCount(index: WorkshopVariableIndex): number {
    return index.missing.length
      + index.variables.filter((variable) => variable.duplicateDefinition || variable.unused).length
      + index.duplicateBlockIds.length
  }

  function renderDiagnostics(container: HTMLElement, index: WorkshopVariableIndex): void {
    const diagnostics = document.createElement('div')
    diagnostics.className = 'workshop-diagnostics'
    let count = 0

    for (const missing of index.missing) {
      count += 1
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'workshop-diagnostic-row'
      const title = document.createElement('span')
      title.className = 'workshop-diagnostic-title'
      title.textContent = `Unknown ${missing.macro}`
      const copy = document.createElement('span')
      copy.className = 'workshop-diagnostic-copy'
      copy.textContent = `Referenced by ${missing.references.map((ref) => ref.blockName).join(', ') || 'unknown block'}`
      row.append(title, copy)
      row.addEventListener('click', () => {
        const first = missing.references[0]
        if (first) void requestSelectedBlock(first.blockId)
      })
      diagnostics.append(row)
    }

    for (const entry of index.variables.filter((variable) => variable.duplicateDefinition || variable.unused)) {
      count += 1
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'workshop-diagnostic-row'
      const title = document.createElement('span')
      title.className = 'workshop-diagnostic-title'
      title.textContent = entry.duplicateDefinition ? `Duplicate ${entry.macro}` : `Unused ${entry.macro}`
      const copy = document.createElement('span')
      copy.className = 'workshop-diagnostic-copy'
      copy.textContent = entry.duplicateDefinition
        ? `Defined by ${entry.definitions.map((definition) => definition.blockName).join(', ')}`
        : `Defined in ${entry.definitions[0]?.blockName ?? 'unknown block'}`
      row.append(title, copy)
      row.addEventListener('click', () => {
        selectedVariableName = entry.name
        expandedVariablePane = 'detail'
        renderVariables()
        renderPrompts()
      })
      diagnostics.append(row)
    }

    for (const duplicateId of index.duplicateBlockIds) {
      count += 1
      const row = document.createElement('div')
      row.className = 'workshop-diagnostic-row'
      const title = document.createElement('span')
      title.className = 'workshop-diagnostic-title'
      title.textContent = `Duplicate block id: ${duplicateId}`
      const copy = document.createElement('span')
      copy.className = 'workshop-diagnostic-copy'
      copy.textContent = 'Workshop will refuse an ambiguous targeted write.'
      row.append(title, copy)
      diagnostics.append(row)
    }

    if (count === 0) {
      const clean = document.createElement('div')
      clean.className = 'workshop-description'
      clean.textContent = 'No obvious variable topology problems.'
      diagnostics.append(clean)
    }
    container.append(diagnostics)
  }

  function renderVariables(): void {
    for (const body of variableList.querySelectorAll<HTMLElement>('[data-variable-pane-body]')) {
      variablePaneScroll.set(body.dataset.variablePaneBody ?? '', body.scrollTop)
    }

    const index = variableIndex()
    const query = variableQuery.trim().toLowerCase()
    variableList.replaceChildren()
    variableCount.textContent = `${index.variables.length}`

    if (selectedVariableName && !index.byName.has(selectedVariableName)) selectedVariableName = null
    const selectedEntry = selectedVariableName ? index.byName.get(selectedVariableName) : undefined
    if (!selectedEntry && expandedVariablePane === 'detail') expandedVariablePane = null

    variableList.classList.toggle('has-selection', Boolean(selectedEntry))
    variableList.classList.toggle('has-expanded-pane', Boolean(expandedVariablePane))

    const makePane = (
      id: 'detail' | 'all' | 'diagnostics',
      title: string,
      count: number | string,
    ): { pane: HTMLElement; body: HTMLElement } => {
      const pane = document.createElement('section')
      pane.className = `workshop-variable-pane${expandedVariablePane === id ? ' expanded' : ''}`
      pane.dataset.variablePane = id
      const header = document.createElement('div')
      header.className = 'workshop-variable-pane-header'
      const heading = document.createElement('span')
      heading.className = 'workshop-variable-pane-title'
      heading.textContent = title
      const badge = document.createElement('span')
      badge.className = 'workshop-variable-pane-count'
      badge.textContent = String(count)
      const toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.className = 'workshop-variable-pane-toggle'
      toggle.textContent = expandedVariablePane === id ? 'Show sections' : 'Show more'
      toggle.addEventListener('click', () => {
        expandedVariablePane = expandedVariablePane === id ? null : id
        renderVariables()
      })
      header.append(heading, badge)
      if (id === 'all') {
        const mode = document.createElement('button')
        mode.type = 'button'
        mode.className = 'workshop-variable-pane-toggle'
        mode.textContent = sandboxFormMode ? 'Variable map' : 'Mock values'
        mode.addEventListener('click', () => { sandboxFormMode = !sandboxFormMode; renderVariables() })
        header.append(mode)
      }
      if (id === 'diagnostics') {
        const review = document.createElement('button')
        review.type = 'button'
        review.className = 'workshop-variable-pane-toggle'
        review.textContent = issueReview.size ? `Review issues (${issueReview.size} edits)` : 'Review issues'
        review.disabled = count === 0 && issueReview.size === 0
        review.addEventListener('click', openIssueReview)
        header.append(review)
      }
      header.append(toggle)
      const body = document.createElement('div')
      body.className = 'workshop-variable-pane-body'
      body.dataset.variablePaneBody = id
      pane.append(header, body)
      variableList.append(pane)
      return { pane, body }
    }

    if (selectedEntry) {
      const detailPane = makePane('detail', selectedEntry.definitions[0]?.definition.label || selectedEntry.name, 'Selected')
      appendDefinitionDetail(detailPane.body, selectedEntry)
    }

    const current = selectedBlock()
    const currentNames = current
      ? new Set([
          ...(current.variables ?? []).map((variable) => variable.name),
          ...parsePromptVariableReferences(current.content ?? '').map((reference) => reference.name),
        ])
      : new Set<string>()

    const visibleEntries = index.variables.filter((entry) => {
      const primary = entry.definitions[0]
      const haystack = [
        entry.name,
        entry.macro,
        primary?.definition.label ?? '',
        primary?.definition.description ?? '',
        ...entry.definitions.map((definition) => definition.blockName),
        ...entry.references.map((reference) => reference.blockName),
      ].join('\n').toLowerCase()
      return !query || haystack.includes(query)
    })

    const allPane = makePane('all', 'All variables', visibleEntries.length)
    if (sandboxFormMode) {
      const note = document.createElement('div')
      note.className = 'workshop-description workshop-mock-note'
      note.textContent = 'Mock values · preview only'
      allPane.body.append(note)
      const groups = new Map<string, VariableIndexEntry[]>()
      const visibleNames = new Set(visibleEntries.map((entry) => entry.name))
      for (const block of effectiveValue().blocks) {
        for (const definition of block.variables ?? []) {
          const entry = index.byName.get(definition.name)
          if (!entry || !visibleNames.has(entry.name) || entry.definitions[0]?.blockId !== block.id) continue
          const entries = groups.get(block.id) ?? []
          if (!entries.some((item) => item.name === entry.name)) entries.push(entry)
          groups.set(block.id, entries)
        }
      }
      for (const [blockId, entries] of groups) {
        const section = document.createElement('details')
        section.className = 'workshop-mock-group'
        section.dataset.variableGroup = blockId
        section.open = Boolean(query) || openVariableGroups.has(blockId)
        const summary = document.createElement('summary')
        const title = document.createElement('span')
        title.textContent = entries[0].definitions[0].blockName
        const count = document.createElement('span')
        count.className = 'workshop-variable-refcount'
        count.textContent = `${entries.length} variable${entries.length === 1 ? '' : 's'}`
        summary.append(title, count)
        section.append(summary)
        summary.addEventListener('click', () => {
          if (query) return
          // Capture the user's next state before native toggle is dispatched asynchronously.
          if (section.open) openVariableGroups.delete(blockId)
          else openVariableGroups.add(blockId)
        })
        for (const entry of entries) {
          const row = document.createElement('div')
          row.className = 'workshop-mock-row'
          row.dataset.variableName = entry.name
          const label = document.createElement('button')
          label.type = 'button'
          label.className = 'workshop-mock-title'
          label.textContent = `${entry.definitions[0].definition.label || entry.name}${variableSandbox.has(entry.name) ? ' · Mock' : ''}`
          label.setAttribute('aria-label', `Inspect ${entry.definitions[0].definition.label || entry.name}`)
          label.title = 'View definition and dependencies'
          label.addEventListener('click', () => {
            selectedVariableName = selectedVariableName === entry.name ? null : entry.name
            expandedVariablePane = null
            renderVariables()
            renderPrompts()
          })
          row.append(label)
          appendSandboxControl(row, entry, true)
          section.append(row)
        }
        allPane.body.append(section)
      }
      if (groups.size === 0) {
        const empty = document.createElement('div')
        empty.className = 'workshop-description'
        empty.textContent = query ? 'No variables match this search.' : 'No variables are defined in this preset.'
        allPane.body.append(empty)
      }
    } else {

      const appendCards = (title: string, entries: VariableIndexEntry[]) => {
        if (entries.length === 0) return
        if (title) {
          const section = document.createElement('div')
          section.className = 'workshop-section-label'
          section.textContent = title
          allPane.body.append(section)
        }
        for (const entry of entries) {
          const primary = entry.definitions[0]
          const refCount = entry.references.reduce((sum, ref) => sum + ref.count, 0)
          const card = document.createElement('button')
          card.type = 'button'
          card.className = 'workshop-variable-card'
          if (entry.name === selectedVariableName) card.classList.add('selected')

          const head = document.createElement('span')
          head.className = 'workshop-variable-card-head'
          const label = document.createElement('span')
          label.className = 'workshop-variable-label'
          label.textContent = `${primary?.definition.label || entry.name}${variableSandbox.has(entry.name) ? ' · Mock' : ''}`
          const refs = document.createElement('span')
          refs.className = 'workshop-variable-refcount'
          refs.textContent = `${refCount} ref${refCount === 1 ? '' : 's'}`
          head.append(label, refs)

          const macro = document.createElement('span')
          macro.className = 'workshop-variable-macro'
          macro.textContent = entry.macro
          const owner = document.createElement('span')
          owner.className = 'workshop-variable-owner'
          owner.textContent = primary
            ? entry.definitions.length > 1
              ? `Defined in ${entry.definitions.length} prompts`
              : `Defined in ${primary.blockName}`
            : 'Missing definition'
          card.append(head, macro, owner)
          card.addEventListener('click', () => {
            selectedVariableName = selectedVariableName === entry.name ? null : entry.name
            expandedVariablePane = null
            renderVariables()
            renderPrompts()
          })
          allPane.body.append(card)
        }
      }

      const contextual = visibleEntries.filter((entry) => currentNames.has(entry.name))
      const contextualNames = new Set(contextual.map((entry) => entry.name))
      appendCards(current ? 'This prompt' : '', contextual)
      appendCards(current ? 'Everything else' : '', visibleEntries.filter((entry) => !contextualNames.has(entry.name)))
    }

    const diagnosticsPane = makePane('diagnostics', 'Diagnostics', diagnosticCount(index))
    renderDiagnostics(diagnosticsPane.body, index)

    for (const body of variableList.querySelectorAll<HTMLElement>('[data-variable-pane-body]')) {
      const saved = variablePaneScroll.get(body.dataset.variablePaneBody ?? '') ?? 0
      body.scrollTop = Math.min(saved, Math.max(0, body.scrollHeight - body.clientHeight))
    }
  }

  function renderPreview(): void {
    previewContent.replaceChildren()
    previewElement.classList.toggle('entries-collapsed', previewEntriesCollapsed)
    if (previewCollapsed) return
    const chatId = ctx.getActiveChat().chatId
    if (!chatId) {
      const state = document.createElement('div')
      state.className = 'workshop-preview-state'
      state.textContent = 'Open a chat to resolve runtime macros and assemble the effective prompt.'
      previewContent.append(state)
      previewStatus.textContent = 'No active chat'
      return
    }
    if (previewLoading && !previewResult) {
      const state = document.createElement('div')
      state.className = 'workshop-preview-state'
      state.textContent = 'Assembling preview…'
      previewContent.append(state)
      return
    }
    if (previewError) {
      const state = document.createElement('div')
      state.className = 'workshop-preview-state'
      state.textContent = previewError
      previewContent.append(state)
      return
    }
    if (!previewResult) {
      const state = document.createElement('div')
      state.className = 'workshop-preview-state'
      state.textContent = 'Preview will appear here.'
      previewContent.append(state)
      return
    }

    const query = previewQuery.trim().toLowerCase()
    if (previewTab === 'resolved') {
      const visible = previewResult.messages
        .map((message, index) => ({ message, index, content: messageContentText(message) }))
        .filter(({ message, content }) => !query || [message.role, message.name ?? '', content].join('\n').toLowerCase().includes(query))
      previewStatus.textContent = query
        ? `${visible.length}/${previewResult.messages.length} messages`
        : `${previewResult.messages.length} messages`
      for (const { message, index, content } of visible) {
        const card = document.createElement('article')
        card.className = 'workshop-message'
        const head = document.createElement('div')
        head.className = 'workshop-message-head'
        head.textContent = `${index + 1} · ${message.role}${message.name ? ` · ${message.name}` : ''}`
        const pre = document.createElement('pre')
        pre.textContent = content
        card.append(head, pre)
        previewContent.append(card)
      }
      if (visible.length === 0) {
        const state = document.createElement('div')
        state.className = 'workshop-preview-state'
        state.textContent = 'No dry-run messages match this search.'
        previewContent.append(state)
      }
    } else {
      const visible = previewResult.breakdown
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => !query || [entry.type, entry.name ?? '', entry.role ?? '', entry.content ?? ''].join('\n').toLowerCase().includes(query))
      previewStatus.textContent = query
        ? `${visible.length}/${previewResult.breakdown.length} stack entries`
        : `${previewResult.breakdown.length} stack entries`
      for (const { entry, index } of visible) {
        const row = document.createElement('button')
        row.type = 'button'
        row.className = `workshop-breakdown-row${entry.blockId ? ' has-block' : ''}`
        const head = document.createElement('div')
        head.className = 'workshop-breakdown-head'
        const metadata = [
          `${index + 1}`,
          entry.type,
          entry.name,
          entry.role,
          entry.messageCount !== undefined ? `${entry.messageCount} msg` : undefined,
          entry.preCountedTokens !== undefined ? `${entry.preCountedTokens}t` : undefined,
        ].filter(Boolean).join(' · ')
        head.textContent = metadata
        row.append(head)
        if (entry.content) {
          const pre = document.createElement('pre')
          pre.textContent = entry.content
          row.append(pre)
        }
        if (entry.blockId) row.addEventListener('click', () => { void requestSelectedBlock(entry.blockId!) })
        previewContent.append(row)
      }
      if (visible.length === 0) {
        const state = document.createElement('div')
        state.className = 'workshop-preview-state'
        state.textContent = 'No dry-run stack entries match this search.'
        previewContent.append(state)
      }
    }
  }

  function schedulePreview(immediate = false): void {
    if (destroyed || previewCollapsed) return
    if (previewTimer) clearTimeout(previewTimer)
    const run = () => {
      previewTimer = null
      const chatId = ctx.getActiveChat().chatId
      lastChatId = chatId
      if (!chatId) {
        activePreviewRequestId = null
        previewResult = null
        previewError = null
        previewLoading = false
        renderPreview()
        return
      }
      const value = effectiveValue()
      const requestId = uniqueRequestId(++previewSequence)
      activePreviewRequestId = requestId
      previewLoading = true
      previewError = null
      previewStatus.textContent = 'Assembling…'
      renderPreview()
      ctx.sendToBackend({
        type: 'workshop:assemble',
        requestId,
        chatId,
        blocks: value.blocks,
        promptVariables: variableSandbox.overlay(value.blocks, value.promptVariableValues),
      })
    }
    previewTimer = setTimeout(run, immediate ? 0 : PREVIEW_DEBOUNCE_MS)
  }

  function decorateNativeMount(mount: HTMLElement, sidecar: boolean): void {
    const layout = mount.firstElementChild
    if (!(layout instanceof HTMLElement)) return
    layout.classList.add('workshop-native-layout')

    const textarea = mount.querySelector('textarea')
    if (textarea instanceof HTMLTextAreaElement) textarea.classList.add('workshop-primary-textarea')

    let scroll: HTMLElement | null = null
    if (textarea) {
      let cursor = textarea.parentElement
      while (cursor && cursor !== layout) {
        if (cursor.parentElement === layout) {
          scroll = cursor
          break
        }
        cursor = cursor.parentElement
      }
    }
    if (!scroll) {
      const children = [...layout.children].filter((child): child is HTMLElement => child instanceof HTMLElement)
      scroll = children.find((child) => child.querySelector('textarea')) ?? null
    }
    if (!scroll) return
    scroll.classList.add('workshop-native-scroll')

    const form = scroll.firstElementChild
    if (!(form instanceof HTMLElement)) return
    form.classList.add('workshop-native-form')
    form.classList.remove('workshop-variable-sidecar')
    form.style.removeProperty('--wk-native-pane-height')
    for (const child of [...form.children]) {
      if (!(child instanceof HTMLElement)) continue
      child.classList.remove('workshop-native-main-field', 'workshop-native-variable-root')
      child.style.removeProperty('grid-row')
    }

    if (!sidecar) return
    const variableRoot = form.lastElementChild
    if (!(variableRoot instanceof HTMLElement)) return
    const mainFields = [...form.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child !== variableRoot)
    const formStyle = getComputedStyle(form)
    const paddingTop = Number.parseFloat(formStyle.paddingTop) || 0
    const paddingBottom = Number.parseFloat(formStyle.paddingBottom) || 0
    const nativeViewportHeight = Math.min(scroll.clientHeight, mount.clientHeight || scroll.clientHeight)
    const availablePaneHeight = Math.floor(nativeViewportHeight - paddingTop - paddingBottom)
    if (availablePaneHeight > 0) form.style.setProperty('--wk-native-pane-height', `${availablePaneHeight}px`)
    form.classList.add('workshop-variable-sidecar')
    variableRoot.style.gridRow = `1 / span ${Math.max(1, mainFields.length)}`
    for (const child of [...form.children]) {
      if (!(child instanceof HTMLElement)) continue
      child.classList.add(child === variableRoot ? 'workshop-native-variable-root' : 'workshop-native-main-field')
    }
  }

  let decorationFrame: number | null = null
  function scheduleNativeDecoration(): void {
    if (destroyed || decorationFrame !== null) return
    decorationFrame = requestAnimationFrame(() => {
      decorationFrame = null
      const primary = selectedBlock()
      const useSidecar = Boolean(
        primary
        && !secondaryBlockId
        && primarySlot.clientWidth >= 980
        && (primary.variables?.length ?? 0) > 0,
      )
      decorateNativeMount(editorMount, useSidecar)
      decorateNativeMount(secondaryEditorMount, false)
    })
  }

  const primaryObserver = new MutationObserver(scheduleNativeDecoration)
  const secondaryObserver = new MutationObserver(scheduleNativeDecoration)
  primaryObserver.observe(editorMount, { childList: true, subtree: true })
  secondaryObserver.observe(secondaryEditorMount, { childList: true, subtree: true })
  const editorResizeObserver = new ResizeObserver(scheduleNativeDecoration)
  editorResizeObserver.observe(primarySlot)
  editorResizeObserver.observe(secondarySlot)
  cleanups.push(
    () => primaryObserver.disconnect(),
    () => secondaryObserver.disconnect(),
    () => editorResizeObserver.disconnect(),
  )

  const onViewportResize = () => {
    scheduleNativeDecoration()
  }
  window.addEventListener('resize', onViewportResize)
  cleanups.push(() => window.removeEventListener('resize', onViewportResize))

  function reportWriteFailure(targetId: string, failure: string | null): void {
    if (!failure) return
    console.error(`[Workshop] Refused ambiguous Loom block write for ${targetId}: ${failure}`)
    previewError = `Workshop refused an ambiguous write (${failure}). Reopen the preset before editing further.`
    renderPreview()
  }

  function commitEditorValue(targetId: string | null, value: SpindleLoomBlockEditorValue, lane: 'primary' | 'secondary'): void {
    if (!targetId) {
      console.warn(`[Workshop] Ignored ${lane} native Loom commit without a selected block.`)
      return
    }
    const base = lane === 'primary' ? primaryEditorBase : secondaryEditorBase
    if (!issueReview.stage(base, value.blocks, targetId)) { reportWriteFailure(targetId, 'ambiguous local draft'); return }
    if (lane === 'primary') primaryDraftValue = null
    else secondaryDraftValue = null
    recomputeDerived()
    setDraftStatus()
    renderPrompts()
    renderVariables()
    schedulePreview()
  }

  function syncCanonicalFromHost(): boolean {
    const state = ctx.ui.presetEditor.getState()
    if (!state.open || !state.preset || state.presetId !== sessionPresetId) return false
    const next = editorValueFromHost(ctx)
    if (!next) return false
    retainEditorDrafts(['primary', 'secondary'])
    canonicalValue = next
    latestPresetName = state.preset.name
    presetName.textContent = latestPresetName

    if (selectedBlockId && !canonicalValue.blocks.some((block) => block.id === selectedBlockId)) {
      selectedBlockId = null
      primaryDraftValue = null
    }
    if (secondaryBlockId && !canonicalValue.blocks.some((block) => block.id === secondaryBlockId)) {
      secondaryBlockId = null
      secondaryDraftValue = null
    }
    if (secondaryBlockId && secondaryBlockId === selectedBlockId) {
      secondaryBlockId = null
      secondaryDraftValue = null
    }

    recomputeDerived()
    primaryEditorBase = canonicalValue.blocks
    secondaryEditorBase = canonicalValue.blocks
    editor.update({ value: localValue(), selectedBlockId })
    secondaryEditor.update({ value: localValue(), selectedBlockId: secondaryBlockId })
    renderEditorVisibility()
    renderPrompts()
    renderVariables()
    setDraftStatus()
    scheduleNativeDecoration()
    schedulePreview()
    return true
  }

  const editorGenerations = { primary: 0, secondary: 0 }
  function mountEditorLane(lane: WorkshopEditorSlot): SpindleLoomBlockEditorHandle {
    const generation = ++editorGenerations[lane]
    const alive = () => !destroyed && editorGenerations[lane] === generation
    return ctx.components.mountLoomBlockEditor(lane === 'primary' ? editorMount : secondaryEditorMount, {
      value: localValue(),
      selectedBlockId: lane === 'primary' ? selectedBlockId : secondaryBlockId,
      onSelectedBlockChange: (blockId) => {
        if (!alive()) return
        if (lane === 'primary') void requestSelectedBlock(blockId)
        else void requestSecondaryBlock(blockId === selectedBlockId ? null : blockId)
      },
      onDraftChange: (value) => {
        if (!alive()) return
        if (lane === 'primary') primaryDraftValue = value
        else secondaryDraftValue = value
        recomputeDerived()
        setDraftStatus()
        renderPrompts()
        renderVariables()
        scheduleNativeDecoration()
        schedulePreview()
      },
      onChange: (value) => {
        if (!alive()) return
        commitEditorValue(lane === 'primary' ? selectedBlockId : secondaryBlockId, value, lane)
      },
      compact: false,
      readOnly: false,
    })
  }
  editor = mountEditorLane('primary')
  secondaryEditor = mountEditorLane('secondary')

  async function copyText(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  }

  async function closeWorkshop(force = false): Promise<void> {
    if (destroyed) return
    closeIssueReview?.()
    const dirtyBlocks = [
      primaryDraftValue ? selectedBlock() : null,
      secondaryDraftValue ? secondaryBlock() : null,
    ].filter((block): block is PromptBlockDTO => block !== null)
    if (!force && (dirtyBlocks.length > 0 || issueReview.size > 0)) {
      const names = dirtyBlocks.map((block) => block.name || block.id).join(', ')
      const result = await ctx.ui.showConfirm({
        title: dirtyBlocks.length > 1 ? 'Discard prompt drafts?' : 'Discard prompt draft?',
        message: `${names || 'Issue review'} has unapplied edits${issueReview.size ? `, including ${issueReview.size} locally saved prompts` : ''}. Close Workshop and discard them?`,
        variant: 'warning',
        confirmLabel: 'Discard and close',
      })
      if (!result.confirmed) return
    }
    destroyed = true
    if (previewTimer) clearTimeout(previewTimer)
    if (decorationFrame !== null) cancelAnimationFrame(decorationFrame)
    if (activePreviewRequestId) {
      ctx.sendToBackend({ type: 'workshop:cancel-preview', requestId: activePreviewRequestId })
    }
    for (const cleanup of cleanups.splice(0)) cleanup()
    editor.destroy()
    secondaryEditor.destroy()
    if (!force) {
      try { await ctx.ui.presetEditor.flush() } catch (error) { console.warn('[Workshop] Preset flush failed while closing:', error) }
    }
    modal.dismiss()
    onClosed()
  }

  const modalDismissUnsubscribe = modal.onDismiss(() => {
    if (!destroyed) void closeWorkshop(true)
  })
  cleanups.push(modalDismissUnsubscribe)

  const presetUnsubscribe = ctx.ui.presetEditor.onChange((state) => {
    if (destroyed) return
    if (!state.open || !state.preset || state.presetId !== sessionPresetId) {
      void closeWorkshop(true)
      return
    }
    syncCanonicalFromHost()
  })
  cleanups.push(presetUnsubscribe)

  const backendUnsubscribe = ctx.onBackendMessage((payload) => {
    if (destroyed || !isWorkshopBackendMessage(payload)) return
    if (payload.requestId !== activePreviewRequestId) return
    previewLoading = false
    if (payload.type === 'workshop:assembly-error') {
      previewResult = null
      previewError = payload.error
      previewStatus.textContent = 'Preview failed'
    } else {
      previewResult = payload.result
      previewError = null
      previewStatus.textContent = `${payload.result.messages.length} messages · ${payload.result.breakdown.length} stack entries`
    }
    renderPreview()
  })
  cleanups.push(backendUnsubscribe)

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      if (root.classList.contains('mobile-left-open') || root.classList.contains('mobile-right-open')) {
        closeMobileRails()
        return
      }
      void closeWorkshop()
    }
  }
  window.addEventListener('keydown', onKeyDown)
  cleanups.push(() => window.removeEventListener('keydown', onKeyDown))

  const chatWatch = setInterval(() => {
    if (destroyed) return
    const current = ctx.getActiveChat().chatId
    if (current !== lastChatId) {
      lastChatId = current
      previewResult = null
      previewError = null
      schedulePreview(true)
    }
  }, CHAT_WATCH_MS)
  cleanups.push(() => clearInterval(chatWatch))

  promptSearch.addEventListener('input', () => {
    promptQuery = promptSearch.value
    renderPrompts()
  })
  variableSearch.addEventListener('input', () => {
    variableQuery = variableSearch.value
    renderVariables()
  })
  previewSearch.addEventListener('input', () => {
    previewQuery = previewSearch.value
    renderPreview()
  })

  root.querySelector<HTMLButtonElement>('[data-action="toggle-categories"]')!.addEventListener('click', () => {
    const groups = computePromptGroups(effectiveValue().blocks)
    const categoryIds = groups
      .map((group) => group.categoryBlock?.id ?? null)
      .filter((id): id is string => Boolean(id))
    const allCategoriesCollapsed = categoryIds.length > 0 && categoryIds.every((id) => collapsedCategories.has(id))
    if (allCategoriesCollapsed) {
      collapsedCategories.clear()
    } else {
      collapsedCategories.clear()
      for (const id of categoryIds) collapsedCategories.add(id)
    }
    renderPrompts()
  })

  root.querySelectorAll<HTMLButtonElement>('[data-preview-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      previewTab = tab.dataset.previewTab === 'stack' ? 'stack' : 'resolved'
      root.querySelectorAll('[data-preview-tab]').forEach((other) => other.classList.toggle('active', other === tab))
      renderPreview()
    })
  })

  root.querySelector<HTMLButtonElement>('[data-action="close"]')!.addEventListener('click', () => { void closeWorkshop() })
  leftRailButton.addEventListener('click', () => {
    root.classList.toggle('left-collapsed')
    refreshRailButtons()
    scheduleNativeDecoration()
  })
  rightRailButton.addEventListener('click', () => {
    root.classList.toggle('right-collapsed')
    refreshRailButtons()
    scheduleNativeDecoration()
  })
  root.querySelector<HTMLButtonElement>('[data-action="mobile-left"]')!.addEventListener('click', () => {
    root.classList.toggle('mobile-left-open')
    root.classList.remove('mobile-right-open')
  })
  root.querySelector<HTMLButtonElement>('[data-action="mobile-right"]')!.addEventListener('click', () => {
    root.classList.toggle('mobile-right-open')
    root.classList.remove('mobile-left-open')
  })
  root.querySelector<HTMLButtonElement>('[data-action="refresh"]')!.addEventListener('click', () => schedulePreview(true))
  previewLayoutButton.addEventListener('click', () => {
    previewSplit = !previewSplit
    root.classList.toggle('preview-split', previewSplit)
    previewLayoutButton.innerHTML = previewSplit ? ICONS.bottom : ICONS.split
    previewLayoutButton.title = previewSplit ? 'Move preview to the bottom' : 'Move preview to the side'
    previewLayoutButton.setAttribute('aria-label', previewLayoutButton.title)
    scheduleNativeDecoration()
  })
  previewEntriesCollapseButton.addEventListener('click', () => {
    previewEntriesCollapsed = !previewEntriesCollapsed
    previewEntriesCollapseButton.textContent = previewEntriesCollapsed ? 'Expand' : 'Collapse'
    renderPreview()
  })
  previewCollapseButton.addEventListener('click', () => {
    previewCollapsed = !previewCollapsed
    root.classList.toggle('preview-collapsed', previewCollapsed)
    previewCollapseButton.textContent = previewCollapsed ? 'Show' : 'Hide'
    if (previewCollapsed) {
      if (previewTimer) {
        clearTimeout(previewTimer)
        previewTimer = null
      }
      if (activePreviewRequestId) {
        ctx.sendToBackend({ type: 'workshop:cancel-preview', requestId: activePreviewRequestId })
        activePreviewRequestId = null
      }
      previewLoading = false
      renderPreview()
    } else {
      schedulePreview(true)
    }
  })

  function installResizer(side: 'left' | 'right'): void {
    const handle = root.querySelector<HTMLElement>(`[data-resize="${side}"]`)!
    const onPointerDown = (event: PointerEvent) => {
      if (window.innerWidth <= MOBILE_BREAKPOINT) return
      event.preventDefault()
      handle.setPointerCapture(event.pointerId)
      handle.classList.add('is-dragging')
      const startX = event.clientX
      const style = getComputedStyle(root)
      const startSize = Number.parseFloat(style.getPropertyValue(side === 'left' ? '--wk-left' : '--wk-right')) || (side === 'left' ? 268 : 336)
      const onMove = (move: PointerEvent) => {
        const delta = side === 'left' ? move.clientX - startX : startX - move.clientX
        const min = side === 'left' ? LEFT_MIN : RIGHT_MIN
        const max = side === 'left' ? LEFT_MAX : RIGHT_MAX
        const size = Math.max(min, Math.min(max, startSize + delta))
        root.style.setProperty(side === 'left' ? '--wk-left' : '--wk-right', `${Math.round(size)}px`)
      }
      const onUp = () => {
        handle.classList.remove('is-dragging')
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    }
    handle.addEventListener('pointerdown', onPointerDown)
    cleanups.push(() => handle.removeEventListener('pointerdown', onPointerDown))
  }
  installResizer('left')
  installResizer('right')

  const onPreviewPointerDown = (event: PointerEvent) => {
    if (previewCollapsed) return
    event.preventDefault()
    previewResizer.setPointerCapture(event.pointerId)
    previewResizer.classList.add('is-dragging')
    const style = getComputedStyle(root)
    const sideMode = previewSplit && window.innerWidth > MOBILE_BREAKPOINT
    const start = sideMode
      ? Number.parseFloat(style.getPropertyValue('--wk-preview-width')) || 430
      : Number.parseFloat(style.getPropertyValue('--wk-preview-height')) || 300
    const startPoint = sideMode ? event.clientX : event.clientY

    const onMove = (move: PointerEvent) => {
      if (sideMode) {
        const delta = startPoint - move.clientX
        const max = Math.min(PREVIEW_WIDTH_MAX, Math.max(PREVIEW_WIDTH_MIN, root.clientWidth - 360))
        const size = Math.max(PREVIEW_WIDTH_MIN, Math.min(max, start + delta))
        root.style.setProperty('--wk-preview-width', `${Math.round(size)}px`)
      } else {
        const delta = startPoint - move.clientY
        const max = Math.max(PREVIEW_HEIGHT_MIN, root.clientHeight - 210)
        const size = Math.max(PREVIEW_HEIGHT_MIN, Math.min(max, start + delta))
        root.style.setProperty('--wk-preview-height', `${Math.round(size)}px`)
      }
      scheduleNativeDecoration()
    }
    const onUp = () => {
      previewResizer.classList.remove('is-dragging')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }
  previewResizer.addEventListener('pointerdown', onPreviewPointerDown)
  cleanups.push(() => previewResizer.removeEventListener('pointerdown', onPreviewPointerDown))

  presetName.textContent = latestPresetName
  renderEditorVisibility()
  renderPrompts()
  renderVariables()
  setDraftStatus()
  refreshRailButtons()
  scheduleNativeDecoration()
  schedulePreview(true)

  return {
    destroy: closeWorkshop,
    focus() {
      root.focus({ preventScroll: true })
    },
  }
}

export function setup(ctx: SpindleFrontendContext): () => void {
  const removeStyle = ctx.dom.addStyle(WORKSHOP_CSS)

  // Use the canonical host mount point rather than the registered toolbar-item
  // React bridge. The mount service owns a persistent MutationObserver and
  // reattaches this same root whenever Loom swaps list/edit branches, so the
  // launcher cannot lose an initial deferred-paint registration race.
  const toolbarRoot = ctx.ui.mount('preset_editor_toolbar')
  const launcher = button('workshop-launcher', 'Open Workshop', `${ICONS.workshop}<span>Workshop</span>`)
  toolbarRoot.classList.add('workshop-toolbar-root')
  toolbarRoot.replaceChildren(launcher)

  let session: WorkshopSession | null = null
  let opening = false

  const open = () => {
    if (opening) return
    if (session) {
      session.focus()
      return
    }
    opening = true
    try {
      session = createWorkshopSession(ctx, () => { session = null })
      if (!session) console.warn('[Workshop] Cannot open without an active Loom preset draft.')
    } finally {
      opening = false
    }
  }
  launcher.addEventListener('click', open)

  const unsubscribe = ctx.ui.presetEditor.onChange((state) => {
    if (session && (!state.open || !state.presetId || !state.preset)) {
      void session.destroy(true).finally(() => { session = null })
    }
  })

  return () => {
    launcher.removeEventListener('click', open)
    unsubscribe()
    toolbarRoot.replaceChildren()
    toolbarRoot.classList.remove('workshop-toolbar-root')
    removeStyle()
    const active = session
    session = null
    if (active) void active.destroy(true)
  }
}
