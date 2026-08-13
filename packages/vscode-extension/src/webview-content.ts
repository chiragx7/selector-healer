import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  type VerificationResult,
  loadFingerprints,
  renderSelectorCode,
} from '@selector-healer/core';
import * as vscode from 'vscode';
import { revealSelector } from './apply.js';
import type { StoredSuggestion } from './code-actions.js';
import { type HealerSnapshot, countResults } from './state.js';
import { selectorSignature } from './watch.js';

/** One selector row as the webview renders it. */
export interface DashItem {
  selectorId: string;
  filePath: string;
  fileName: string;
  line: number;
  column: number;
  rawValueLength: number;
  selectorType: string;
  rawValue: string;
  /** The full original locator, reconstructed (e.g. `page.getByRole('button', { name: 'Log in' })`). */
  display: string;
  status: VerificationResult['status'];
  matchCount: number;
  suggestion?: {
    code: string;
    pct: number;
    /** Per-rule contributions behind `pct`, biggest first - the "Why NN%?" explainer. */
    breakdown?: Array<{ name: string; pct: number }>;
    /** Adaptive-learning nudge note, when one was applied to this suggestion. */
    learningNote?: string;
  };
  /** Runner-up heal candidates (2nd, 3rd), so the user can pick a different fix. */
  alternatives?: Array<{ code: string; pct: number; reasoning?: string }>;
  /** Top "why it broke" reason, shown inline on the card. */
  reason?: string;
  error?: string;
}

/** One row in the live capture view. */
export interface CaptureRow {
  selectorId: string;
  rawValue: string;
  selectorType: string;
  fileName: string;
  line: number;
}

/** One selector in the baseline inventory view (captured or not). */
export interface BaselineRow {
  selectorId: string;
  /** Full reconstructed locator for display. */
  display: string;
  fileName: string;
  filePath: string;
  line: number;
  column: number;
  rawValueLength: number;
  /** Whether this selector has a captured fingerprint on disk. */
  captured: boolean;
  /** ISO 8601 time it was captured, if captured. */
  capturedAt?: string;
  pageUrl?: string;
}

/** One applied-heal entry in the history view. */
export interface HistoryRow {
  id: string;
  /** Short human summary, e.g. `'button' → getByTestId('save')`. */
  label: string;
  fileName: string;
  filePath: string;
  line: number;
  column: number;
  /** Epoch ms when the heal was applied. */
  appliedAt: number;
}

export type CaptureStatus = 'pending' | 'capturing' | 'captured' | 'missed';

/**
 * A surface that can render live capture progress. Both the sidebar view and the
 * editor panel implement this so a capture run broadcasts to whichever are open.
 */
export interface CaptureSink {
  focus(): Promise<void>;
  startCapture(rows: CaptureRow[]): void;
  updateCapture(selectorId: string, status: CaptureStatus): void;
  finishCapture(captured: number, total: number): void;
}

/** Which surface a webview is rendering as - drives the roomier panel layout. */
export type WebviewMode = 'sidebar' | 'panel';

/** Messages posted from either webview back to the extension host. */
export interface DashMessage {
  type:
    | 'verify'
    | 'capture'
    | 'captureMissing'
    | 'applyAll'
    | 'open'
    | 'apply'
    | 'preview'
    | 'watchToggle'
    | 'showBaseline'
    | 'showOverview'
    | 'prune'
    | 'ready'
    | 'init'
    | 'dismiss'
    | 'restore'
    | 'showHistory'
    | 'undo'
    | 'clearHistory';
  filePath?: string;
  line?: number;
  column?: number;
  rawValue?: string;
  rawValueLength?: number;
  replacementCode?: string;
  /** Selector id for a dismiss/restore action. */
  selectorId?: string;
  /** History entry id for an undo action. */
  entryId?: string;
}

const STATUS_ORDER: Record<string, number> = {
  broken: 0,
  'multiple-matches': 1,
  'page-load-failed': 2,
  skipped: 3,
  ok: 4,
};

/** Config filenames cosmiconfig discovers - used to detect a first-run (no config). */
export const CONFIG_FILES = [
  'selector-healer.config.ts',
  'selector-healer.config.js',
  'selector-healer.config.mjs',
  'selector-healer.config.cjs',
];

/** True when a selector-healer config exists in the workspace root. */
export function hasWorkspaceConfig(): boolean {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return false;
  return CONFIG_FILES.some((f) => existsSync(join(root, f)));
}

/**
 * How many selectors have a captured baseline on disk. Lets the panel tell a
 * genuinely-fresh project (offer Capture) apart from a reloaded one whose
 * baseline already exists (offer Verify).
 */
export function baselineCount(): number {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return 0;
  const result = loadFingerprints(root);
  return result.isOk() ? result.value.size : 0;
}

/**
 * The rules that actually contributed to a candidate's confidence, biggest
 * contribution first, as `{ name, pct }` where `pct` is the rule's match
 * quality. Powers the inline "Why NN%?" breakdown. Returns undefined when there's
 * nothing to show (e.g. a restored suggestion with no stored rule data).
 */
function confidenceBreakdown(
  ruleScores: StoredSuggestion['ruleScores'],
): Array<{ name: string; pct: number }> | undefined {
  if (!ruleScores?.length) return undefined;
  const rows = ruleScores
    .filter((r) => r.quality > 0)
    .sort((a, b) => b.weighted - a.weighted)
    .slice(0, 6)
    .map((r) => ({ name: r.name, pct: Math.round(r.quality * 100) }));
  return rows.length ? rows : undefined;
}

/** Map one verification result into the flat row the webview renders. */
function toDashItem(r: VerificationResult, snap: HealerSnapshot): DashItem {
  const sel = r.selector;
  const cands = snap.suggestionsByKey.get(`${sel.filePath}:${sel.line}`) ?? [];
  const [top, ...rest] = cands;
  return {
    selectorId: sel.id,
    filePath: sel.filePath,
    fileName: sel.filePath.split(/[/\\]/).pop() ?? sel.filePath,
    line: sel.line,
    column: sel.column,
    rawValueLength: sel.rawValue.length,
    selectorType: sel.selectorType,
    rawValue: sel.rawValue,
    // Reconstruct the full original locator so the card reads the same as the
    // suggested fix below it; fall back to the raw value for non-Playwright.
    display: renderSelectorCode(sel, sel.framework) ?? sel.rawValue,
    status: r.status,
    matchCount: r.matchCount,
    suggestion: top
      ? {
          code: top.replacementCode,
          pct: Math.round(top.confidence * 100),
          breakdown: confidenceBreakdown(top.ruleScores),
          learningNote: top.learningNote,
        }
      : undefined,
    // Runner-up candidates (deduped by code against the top) for "preview all".
    alternatives: rest.length
      ? rest.map((c) => ({
          code: c.replacementCode,
          pct: Math.round(c.confidence * 100),
          reasoning: c.reasoning,
        }))
      : undefined,
    reason: snap.explanationsById.get(sel.id),
    error: r.error,
  };
}

const ATTENTION_STATUSES: ReadonlySet<VerificationResult['status']> = new Set([
  'broken',
  'multiple-matches',
  'page-load-failed',
]);

/** True when a result is currently Skipped (dismissed) *and* still needs attention. */
function isDismissedAttention(r: VerificationResult, snap: HealerSnapshot): boolean {
  return (
    ATTENTION_STATUSES.has(r.status) && snap.dismissedSignatures.has(selectorSignature(r.selector))
  );
}

/**
 * Results minus the ones the user has Skipped - the set every "attention" surface
 * (dashboard health, status bar count, Heal-All) should agree on, so a dismissed
 * selector doesn't get counted or auto-healed behind the user's back.
 */
export function activeResults(snap: HealerSnapshot): VerificationResult[] {
  return snap.results.filter((r) => !isDismissedAttention(r, snap));
}

function byStatusThenLocation(a: DashItem, b: DashItem): number {
  const sa = STATUS_ORDER[a.status] ?? 9;
  const sb = STATUS_ORDER[b.status] ?? 9;
  if (sa !== sb) return sa - sb;
  return a.fileName.localeCompare(b.fileName) || a.line - b.line;
}

/**
 * Shape a snapshot into the sorted rows the webview renders. Selectors the user
 * has "Skipped" (their signature is in `dismissedSignatures`) that are still in
 * an attention state are pulled out of `items` (and the health counts) into a
 * separate `dismissed` list; everything else stays active. An edited selector
 * has a new signature, so it re-surfaces automatically.
 */
export function serialize(snap: HealerSnapshot): {
  phase: string;
  counts: ReturnType<typeof countResults>;
  items: DashItem[];
  dismissed: DashItem[];
  lastRunAt?: number;
} {
  const active: VerificationResult[] = [];
  const dismissed: VerificationResult[] = [];
  for (const r of snap.results) {
    (isDismissedAttention(r, snap) ? dismissed : active).push(r);
  }

  const items = active.map((r) => toDashItem(r, snap)).sort(byStatusThenLocation);
  const dismissedItems = dismissed.map((r) => toDashItem(r, snap)).sort(byStatusThenLocation);

  return {
    phase: snap.phase,
    counts: countResults(active),
    items,
    dismissed: dismissedItems,
    lastRunAt: snap.lastRunAt,
  };
}

/**
 * Handle a message posted from either webview by dispatching to the matching
 * command. The `ready` handshake is surface-specific and handled by each host;
 * everything else routes through here so both surfaces behave identically.
 */
export async function handleWebviewMessage(msg: DashMessage): Promise<void> {
  switch (msg.type) {
    case 'verify':
      await vscode.commands.executeCommand('selectorHealer.verify');
      break;
    case 'capture':
      await vscode.commands.executeCommand('selectorHealer.capture');
      break;
    case 'captureMissing':
      await vscode.commands.executeCommand('selectorHealer.captureMissing');
      break;
    case 'init':
      await vscode.commands.executeCommand('selectorHealer.init');
      break;
    case 'applyAll':
      await vscode.commands.executeCommand('selectorHealer.applyAllFixes');
      break;
    case 'watchToggle':
      await vscode.commands.executeCommand('selectorHealer.toggleWatch');
      break;
    case 'prune':
      await vscode.commands.executeCommand('selectorHealer.pruneStale');
      break;
    case 'dismiss':
      if (msg.selectorId)
        await vscode.commands.executeCommand('selectorHealer.dismiss', msg.selectorId);
      break;
    case 'restore':
      if (msg.selectorId)
        await vscode.commands.executeCommand('selectorHealer.restore', msg.selectorId);
      break;
    case 'open':
      if (msg.filePath && msg.line && msg.column) {
        await revealSelector(msg.filePath, msg.line, msg.column, msg.rawValueLength ?? 1);
      }
      break;
    case 'apply':
    case 'preview':
      if (msg.filePath && msg.line && msg.column && msg.replacementCode) {
        const s: StoredSuggestion = {
          selectorId: '',
          filePath: msg.filePath,
          line: msg.line,
          column: msg.column,
          rawValue: msg.rawValue ?? '',
          replacementCode: msg.replacementCode,
          confidence: 1,
        };
        await vscode.commands.executeCommand(
          msg.type === 'apply' ? 'selectorHealer.applyFixAt' : 'selectorHealer.previewFixAt',
          s,
        );
      }
      break;
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/**
 * Build the full webview document for a surface. Both the sidebar and the editor
 * panel share one stylesheet + script; `mode` swaps in the panel's centered,
 * multi-column layout and its own header toolbar.
 */
export function buildWebviewHtml(cspSource: string, mode: WebviewMode): string {
  const nonce = makeNonce();
  const csp = [
    "default-src 'none'",
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  const header =
    mode === 'panel'
      ? `<header class="phead"><span class="ptitle">🛡️ Selector Healer</span>
    <div class="ptools">
      <button class="btn" id="p-verify">Verify now</button>
      <button class="btn" id="p-capture">Capture</button>
      <button class="btn" id="p-watch">Watch</button>
    </div></header>`
      : '';

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>${STYLES}</style>
</head>
<body data-mode="${mode}">
  ${header}
  <div id="verifying-banner" class="vbanner" style="display:none"></div>
  <nav id="tabs" class="tabs" style="display:none"></nav>
  <div id="app"><div class="empty">Loading…</div></div>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

const STYLES = /* css */ `
:root { --ok: var(--vscode-charts-green, #3fb950); --broken: var(--vscode-charts-red, #f85149); --multi: var(--vscode-charts-yellow, #d29922); --skip: var(--vscode-descriptionForeground, #8b949e); --run: var(--vscode-charts-blue, #58a6ff); --stale: var(--vscode-charts-orange, #db6d28); }
* { box-sizing: border-box; }
body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); margin: 0; padding: 0; }
.muted { color: var(--vscode-descriptionForeground); }
.mono { font-family: var(--vscode-editor-font-family, monospace); }
#app { padding: 12px 12px 22px; }
.empty { text-align: center; color: var(--vscode-descriptionForeground); padding: 26px 12px; line-height: 1.6; }
.empty .big { font-size: 26px; opacity: .5; display: block; margin-bottom: 6px; }
.btn { cursor: pointer; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.15)); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border-radius: 5px; font-size: 12px; padding: 5px 10px; }
.btn:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,.25)); }
.btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
.btn.primary:hover { background: var(--vscode-button-hoverBackground); }
.btn svg { flex: none; }
.rhead { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
.rlinks { display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end; flex: none; }
.hpct { font-size: 30px; font-weight: 600; line-height: 1; }
.hsub { font-size: 12px; color: var(--vscode-descriptionForeground); margin-left: 8px; }
.lastrun { font-size: 11px; margin-top: 4px; }
.hbar { display: flex; height: 8px; border-radius: 5px; overflow: hidden; margin: 11px 0 12px; background: rgba(128,128,128,.18); }
.hbar > span { display: block; height: 100%; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
.chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; padding: 4px 9px; border-radius: 8px; background: var(--vscode-badge-background, rgba(128,128,128,.16)); }
.dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.vbanner { display: flex; align-items: center; gap: 8px; padding: 8px 12px; font-size: 12px; color: var(--vscode-foreground); background: color-mix(in srgb, var(--run) 16%, transparent); border-bottom: 1px solid color-mix(in srgb, var(--run) 34%, transparent); }
.watch { display: flex; align-items: center; gap: 8px; background: color-mix(in srgb, var(--run) 13%, transparent); border: 1px solid color-mix(in srgb, var(--run) 32%, transparent); border-radius: 8px; padding: 7px 10px; margin-bottom: 14px; font-size: 12px; }
.watch .dot { background: var(--run); animation: pulse 1.7s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .3; } }
.link { cursor: pointer; color: var(--vscode-textLink-foreground); background: none; border: none; padding: 0; font-size: 11.5px; }
.heal-all { width: 100%; padding: 8px; margin-bottom: 14px; font-weight: 600; display: flex; align-items: center; justify-content: center; gap: 6px; }
.filter { display: flex; gap: 3px; background: rgba(128,128,128,.12); border-radius: 7px; padding: 3px; margin-bottom: 12px; }
.seg { flex: 1; text-align: center; font-size: 11.5px; padding: 5px 4px; border-radius: 5px; color: var(--vscode-descriptionForeground); cursor: pointer; border: none; background: transparent; }
.seg:hover { color: var(--vscode-foreground); }
.seg.on { background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); color: var(--vscode-foreground); box-shadow: 0 0 0 1px var(--vscode-panel-border, rgba(128,128,128,.3)); }
.seg .n { opacity: .55; margin-left: 3px; }
.list { display: block; }
.card { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.22)); border-radius: 10px; padding: 10px 11px; margin-bottom: 8px; background: var(--vscode-editorWidget-background, transparent); }
.chead { display: flex; align-items: center; gap: 7px; margin-bottom: 7px; }
.loc { font-size: 11.5px; color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
.loc:hover { text-decoration: underline; }
.badge { margin-left: auto; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .4px; padding: 2px 7px; border-radius: 5px; }
.code { font-size: 11.5px; line-height: 1.5; word-break: break-all; color: var(--vscode-descriptionForeground); }
.why { display: flex; gap: 6px; font-size: 11.5px; color: var(--vscode-descriptionForeground); margin-top: 7px; }
.why svg { flex: none; margin-top: 1px; color: var(--multi); }
.fix { border-radius: 8px; padding: 7px 9px; margin-top: 9px; background: color-mix(in srgb, var(--ok) 11%, transparent); }
.fixhead { display: flex; justify-content: space-between; font-size: 10.5px; margin-bottom: 4px; }
.confbar { height: 3px; border-radius: 2px; background: rgba(128,128,128,.25); margin-top: 6px; overflow: hidden; }
.confbar > span { display: block; height: 100%; }
.whyconf { margin-top: 7px; }
.whyconf > summary { cursor: pointer; font-size: 10.5px; color: var(--vscode-descriptionForeground); user-select: none; }
.whyconf > summary:hover { color: var(--vscode-foreground); }
.learned { margin-top: 7px; font-size: 10.5px; color: var(--vscode-descriptionForeground); line-height: 1.4; }
.rule { display: flex; align-items: center; gap: 7px; margin-top: 5px; font-size: 10.5px; }
.rname { flex: 0 0 44%; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rbar { flex: 1; height: 3px; border-radius: 2px; background: rgba(128,128,128,.22); overflow: hidden; }
.rbar > span { display: block; height: 100%; }
.rpct { flex: 0 0 30px; text-align: right; }
.actions { display: flex; gap: 6px; margin-top: 9px; }
.actions .btn { flex: 1; display: flex; align-items: center; justify-content: center; gap: 5px; }
.actions .btn.icon { flex: 0 0 32px; padding: 5px; }
.alts { margin-top: 9px; }
.alts > summary { cursor: pointer; font-size: 11px; color: var(--vscode-textLink-foreground); padding: 3px 0; user-select: none; }
.alts > summary:hover { text-decoration: underline; }
.alt { border-top: 1px dashed var(--vscode-panel-border, rgba(128,128,128,.25)); padding: 8px 0 2px; margin-top: 8px; }
.alt .fixhead { font-size: 10.5px; }
.alt .code { margin-top: 4px; }
.alt-why { font-size: 11px; margin-top: 6px; line-height: 1.4; display: flex; }
.skip { margin-left: 8px; flex: none; cursor: pointer; border: none; background: transparent; color: var(--vscode-descriptionForeground); font-size: 10.5px; padding: 2px 7px; border-radius: 5px; }
.skip:hover { color: var(--vscode-foreground); background: rgba(128,128,128,.16); }
.dismissed { margin-top: 14px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); padding-top: 8px; }
.dismissed > summary { cursor: pointer; font-size: 11.5px; color: var(--vscode-descriptionForeground); padding: 3px 0; user-select: none; }
.dismissed > summary:hover { color: var(--vscode-foreground); }
.dismissed .compact:last-child { border-bottom: none; }
.compact { display: flex; align-items: center; gap: 8px; padding: 6px 4px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.1)); }
.compact .csel { margin-left: auto; max-width: 52%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 6px; }
.running { display: flex; align-items: center; gap: 8px; color: var(--vscode-descriptionForeground); padding: 8px 0; }
.spinner { width: 13px; height: 13px; border: 2px solid rgba(128,128,128,.4); border-top-color: var(--run); border-radius: 50%; animation: spin .8s linear infinite; display: inline-block; }
@keyframes spin { to { transform: rotate(360deg); } }
.secttl { font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: var(--vscode-descriptionForeground); margin: 4px 2px 8px; }
.pbar { height: 6px; border-radius: 4px; background: rgba(128,128,128,.22); overflow: hidden; margin: 2px 0 12px; }
.pbar > span { display: block; height: 100%; transition: width .2s ease; }
.caphead { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.caprow { display: flex; align-items: center; gap: 8px; padding: 5px 4px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.1)); }
.caprow.pending { opacity: .5; }
.capicon { width: 16px; text-align: center; flex: none; font-size: 12px; }
.capsel { flex: 1; font-size: 11.5px; word-break: break-all; }
.caploc { font-size: 10.5px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
.tag { font-size: 9.5px; font-weight: 600; padding: 1px 5px; border-radius: 3px; white-space: nowrap; }
.tag.pass { color: var(--ok); background: color-mix(in srgb, var(--ok) 18%, transparent); }
.tag.fail { color: var(--broken); background: color-mix(in srgb, var(--broken) 18%, transparent); }
.ob { max-width: 360px; margin: 0 auto; padding: 20px 6px; }
.ob-hero { text-align: center; margin-bottom: 20px; }
.ob-badge { width: 46px; height: 46px; border-radius: 13px; background: color-mix(in srgb, var(--run) 16%, transparent); color: var(--run); display: flex; align-items: center; justify-content: center; margin: 0 auto 13px; }
.ob-h1 { font-size: 18px; font-weight: 600; margin-bottom: 9px; }
.ob-lead { font-size: 12.5px; color: var(--vscode-descriptionForeground); line-height: 1.55; margin-bottom: 13px; }
.ob-pill { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--vscode-descriptionForeground); background: var(--vscode-badge-background, rgba(128,128,128,.16)); border-radius: 20px; padding: 4px 11px; }
.ob-note { font-size: 12.5px; text-align: center; margin-bottom: 14px; line-height: 1.5; }
.ob-steps { display: flex; flex-direction: column; gap: 13px; margin-bottom: 20px; }
.ob-step { display: flex; gap: 11px; align-items: flex-start; }
.ob-st { font-size: 13px; font-weight: 600; margin-bottom: 1px; }
.ob-sd { font-size: 12px; }
.ob-num { flex: none; width: 21px; height: 21px; border-radius: 50%; background: color-mix(in srgb, var(--run) 18%, transparent); color: var(--run); display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; margin-top: 1px; }
.ob-actions { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
.ob-cta { padding: 8px 18px; }
/* - Panel (editor) mode: roomier, centered, multi-column - */
.phead { display: flex; align-items: center; gap: 12px; padding: 13px 28px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); position: sticky; top: 0; background: var(--vscode-editor-background); z-index: 3; }
.ptitle { font-size: 15px; font-weight: 600; }
.ptools { margin-left: auto; display: flex; gap: 8px; }
body[data-mode="panel"] #app { max-width: 1120px; margin: 0 auto; padding: 22px 28px 44px; }
body[data-mode="panel"] .hpct { font-size: 40px; }
body[data-mode="panel"] .hsub { font-size: 13px; }
body[data-mode="panel"] .chip { font-size: 12.5px; padding: 5px 11px; }
body[data-mode="panel"] .heal-all { width: auto; padding: 9px 20px; }
body[data-mode="panel"] .list { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 10px; align-items: start; }
body[data-mode="panel"] .compact { grid-column: 1 / -1; }

/* - Overview (analytics home) - */
.tabs { display: flex; gap: 2px; padding: 8px 12px 0; }
body[data-mode="panel"] .tabs { max-width: 1120px; margin: 0 auto; padding: 14px 28px 0; }
.navtab { flex: none; background: none; border: none; cursor: pointer; font-size: 12.5px; color: var(--vscode-descriptionForeground); padding: 6px 12px; border-radius: 6px 6px 0 0; }
.navtab:hover { color: var(--vscode-foreground); }
.navtab.on { color: var(--vscode-foreground); background: var(--vscode-editorWidget-background, rgba(128,128,128,.1)); box-shadow: inset 0 -2px 0 var(--run); }
.ov-proj { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; font-size: 12px; color: var(--vscode-descriptionForeground); }
.ov-projname { color: var(--vscode-foreground); font-weight: 600; font-size: 13px; }
.ov-badge { font-size: 11px; color: var(--vscode-foreground); background: var(--vscode-badge-background, rgba(128,128,128,.16)); padding: 2px 8px; border-radius: 20px; }
.ov-badge-fw { background: color-mix(in srgb, var(--run) 20%, transparent); }
.ov-purl { font-size: 11.5px; color: var(--vscode-descriptionForeground); }
.ov-spacer { flex: 1; }
.ov-last { font-size: 11.5px; }
.ov-grid { display: grid; grid-template-columns: 1fr; gap: 10px; }
body[data-mode="panel"] .ov-grid { grid-template-columns: repeat(3, 1fr); }
.ov-card { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.22)); border-radius: 10px; padding: 12px 13px; background: var(--vscode-editorWidget-background, transparent); display: flex; flex-direction: column; }
.ov-card-h { font-size: 12px; font-weight: 600; margin-bottom: 11px; display: flex; align-items: center; gap: 7px; flex: none; }
.ov-cardbody { flex: 1; display: flex; flex-direction: column; }
.ov-cardbody.ov-center { justify-content: center; }
.ov-hchip { font-weight: 400; font-size: 10.5px; color: var(--vscode-descriptionForeground); background: rgba(128,128,128,.14); padding: 1px 6px; border-radius: 4px; }
.ov-hero { display: flex; align-items: center; gap: 14px; margin-bottom: 11px; }
.ov-ring { width: 96px; height: 96px; flex: none; }
.ov-ring-n { fill: var(--vscode-foreground); font-size: 21px; font-weight: 700; }
.ov-ring-s { fill: var(--vscode-descriptionForeground); font-size: 10px; }
.ov-legend { display: flex; flex-direction: column; gap: 6px; font-size: 12px; min-width: 0; }
.ov-lg { display: flex; align-items: center; gap: 7px; }
.ov-lg i { width: 9px; height: 9px; border-radius: 2px; flex: none; }
.ov-hint { font-size: 10.5px; color: var(--vscode-descriptionForeground); line-height: 1.35; max-width: 160px; }
.ov-foot { margin-top: auto; width: 100%; justify-content: center; }
.ov-warn { color: var(--stale); border-color: color-mix(in srgb, var(--stale) 55%, transparent); background: color-mix(in srgb, var(--stale) 12%, transparent); font-weight: 600; }
.ov-warn:hover { background: color-mix(in srgb, var(--stale) 20%, transparent); }
.ov-cta { margin-top: 8px; }
.ov-empty2 { display: flex; flex-direction: column; align-items: flex-start; gap: 9px; font-size: 12px; padding: 4px 0 2px; }
.ov-big { font-size: 32px; font-weight: 700; line-height: 1; margin-bottom: 11px; }
.ov-big-s { font-size: 12px; font-weight: 400; color: var(--vscode-descriptionForeground); margin-left: 7px; }
.ov-stack { display: flex; height: 9px; border-radius: 5px; overflow: hidden; background: rgba(128,128,128,.18); margin-bottom: 10px; }
.ov-stack > span { display: block; height: 100%; }
.ov-tierlegend { display: flex; flex-wrap: wrap; gap: 8px 12px; font-size: 11px; color: var(--vscode-descriptionForeground); }
.ov-tl { display: inline-flex; align-items: center; gap: 5px; }
.ov-tl i { width: 8px; height: 8px; border-radius: 2px; }
.ov-spark { width: 100%; height: 42px; display: block; margin-bottom: 8px; }
.ov-trend-foot { display: flex; align-items: baseline; gap: 8px; }
.ov-big2 { font-size: 22px; font-weight: 700; }
.ov-delta { font-size: 11.5px; }
.ov-bars { display: flex; flex-direction: column; gap: 7px; }
.ov-bar { display: grid; grid-template-columns: 96px 1fr 24px; align-items: center; gap: 9px; font-size: 11.5px; }
.ov-bl { color: var(--vscode-descriptionForeground); font-size: 10.5px; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ov-bt { background: rgba(128,128,128,.15); border-radius: 4px; height: 13px; overflow: hidden; }
.ov-bt i { display: block; height: 100%; border-radius: 4px; }
.ov-bn { font-weight: 600; text-align: right; }
.ov-files { display: flex; flex-direction: column; gap: 8px; }
.ov-file { display: grid; grid-template-columns: 118px 1fr 26px; align-items: center; gap: 9px; font-size: 12px; }
.ov-fn { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ov-fbar { background: rgba(128,128,128,.15); border-radius: 4px; height: 7px; overflow: hidden; }
.ov-fbar i { display: block; height: 100%; }
.ov-fc { text-align: right; font-weight: 700; }
.ov-stats2 { display: flex; gap: 18px; margin-bottom: 11px; }
.ov-stat-n { font-size: 28px; font-weight: 700; line-height: 1; }
.ov-stat-l { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 3px; }
.ov-mini { display: flex; flex-direction: column; gap: 5px; margin-bottom: 11px; }
.ov-mini-row { display: flex; justify-content: space-between; font-size: 11.5px; color: var(--vscode-descriptionForeground); }
.ov-mini-row b { color: var(--vscode-foreground); }
.ov-tooling { display: flex; flex-wrap: wrap; margin-top: 12px; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.22)); border-radius: 10px; overflow: hidden; }
.ov-tool { flex: 1; min-width: 140px; padding: 10px 13px; border-right: 1px solid var(--vscode-panel-border, rgba(128,128,128,.16)); display: flex; flex-direction: column; gap: 3px; }
.ov-tool:last-child { border-right: none; }
.ov-tk { font-size: 9.5px; text-transform: uppercase; letter-spacing: .6px; color: var(--vscode-descriptionForeground); }
.ov-tv { font-size: 11.5px; }
`;

const SCRIPT = /* js */ `
const vscode = acquireVsCodeApi();
const app = document.getElementById('app');
const MODE = document.body.dataset.mode || 'sidebar';

let lastState = null;    // verify payload (+ watch, hasConfig)
let capture = null;      // { rows, summary }
let baselineRows = null; // [{ display, captured, ... }] for the baseline view
let historyEntries = null; // [{ id, label, fileName, line, appliedAt }] for the history view
let overview = null;     // OverviewData for the analytics home
let overviewRequested = false; // guards a single initial fetch of the overview
let mode = 'overview';   // 'overview' | 'results' | 'capture' | 'baseline' | 'history'
let filter = 'all';      // all | broken | ambiguous | healthy
let baselineFilter = 'all'; // all | captured | uncaptured

const ICON = {
  why:  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="6.4"/><path d="M8 7.2v3.4M8 4.7h.01" stroke-linecap="round"/></svg>',
  check:'<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 4.5 6.5 12 3 8.5"/></svg>',
  diff: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 2 2 5l3 3M2 5h7a2 2 0 0 1 2 2v2M11 14l3-3-3-3M14 11H7a2 2 0 0 1-2-2V7"/></svg>',
  open: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3H3v10h10v-3M9.5 3H13v3.5M13 3 7.5 8.5"/></svg>',
  heal: '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M8 1.2l1.35 3.28L13 5.1l-2.6 2.3.75 3.6L8 9.3 4.85 11l.75-3.6L3 5.1l3.65-.62z"/></svg>',
  shield:'<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.6-3.1 7.6-7 9-3.9-1.4-7-4.4-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>',
  lock:  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3.5" y="7" width="9" height="6.2" rx="1.6"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7"/></svg>'
};

function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function relTime(ms){ const s=Math.max(0,Math.round((Date.now()-ms)/1000)); if(s<60)return s+'s ago'; const m=Math.round(s/60); if(m<60)return m+'m ago'; const h=Math.round(m/60); if(h<24)return h+'h ago'; return Math.round(h/24)+'d ago'; }
function barColor(p){return p>=80?'var(--ok)':p>=50?'var(--multi)':'var(--broken)';}
function statusColor(s){return s==='broken'?'var(--broken)':s==='multiple-matches'?'var(--multi)':s==='ok'?'var(--ok)':'var(--skip)';}
function post(type,extra){vscode.postMessage(Object.assign({type:type},extra||{}));}

function render(){
  renderTabs();
  if(mode==='overview') renderOverview();
  else if(mode==='capture' && capture) renderCapture();
  else if(mode==='baseline' && baselineRows) renderBaseline();
  else if(mode==='history' && historyEntries) renderHistory();
  else renderResults();
  bind();
}

/* Persistent top nav. Hidden on first-run (no config) and during a capture run. */
function renderTabs(){
  const t = document.getElementById('tabs');
  if(!t) return;
  const show = lastState && lastState.hasConfig && mode!=='capture';
  if(!show){ t.style.display='none'; t.innerHTML=''; return; }
  t.style.display='flex';
  const tabs=[['overview','Overview'],['results','Results'],['baseline','Baseline'],['history','History']];
  t.innerHTML = tabs.map(x=>'<button class="navtab'+(mode===x[0]?' on':'')+'" data-tab="'+x[0]+'">'+x[1]+'</button>').join('');
}

/* Switch tabs. Baseline/History fetch their data (the reply sets the mode); the
   Overview is always re-fetched so its baseline/stale/trend stay fresh. */
function switchTab(t){
  // Baseline/History: the data reply flips the mode (avoids a flash of the empty
  // list before rows arrive). Overview: switch now and show a skeleton until data.
  if(t==='baseline'){ post('showBaseline'); }
  else if(t==='history'){ post('showHistory'); }
  else if(t==='overview'){ mode='overview'; overview=null; post('showOverview'); render(); }
  else { mode='results'; render(); }
}

function bind(){
  const byId=(id,fn)=>{const el=document.getElementById(id);if(el)fn(el);};
  byId('apply-all',el=>el.onclick=()=>post('applyAll'));
  byId('watch-off',el=>el.onclick=()=>post('watchToggle'));
  byId('run-verify',el=>el.onclick=()=>post('verify'));
  byId('run-capture',el=>el.onclick=()=>post('capture'));
  byId('create-config',el=>el.onclick=()=>post('init'));
  byId('cap-back',el=>{el.onclick=()=>{mode='results';render();};});
  byId('view-baseline',el=>el.onclick=()=>post('showBaseline'));
  byId('baseline-back',el=>{el.onclick=()=>{mode='results';render();};});
  byId('capture-missing',el=>el.onclick=()=>post('captureMissing'));
  byId('view-history',el=>el.onclick=()=>post('showHistory'));
  byId('history-back',el=>{el.onclick=()=>{mode='results';render();};});
  byId('clear-history',el=>el.onclick=()=>post('clearHistory'));
  byId('p-verify',el=>el.onclick=()=>post('verify'));
  byId('p-capture',el=>el.onclick=()=>post('capture'));
  byId('p-watch',el=>el.onclick=()=>post('watchToggle'));
  byId('ov-prune',el=>el.onclick=()=>post('prune'));
  document.querySelectorAll('[data-tab]').forEach(el=>el.onclick=()=>switchTab(el.dataset.tab));
  document.querySelectorAll('[data-filter]').forEach(el=>el.onclick=()=>{filter=el.dataset.filter;render();});
  document.querySelectorAll('[data-bfilter]').forEach(el=>el.onclick=()=>{baselineFilter=el.dataset.bfilter;render();});
  app.querySelectorAll('[data-open]').forEach(el=>el.onclick=()=>{const d=el.dataset;post('open',{filePath:d.file,line:+d.line,column:+d.col,rawValueLength:+d.len});});
  app.querySelectorAll('[data-apply]').forEach(el=>el.onclick=()=>{const d=el.dataset;post('apply',{filePath:d.file,line:+d.line,column:+d.col,rawValue:d.raw,replacementCode:d.code});});
  app.querySelectorAll('[data-preview]').forEach(el=>el.onclick=()=>{const d=el.dataset;post('preview',{filePath:d.file,line:+d.line,column:+d.col,rawValue:d.raw,replacementCode:d.code});});
  app.querySelectorAll('[data-dismiss]').forEach(el=>el.onclick=()=>post('dismiss',{selectorId:el.dataset.sel}));
  app.querySelectorAll('[data-restore]').forEach(el=>el.onclick=()=>post('restore',{selectorId:el.dataset.sel}));
  app.querySelectorAll('[data-undo]').forEach(el=>el.onclick=()=>post('undo',{entryId:el.dataset.entry}));
}

/* - Overview (analytics home) - */
function ovCard(title, body){ const center = body.indexOf('ov-foot')<0 ? ' ov-center' : ''; return '<div class="ov-card"><div class="ov-card-h">'+title+'</div><div class="ov-cardbody'+center+'">'+body+'</div></div>'; }
function ovLg(color,n,label){ return '<div class="ov-lg"><i style="background:'+color+'"></i>'+n+' '+label+'</div>'; }
function cap(s){ return s ? s.charAt(0).toUpperCase()+s.slice(1) : s; }
function shortDir(d){ return String(d).split(/[\\/\\\\]/).filter(Boolean).slice(-2).join('/'); }
function shortUrl(u){ try{ const x=new URL(u); return (x.pathname && x.pathname!=='/' ? x.pathname : x.host)+(x.search||''); }catch(e){ return u; } }

function ovRing(pct, color, big, sub){
  const C=2*Math.PI*52; const p=Math.max(0,Math.min(100,pct)); const off=C*(1-p/100);
  return '<svg class="ov-ring" viewBox="0 0 120 120" role="img" aria-label="'+big+' '+sub+'">'
    +'<circle cx="60" cy="60" r="52" fill="none" stroke="rgba(128,128,128,.2)" stroke-width="11"/>'
    +'<circle cx="60" cy="60" r="52" fill="none" stroke="'+color+'" stroke-width="11" stroke-linecap="round" stroke-dasharray="'+C.toFixed(1)+'" stroke-dashoffset="'+off.toFixed(1)+'" transform="rotate(-90 60 60)"/>'
    +'<text x="60" y="58" text-anchor="middle" class="ov-ring-n">'+big+'</text>'
    +'<text x="60" y="76" text-anchor="middle" class="ov-ring-s">'+sub+'</text></svg>';
}
function ovDonut(live, stale){
  const total=live+stale; const C=2*Math.PI*52; const liveLen=C*(live/total); const staleLen=C-liveLen;
  return '<svg class="ov-ring" viewBox="0 0 120 120" role="img" aria-label="'+live+' live, '+stale+' stale">'
    +'<circle cx="60" cy="60" r="52" fill="none" stroke="rgba(128,128,128,.2)" stroke-width="11"/>'
    +'<circle cx="60" cy="60" r="52" fill="none" stroke="var(--run)" stroke-width="11" stroke-dasharray="'+liveLen.toFixed(1)+' '+staleLen.toFixed(1)+'" transform="rotate(-90 60 60)"/>'
    +'<circle cx="60" cy="60" r="52" fill="none" stroke="var(--stale)" stroke-width="11" stroke-dasharray="'+staleLen.toFixed(1)+' '+liveLen.toFixed(1)+'" stroke-dashoffset="'+(-liveLen).toFixed(1)+'" transform="rotate(-90 60 60)"/>'
    +'<text x="60" y="58" text-anchor="middle" class="ov-ring-n">'+total+'</text>'
    +'<text x="60" y="76" text-anchor="middle" class="ov-ring-s">captured</text></svg>';
}

function ovProjectStrip(){
  const p=overview.project;
  const ver=p.frameworkVersion?' <b>'+esc(p.frameworkVersion)+'</b>':'';
  return '<div class="ov-proj">'
    +'<span class="ov-projname">'+esc(p.name)+'</span>'
    +'<span class="ov-badge ov-badge-fw">'+esc(cap(p.framework))+ver+'</span>'
    +'<span class="ov-badge">'+esc(p.browser)+'</span>'
    +(p.headless?'<span class="ov-badge">headless</span>':'')
    +'<span class="ov-purl mono">'+esc(p.baseUrl)+'</span>'
    +(lastState.lastRunAt?'<span class="ov-spacer"></span><span class="muted ov-last">last verified '+relTime(lastState.lastRunAt)+'</span>':'')
    +'</div>';
}

function ovHealthCard(){
  const c=lastState.counts;
  if(lastState.phase==='idle' && c.total===0){
    return ovCard('Selector health', '<div class="ov-empty2"><span class="muted">Not verified yet.</span><button class="btn primary ov-cta" id="run-verify">Verify now</button></div>');
  }
  const ring=ovRing(c.healthPct, barColor(c.healthPct), c.healthPct+'%', 'healthy');
  const legend='<div class="ov-legend">'+ovLg('var(--ok)',c.ok,'healthy')
    +(c.broken?ovLg('var(--broken)',c.broken,'broken'):'')
    +(c.multi?ovLg('var(--multi)',c.multi,'ambiguous'):'')
    +((c.skipped+c.failed)?ovLg('var(--skip)',c.skipped+c.failed,'skipped'):'')+'</div>';
  const foot=c.broken?'<button class="btn ov-foot" data-tab="results">View '+c.broken+' broken →</button>':'';
  return ovCard('Selector health', '<div class="ov-hero">'+ring+legend+'</div>'+foot);
}

function ovBaselineCard(){
  const b=overview.baseline;
  if(b.total===0){
    return ovCard('Baseline', '<div class="ov-empty2"><span class="muted">No fingerprints captured yet.</span><button class="btn primary ov-cta" id="run-capture">Capture baseline</button></div>');
  }
  let donut, legend, foot;
  if(b.staleKnown && b.stale>0){
    donut=ovDonut(b.live, b.stale);
    legend='<div class="ov-legend">'+ovLg('var(--run)',b.live,'live')+ovLg('var(--stale)',b.stale,'stale')
      +'<div class="ov-hint">Orphaned baselines from renamed or deleted selectors.</div></div>';
    foot='<button class="btn ov-foot ov-warn" id="ov-prune">🗑 Prune '+b.stale+' stale</button>';
  } else {
    donut=ovRing(100,'var(--run)',b.total,'captured');
    legend='<div class="ov-legend">'+ovLg('var(--run)',b.live,'live')
      +(b.staleKnown?'<div class="ov-hint muted">No stale fingerprints.</div>':'<div class="ov-hint">Run a full verify to assess stale baselines.</div>')+'</div>';
    foot='<button class="btn ov-foot" data-tab="baseline">View baseline →</button>';
  }
  return ovCard('Baseline <span class="ov-hchip">fingerprints.json</span>', '<div class="ov-hero">'+donut+legend+'</div>'+foot);
}

function ovActivityCard(){
  const applied=overview.activity?overview.activity.applied:0;
  const lastv=lastState.lastRunAt?relTime(lastState.lastRunAt):'-';
  return ovCard('Activity',
    '<div class="ov-stats2"><div class="ov-stat"><div class="ov-stat-n">'+applied+'</div><div class="ov-stat-l">heals applied</div></div>'
    +'<div class="ov-stat"><div class="ov-stat-n">'+overview.baseline.total+'</div><div class="ov-stat-l">baselined</div></div></div>'
    +'<div class="ov-mini"><div class="ov-mini-row"><span>Last verified</span><b>'+lastv+'</b></div>'
    +(lastState.watch?'<div class="ov-mini-row"><span>Watch</span><b style="color:var(--run)">on</b></div>':'')+'</div>'
    +'<button class="btn ov-foot" data-tab="history">Open history →</button>');
}

const TIER_COLOR={robust:'var(--ok)',good:'var(--run)',moderate:'var(--multi)',fragile:'var(--broken)'};
function ovRobustCard(){
  const r=overview.robustness; if(!r.total) return '';
  const rows=[['Robust',r.robust,TIER_COLOR.robust],['Good',r.good,TIER_COLOR.good],['Moderate',r.moderate,TIER_COLOR.moderate],['Fragile',r.fragile,TIER_COLOR.fragile]];
  const bar='<div class="ov-stack">'+rows.map(x=>x[1]?'<span style="flex:'+x[1]+';background:'+x[2]+'"></span>':'').join('')+'</div>';
  const legend='<div class="ov-tierlegend">'+rows.filter(x=>x[1]).map(x=>'<span class="ov-tl"><i style="background:'+x[2]+'"></i>'+x[0]+' · '+x[1]+'</span>').join('')+'</div>';
  return ovCard('Selector robustness', '<div class="ov-big">'+r.sturdyPct+'%<span class="ov-big-s">sturdy</span></div>'+bar+legend);
}

function ovTrendCard(){
  const t=(overview.trend||[]).slice(-20); if(t.length<2) return '';
  const vals=t.map(p=>p.healthPct); const min=Math.min.apply(null,vals); const max=Math.max.apply(null,vals); const range=Math.max(1,max-min);
  const coords=t.map((p,i)=>{ const x=(i/(t.length-1))*100; const y=26-((p.healthPct-min)/range)*22-2; return x.toFixed(1)+','+y.toFixed(1); }).join(' ');
  const last=vals[vals.length-1]; const delta=last-vals[0]; const dtxt=(delta>0?'+':'')+delta+'%';
  return ovCard('Health trend <span class="ov-hchip">'+t.length+' runs</span>',
    '<svg viewBox="0 0 100 26" preserveAspectRatio="none" class="ov-spark"><polyline points="'+coords+'" fill="none" stroke="'+barColor(last)+'" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>'
    +'<div class="ov-trend-foot"><span class="ov-big2">'+last+'%</span><span class="ov-delta" style="color:'+(delta>=0?'var(--ok)':'var(--broken)')+'">'+dtxt+' vs first run</span></div>');
}

function ovCompositionCard(){
  const comp=overview.composition||[]; if(!comp.length) return '';
  const max=Math.max.apply(null, comp.map(x=>x.count)); const total=comp.reduce((s,x)=>s+x.count,0);
  const bars=comp.map(x=>'<div class="ov-bar"><span class="ov-bl mono">'+esc(x.label)+'</span><span class="ov-bt"><i style="width:'+Math.round(x.count/max*100)+'%;background:'+(TIER_COLOR[x.tier]||'var(--skip)')+'"></i></span><span class="ov-bn">'+x.count+'</span></div>').join('');
  return ovCard('Selector composition <span class="ov-hchip">'+total+' selectors</span>', '<div class="ov-bars">'+bars+'</div>');
}

function ovFilesCard(){
  const items=lastState.items||[]; if(!items.length) return '';
  const byFile={};
  items.forEach(i=>{ const f=byFile[i.fileName]||(byFile[i.fileName]={name:i.fileName,broken:0}); if(i.status==='broken'||i.status==='multiple-matches'||i.status==='page-load-failed') f.broken++; });
  const files=Object.keys(byFile).map(k=>byFile[k]).sort((a,b)=>b.broken-a.broken || a.name.localeCompare(b.name));
  if(!files.some(f=>f.broken)) return ovCard('Files', '<div class="ov-empty2"><span class="muted">Every file is clean 🎉</span></div>');
  const maxb=Math.max.apply(null, files.map(f=>f.broken));
  const rows=files.slice(0,6).map(f=>{
    const ok=f.broken===0; const col=ok?'var(--ok)':(f.broken>=maxb?'var(--broken)':'var(--multi)');
    const badge=ok?'<span class="ov-fc" style="color:var(--ok)">✓</span>':'<span class="ov-fc" style="color:'+col+'">'+f.broken+'</span>';
    const w=maxb?Math.round(f.broken/maxb*100):0;
    return '<div class="ov-file"><span class="ov-fn mono">'+esc(f.name)+'</span><span class="ov-fbar"><i style="width:'+w+'%;background:'+col+'"></i></span>'+badge+'</div>';
  }).join('');
  return ovCard('Files needing attention', '<div class="ov-files">'+rows+'</div>');
}

function ovPagesCard(){
  const pages=overview.pages||[]; if(pages.length<2) return '';
  const max=Math.max.apply(null, pages.map(p=>p.count));
  const rows=pages.slice(0,6).map(p=>'<div class="ov-file"><span class="ov-fn mono" title="'+esc(p.url)+'">'+esc(shortUrl(p.url))+'</span><span class="ov-fbar"><i style="width:'+Math.round(p.count/max*100)+'%;background:var(--run)"></i></span><span class="ov-fc">'+p.count+'</span></div>').join('');
  return ovCard('Captured pages', '<div class="ov-files">'+rows+'</div>');
}

function ovToolingStrip(){
  const p=overview.project;
  const items=[['Framework', cap(p.framework)+(p.frameworkVersion?' '+p.frameworkVersion:'')],['Browser', p.browser+(p.headless?' · headless':'')],['Edits','AST · recast + babel'],['Test dir', shortDir(p.testDir)],['Privacy','local-first ✓']];
  return '<div class="ov-tooling">'+items.map(x=>'<div class="ov-tool"><span class="ov-tk">'+x[0]+'</span><span class="ov-tv mono">'+esc(x[1])+'</span></div>').join('')+'</div>';
}

function ovSkeleton(){ return '<div class="empty">Building overview…</div>'; }

function renderOverview(){
  if(!lastState){ app.innerHTML = '<div class="empty">Loading…</div>'; return; }
  if(!lastState.hasConfig){ app.innerHTML = onboarding(); return; }
  if(!overview){ app.innerHTML = ovSkeleton(); return; }
  let html = ovProjectStrip();
  html += '<div class="ov-grid">';
  html += ovHealthCard() + ovBaselineCard() + ovActivityCard() + ovRobustCard() + ovTrendCard() + ovCompositionCard() + ovFilesCard() + ovPagesCard();
  html += '</div>';
  html += ovToolingStrip();
  app.innerHTML = html;
}

/* - Onboarding (first run) - */
function onboarding(){
  const hero = '<div class="ob-hero"><div class="ob-badge">'+ICON.shield+'</div>'
    + '<div class="ob-h1">Selector Healer</div>'
    + '<div class="ob-lead">Catch broken test selectors before CI does. Snapshots each selector against your live DOM, flags what broke, and suggests AST-based fixes.</div>'
    + '<div class="ob-pill">'+ICON.lock+' Local-first - no network, no telemetry</div></div>';
  if(!lastState.hasConfig){
    return '<div class="ob">' + hero
      + '<div class="ob-note muted">Start by creating a config - it auto-detects your framework, base URL, and test directory.</div>'
      + '<button class="btn primary ob-cta" id="create-config">Create config</button></div>';
  }
  // Baseline already on disk (e.g. after a reload) - offer Verify, not Capture.
  if(lastState.baseline > 0){
    return '<div class="ob">' + hero
      + '<div class="ob-note muted"><b>'+lastState.baseline+'</b> selector'+(lastState.baseline===1?'':'s')+' have a captured baseline. Run Verify to check them against the live DOM.</div>'
      + '<div class="ob-actions"><button class="btn primary ob-cta" id="run-verify">Verify now</button>'
      + '<button class="btn ob-cta" id="view-baseline">View baseline</button></div></div>';
  }
  const steps = [
    ['Capture', 'Snapshot your selectors as a baseline.'],
    ['Verify', 'Check them against the live DOM.'],
    ['Heal', 'Apply suggested fixes for any that broke.'],
  ];
  return '<div class="ob">' + hero
    + '<div class="ob-steps">' + steps.map((s,i)=>'<div class="ob-step"><span class="ob-num">'+(i+1)+'</span><div><div class="ob-st">'+s[0]+'</div><div class="ob-sd muted">'+s[1]+'</div></div></div>').join('') + '</div>'
    + '<div class="ob-actions"><button class="btn primary ob-cta" id="run-capture">Capture baseline</button>'
    + '<button class="btn ob-cta" id="run-verify">Verify now</button></div></div>';
}

/* - Results - */
function seg(flex,color){ return flex>0 ? '<span style="flex:'+flex+';background:'+color+'"></span>' : ''; }
function chip(color,count,label){ return '<span class="chip"><span class="dot" style="background:'+color+'"></span>'+count+' '+label+'</span>'; }

function renderResults(){
  if(!lastState){ app.innerHTML = '<div class="empty">Loading…</div>'; return; }
  const c = lastState.counts;
  if(lastState.phase==='idle' && c.total===0){ app.innerHTML = onboarding(); return; }

  let html = '<div class="rhead"><div><span class="hpct" style="color:'+barColor(c.healthPct)+'">'+c.healthPct+'%</span>'
    + '<span class="hsub">healthy · '+c.ok+' of '+c.total+' checked</span></div>'
    + '<div class="rlinks"><button class="link" id="view-baseline">Baseline ›</button>'
    + '<button class="link" id="view-history">History ›</button></div></div>';
  if(lastState.lastRunAt) html += '<div class="lastrun muted">last verified '+relTime(lastState.lastRunAt)+'</div>';
  html += '<div class="hbar">'+seg(c.ok,'var(--ok)')+seg(c.broken,'var(--broken)')+seg(c.multi,'var(--multi)')+seg(c.skipped+c.failed,'var(--skip)')+'</div>';
  html += '<div class="chips">'+chip('var(--ok)',c.ok,'ok')
    + (c.broken?chip('var(--broken)',c.broken,'broken'):'')
    + (c.multi?chip('var(--multi)',c.multi,'ambiguous'):'')
    + ((c.skipped+c.failed)?chip('var(--skip)',c.skipped+c.failed,'skipped'):'')
    + '</div>';
  if(lastState.phase==='running') html += '<div class="running"><span class="spinner"></span> Verifying…</div>';
  if(lastState.watch) html += '<div class="watch"><span class="dot"></span><span style="flex:1">Watching - re-verifies test files on save</span><button class="link" id="watch-off">turn off</button></div>';

  const healable = lastState.items.filter(i => i.status==='broken' && i.suggestion && i.suggestion.pct>=80);
  if(healable.length) html += '<button class="btn primary heal-all" id="apply-all">'+ICON.heal+' Heal '+healable.length+' selector'+(healable.length>1?'s':'')+'</button>';

  const tabs = [['all','All',c.total],['broken','Broken',c.broken],['ambiguous','Ambiguous',c.multi],['healthy','Healthy',c.ok]];
  html += '<div class="filter">'+tabs.map(t=>'<button class="seg'+(filter===t[0]?' on':'')+'" data-filter="'+t[0]+'">'+t[1]+(t[2]?'<span class="n">'+t[2]+'</span>':'')+'</button>').join('')+'</div>';

  const items = filtered(lastState.items);
  if(!items.length){
    html += '<div class="empty"><span class="big">✓</span>'+(filter==='all'?'All selectors healthy.':'Nothing here.')+'</div>';
  } else {
    html += '<div class="list">' + items.map(it => (it.status==='ok') ? compactRow(it) : card(it)).join('') + '</div>';
  }
  const dismissed = lastState.dismissed || [];
  if(dismissed.length){
    html += '<details class="dismissed"><summary>Dismissed ('+dismissed.length+')</summary>'
      + '<div class="hint" style="margin:4px 2px 8px">Set aside and not counted above - they return if you edit the selector.</div>'
      + '<div class="list">' + dismissed.map(dismissedRow).join('') + '</div></details>';
  }
  app.innerHTML = html;
}

function dismissedRow(it){
  const col = statusColor(it.status);
  return '<div class="compact"><span class="dot" style="background:'+col+'"></span>'
    + '<a class="loc" '+openAttrs(it)+'>'+esc(it.fileName)+':'+it.line+'</a>'
    + '<span class="csel mono muted">'+esc(it.display)+'</span>'
    + '<button class="link" data-restore data-sel="'+esc(it.selectorId)+'">Restore</button></div>';
}

function filtered(items){
  if(filter==='broken') return items.filter(i=>i.status==='broken');
  if(filter==='ambiguous') return items.filter(i=>i.status==='multiple-matches');
  if(filter==='healthy') return items.filter(i=>i.status==='ok');
  return items; // 'all' - already sorted with attention first
}

function badgeText(s){ return s==='broken'?'broken':s==='multiple-matches'?'ambiguous':s==='page-load-failed'?'page failed':'no baseline'; }
function applyAttrs(it,code){ return 'data-file="'+esc(it.filePath)+'" data-line="'+it.line+'" data-col="'+it.column+'" data-raw="'+esc(it.rawValue)+'" data-code="'+esc(code)+'"'; }
function dataAttrs(it){ return applyAttrs(it, it.suggestion.code); }
function openAttrs(it){ return 'data-open data-file="'+esc(it.filePath)+'" data-line="'+it.line+'" data-col="'+it.column+'" data-len="'+it.rawValueLength+'"'; }
// Expandable "Why NN%?" - the per-rule contributions behind the confidence.
function confidenceDetails(sug){
  if(!sug.breakdown || !sug.breakdown.length) return '';
  const rows = sug.breakdown.map(r =>
    '<div class="rule"><span class="rname">'+esc(r.name)+'</span>'
    + '<span class="rbar"><span style="width:'+r.pct+'%;background:'+barColor(r.pct)+'"></span></span>'
    + '<span class="rpct muted">'+r.pct+'%</span></div>').join('');
  return '<details class="whyconf"><summary>Why '+sug.pct+'%?</summary>'+rows+'</details>';
}

function isAttention(s){ return s==='broken'||s==='multiple-matches'||s==='page-load-failed'; }

function card(it){
  const col = statusColor(it.status);
  let h = '<div class="card"><div class="chead"><span class="dot" style="background:'+col+'"></span>'
    + '<a class="loc" '+openAttrs(it)+'>'+esc(it.fileName)+':'+it.line+'</a>'
    + '<span class="badge" style="color:'+col+';background:color-mix(in srgb,'+col+' 16%,transparent)">'+badgeText(it.status)+'</span>'
    + (isAttention(it.status) ? '<button class="skip" data-dismiss data-sel="'+esc(it.selectorId)+'" title="Skip - set aside and stop flagging until you edit this selector">Skip</button>' : '')
    + '</div>'
    + '<div class="code mono">'+esc(it.display)+'</div>';
  if(it.reason) h += '<div class="why">'+ICON.why+'<span>'+esc(it.reason)+'</span></div>';
  if(it.status==='broken' && it.suggestion){
    const pct = it.suggestion.pct, applyable = pct>=50, pc = barColor(pct);
    h += '<div class="fix"><div class="fixhead"><span style="color:'+pc+'">suggested fix</span><span class="muted">'+pct+'%'+(applyable?'':' · low, review first')+'</span></div>'
      + '<div class="code mono" style="color:var(--vscode-foreground)">'+esc(it.suggestion.code)+'</div>'
      + '<div class="confbar"><span style="width:'+pct+'%;background:'+pc+'"></span></div>'
      + confidenceDetails(it.suggestion)
      + (it.suggestion.learningNote ? '<div class="learned">✨ '+esc(it.suggestion.learningNote)+'</div>' : '')
      + '</div>'
      + '<div class="actions">'
      + (applyable ? '<button class="btn primary" data-apply '+dataAttrs(it)+'>'+ICON.check+' Apply</button>' : '')
      + '<button class="btn" data-preview '+dataAttrs(it)+'>'+ICON.diff+' Preview</button>'
      + '<button class="btn icon" title="Open in editor" '+openAttrs(it)+'>'+ICON.open+'</button>'
      + '</div>';
    // Runner-up candidates - collapsed by default so the top fix stays the focus,
    // but one click away when the best guess isn't the one you want.
    if(it.alternatives && it.alternatives.length){
      const n = it.alternatives.length;
      h += '<details class="alts"><summary>'+n+' other match'+(n>1?'es':'')+'</summary>'
        + it.alternatives.map(a => {
            const apc = barColor(a.pct), aok = a.pct>=50;
            return '<div class="alt"><div class="fixhead"><span class="muted">alternative</span><span style="color:'+apc+'">'+a.pct+'%</span></div>'
              + '<div class="code mono" style="color:var(--vscode-foreground)">'+esc(a.code)+'</div>'
              + '<div class="confbar"><span style="width:'+a.pct+'%;background:'+apc+'"></span></div>'
              + (a.reasoning ? '<div class="alt-why muted">'+esc(a.reasoning)+'</div>' : '')
              + '<div class="actions">'
              + (aok ? '<button class="btn primary" data-apply '+applyAttrs(it,a.code)+'>'+ICON.check+' Apply</button>' : '')
              + '<button class="btn" data-preview '+applyAttrs(it,a.code)+'>'+ICON.diff+' Preview</button>'
              + '</div></div>';
          }).join('')
        + '</details>';
    }
  } else if(it.status==='broken'){ if(!it.reason) h += '<div class="hint">No replacement found - the element may be gone, hidden, or only present after a setup step.</div>'; }
  else if(it.status==='multiple-matches') h += '<div class="hint">Matches '+it.matchCount+' elements - make this selector more specific.</div>';
  else if(it.status==='page-load-failed') h += '<div class="hint">'+esc(it.error || "Couldn't reach this page.")+'</div>';
  else h += '<div class="hint">No baseline - run Capture, or this element only appears after an interaction.</div>';
  return h + '</div>';
}

function compactRow(it){
  return '<div class="compact"><span class="dot" style="background:var(--ok)"></span>'
    + '<a class="loc" '+openAttrs(it)+'>'+esc(it.fileName)+':'+it.line+'</a>'
    + '<span class="csel mono muted">'+esc(it.display)+'</span></div>';
}

/* - Capture (inline mode) - */
function capIcon(s){ if(s==='captured')return '<span style="color:var(--ok)">✓</span>'; if(s==='missed')return '<span style="color:var(--broken)">✗</span>'; if(s==='capturing')return '<span class="spinner"></span>'; return '<span class="muted">○</span>'; }
function capTag(s){ if(s==='captured')return '<span class="tag pass">PASS</span>'; if(s==='missed')return '<span class="tag fail">FAIL</span>'; if(s==='capturing')return '<span class="muted">capturing…</span>'; return '<span class="muted">waiting</span>'; }
function capRow(r){
  return '<div class="caprow ' + r.status + '" id="cap_' + esc(r.selectorId) + '">'
    + '<span class="capicon">' + capIcon(r.status) + '</span>'
    + '<span class="capsel mono"><span class="muted">' + esc(r.selectorType) + '</span> ' + esc(r.rawValue) + '</span>'
    + '<span class="caploc">' + esc(r.fileName) + ':' + r.line + '</span>'
    + '<span class="captag">' + capTag(r.status) + '</span></div>';
}
function renderCapture(){
  const rows = capture.rows, summary = capture.summary;
  const total = rows.length;
  const resolved = rows.filter(r => r.status==='captured' || r.status==='missed').length;
  const captured = rows.filter(r => r.status==='captured').length;
  const pct = summary ? 100 : (total ? Math.round(resolved/total*100) : 0);
  const col = summary ? (summary.captured < summary.total ? 'var(--broken)' : 'var(--ok)') : 'var(--run)';
  const sumText = summary ? (summary.captured + ' captured · ' + (summary.total-summary.captured) + ' missed · ' + summary.total + ' total') : (resolved + ' / ' + total + ' · ' + captured + ' captured');
  app.innerHTML = '<div class="caphead"><div class="secttl" style="margin:0">Capturing baseline</div><button class="link" id="cap-back">← Results</button></div>'
    + '<div class="muted" id="cap-sum" style="font-size:12px;margin-bottom:6px">' + sumText + '</div>'
    + '<div class="pbar"><span id="cap-bar" style="width:' + pct + '%;background:' + col + '"></span></div>'
    + '<div id="cap-rows">' + rows.map(capRow).join('') + '</div>';
}
function captureUpdateDom(id, status){
  const el = document.getElementById('cap_' + id);
  if(!el) return;
  el.className = 'caprow ' + status;
  el.querySelector('.capicon').innerHTML = capIcon(status);
  el.querySelector('.captag').innerHTML = capTag(status);
  const els = [...document.querySelectorAll('.caprow')];
  const total = els.length;
  const resolved = els.filter(r => r.classList.contains('captured') || r.classList.contains('missed')).length;
  const cap = els.filter(r => r.classList.contains('captured')).length;
  const sum = document.getElementById('cap-sum'); if(sum) sum.textContent = resolved + ' / ' + total + ' · ' + cap + ' captured';
  const bar = document.getElementById('cap-bar'); if(bar) bar.style.width = (total ? Math.round(resolved/total*100) : 0) + '%';
}
function captureFinishDom(captured, total){
  const sum = document.getElementById('cap-sum'); if(sum) sum.textContent = captured + ' captured · ' + (total-captured) + ' missed · ' + total + ' total';
  const bar = document.getElementById('cap-bar'); if(bar){ bar.style.width = '100%'; bar.style.background = captured < total ? 'var(--broken)' : 'var(--ok)'; }
}

/* - Baseline (inventory) - */
function baselineRow(r){
  const icon = r.captured ? '<span style="color:var(--ok)">✓</span>' : '<span class="muted">○</span>';
  const t = r.capturedAt ? new Date(r.capturedAt).getTime() : Number.NaN;
  const when = (r.captured && !Number.isNaN(t)) ? ' · captured ' + relTime(t) : (r.captured ? '' : ' · not captured');
  return '<div class="caprow' + (r.captured ? '' : ' pending') + '">'
    + '<span class="capicon">' + icon + '</span>'
    + '<a class="capsel mono loc" data-open data-file="' + esc(r.filePath) + '" data-line="' + r.line + '" data-col="' + r.column + '" data-len="' + r.rawValueLength + '">' + esc(r.display) + '</a>'
    + '<span class="caploc">' + esc(r.fileName) + ':' + r.line + when + '</span></div>';
}
function renderBaseline(){
  const rows = baselineRows || [];
  const captured = rows.filter(r => r.captured).length;
  const uncaptured = rows.length - captured;
  let html = '<div class="caphead"><div class="secttl" style="margin:0">Baseline</div><button class="link" id="baseline-back">← Results</button></div>';
  html += '<div class="muted" style="font-size:12px;margin-bottom:10px"><b>' + captured + '</b> of <b>' + rows.length + '</b> selectors captured</div>';
  if(!rows.length){
    app.innerHTML = html + '<div class="empty muted">No selectors found - check the test directory in your config.</div>';
    return;
  }
  const tabs = [['all','All',rows.length],['captured','Captured',captured],['uncaptured','Uncaptured',uncaptured]];
  html += '<div class="filter">' + tabs.map(t => '<button class="seg' + (baselineFilter===t[0]?' on':'') + '" data-bfilter="' + t[0] + '">' + t[1] + (t[2]?'<span class="n">'+t[2]+'</span>':'') + '</button>').join('') + '</div>';
  if(uncaptured > 0) html += '<button class="btn primary heal-all" id="capture-missing">'+ICON.heal+' Capture '+uncaptured+' missing selector'+(uncaptured>1?'s':'')+'</button>';
  const shown = rows.filter(r => baselineFilter==='captured' ? r.captured : baselineFilter==='uncaptured' ? !r.captured : true);
  if(!shown.length) html += '<div class="empty"><span class="big">✓</span>'+(baselineFilter==='uncaptured'?'Every selector has a baseline.':'Nothing here.')+'</div>';
  else html += '<div class="list">' + shown.map(baselineRow).join('') + '</div>';
  app.innerHTML = html;
}

/* - History (applied heals) - */
function historyRow(e){
  return '<div class="caprow"><span class="capicon" style="color:var(--ok)">'+ICON.check+'</span>'
    + '<a class="capsel mono loc" data-open data-file="'+esc(e.filePath)+'" data-line="'+e.line+'" data-col="'+e.column+'" data-len="1">'+esc(e.label)+'</a>'
    + '<span class="caploc">'+esc(e.fileName)+':'+e.line+' · '+relTime(e.appliedAt)+'</span>'
    + '<button class="link" data-undo data-entry="'+esc(e.id)+'">Undo</button></div>';
}
function renderHistory(){
  const rows = historyEntries || [];
  let html = '<div class="caphead"><div class="secttl" style="margin:0">Heal history</div><button class="link" id="history-back">← Results</button></div>';
  if(!rows.length){
    app.innerHTML = html + '<div class="empty muted"><span class="big">↩</span>No heals applied yet.<br>Fixes you Apply will appear here with a one-click Undo.</div>';
    return;
  }
  html += '<div class="caphead" style="margin-bottom:10px"><span class="muted" style="font-size:12px"><b>'+rows.length+'</b> applied fix'+(rows.length>1?'es':'')+' · newest first</span>'
    + '<button class="link" id="clear-history">Clear history</button></div>';
  html += '<div class="list">'+rows.map(historyRow).join('')+'</div>';
  app.innerHTML = html;
}

window.addEventListener('message', (e) => {
  const m = e.data;
  if(m.type==='verifying'){
    const b = document.getElementById('verifying-banner');
    if(!b) return;
    if(m.active){ b.innerHTML = '<span class="spinner"></span><span>'+esc(m.label||'Re-verifying…')+'</span>'; b.style.display='flex'; }
    else { b.style.display='none'; b.innerHTML=''; }
    return;
  }
  if(m.type==='state'){
    lastState = m.payload;
    if(m.activate) mode='results';
    // On the overview: fetch it once on first landing, and refresh it after any
    // run (capture/prune/verify) so baseline/stale/trend stay current.
    if(mode==='overview' && lastState.hasConfig){
      if(!overview && !overviewRequested){ overviewRequested=true; post('showOverview'); }
      else if(overview){ post('showOverview'); }
    }
    render();
  }
  else if(m.type==='overviewData'){ overview = m.payload; overviewRequested=true; if(mode==='overview') render(); }
  else if(m.type==='baselineData'){ baselineRows = m.rows; baselineFilter='all'; mode='baseline'; render(); }
  else if(m.type==='historyData'){ historyEntries = m.entries; mode='history'; render(); }
  else if(m.type==='captureSeed'){ capture = { rows: m.rows, summary: m.summary }; if(m.activate) mode='capture'; render(); }
  else if(m.type==='captureUpdate'){
    if(capture){ const r = capture.rows.find(x => x.selectorId===m.selectorId); if(r) r.status = m.status; }
    if(mode==='capture') captureUpdateDom(m.selectorId, m.status);
  } else if(m.type==='captureFinish'){
    if(capture) capture.summary = { captured: m.captured, total: m.total };
    if(mode==='capture') captureFinishDom(m.captured, m.total);
  }
});

// Tell the extension our listener is live so it can (re)send the last results.
vscode.postMessage({ type: 'ready' });
`;
