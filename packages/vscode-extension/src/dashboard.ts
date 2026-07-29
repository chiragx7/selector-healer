import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { VerificationResult } from '@selector-healer/core';
import * as vscode from 'vscode';
import { revealSelector } from './apply.js';
import type { StoredSuggestion } from './code-actions.js';
import { type HealerSnapshot, countResults, healerState } from './state.js';

interface DashItem {
  selectorId: string;
  filePath: string;
  fileName: string;
  line: number;
  column: number;
  rawValueLength: number;
  selectorType: string;
  rawValue: string;
  status: VerificationResult['status'];
  matchCount: number;
  suggestion?: { code: string; pct: number };
  /** Top "why it broke" reason, shown inline on the card. */
  reason?: string;
  error?: string;
}

interface DashMessage {
  type:
    | 'verify'
    | 'capture'
    | 'applyAll'
    | 'open'
    | 'apply'
    | 'preview'
    | 'watchToggle'
    | 'ready'
    | 'init';
  filePath?: string;
  line?: number;
  column?: number;
  rawValue?: string;
  rawValueLength?: number;
  replacementCode?: string;
}

/** One row in the live capture view. */
export interface CaptureRow {
  selectorId: string;
  rawValue: string;
  selectorType: string;
  fileName: string;
  line: number;
}

type CaptureStatus = 'pending' | 'capturing' | 'captured' | 'missed';

const STATUS_ORDER: Record<string, number> = {
  broken: 0,
  'multiple-matches': 1,
  'page-load-failed': 2,
  skipped: 3,
  ok: 4,
};

/** Config filenames cosmiconfig discovers — used to detect a first-run (no config). */
const CONFIG_FILES = [
  'selector-healer.config.ts',
  'selector-healer.config.js',
  'selector-healer.config.mjs',
  'selector-healer.config.cjs',
];

/**
 * Rich webview dashboard in the Selector Healer activity-bar container.
 *
 * Two **tabs** (Verify / Capture) switch the *view* without running anything —
 * each tab shows the last run's results and has its own Run button. The active
 * tab is highlighted. The extension pushes data with an `activate` flag: a fresh
 * run switches to the relevant tab; a passive refresh (on reveal) just updates
 * the stored data and leaves the current tab alone.
 */
export class DashboardViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'selectorHealerDashboard';

  private view?: vscode.WebviewView;
  private captureRows: CaptureRow[] = [];
  private captureStatus = new Map<string, CaptureStatus>();
  private captureSummary?: { captured: number; total: number };
  private hasCapture = false;
  private watchEnabled = false;

  constructor(private readonly extensionUri: vscode.Uri) {
    // A verify run changed state → push results and switch to the Verify tab.
    healerState.onDidChange(() => this.postState(true));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage(async (msg: DashMessage) => {
      switch (msg.type) {
        case 'ready':
          // The webview's script has loaded and is listening — (re)send state.
          // Fires on first open and after any reload, avoiding the post-before-
          // listener race that left the tabs blank.
          this.postState(false);
          if (this.hasCapture) this.postCapture(false);
          break;
        case 'verify':
          await vscode.commands.executeCommand('selectorHealer.verify');
          break;
        case 'capture':
          await vscode.commands.executeCommand('selectorHealer.capture');
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
            await vscode.commands.executeCommand('selectorHealer.previewFixAt', s);
          }
          break;
        case 'open':
          if (msg.filePath && msg.line && msg.column) {
            await revealSelector(msg.filePath, msg.line, msg.column, msg.rawValueLength ?? 1);
          }
          break;
        case 'apply':
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
            // Apply + re-verify ONLY this selector (not the whole suite).
            await vscode.commands.executeCommand('selectorHealer.applyFixAt', s);
          }
          break;
      }
    });

    // Passive refresh: populate both tabs without forcing a tab switch.
    this.postState(false);
    if (this.hasCapture) this.postCapture(false);
  }

  /** Reveal/focus the dashboard view. */
  async focus(): Promise<void> {
    await vscode.commands.executeCommand(`${DashboardViewProvider.viewType}.focus`);
  }

  /** Begin a capture run: seed the live list and switch to the Capture tab. */
  startCapture(rows: CaptureRow[]): void {
    this.hasCapture = true;
    this.captureRows = rows;
    this.captureStatus = new Map(rows.map((r) => [r.selectorId, 'pending' as CaptureStatus]));
    this.captureSummary = undefined;
    this.postCapture(true);
  }

  updateCapture(selectorId: string, status: CaptureStatus): void {
    this.captureStatus.set(selectorId, status);
    this.view?.webview.postMessage({ type: 'captureUpdate', selectorId, status });
  }

  finishCapture(captured: number, total: number): void {
    this.captureSummary = { captured, total };
    this.view?.webview.postMessage({ type: 'captureFinish', captured, total });
  }

  /** True when a selector-healer config exists in the workspace root. */
  private hasConfig(): boolean {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return false;
    return CONFIG_FILES.some((f) => existsSync(join(root, f)));
  }

  /** Re-push state — re-checks whether a config now exists (e.g. after `init`). */
  refresh(): void {
    this.postState(false);
  }

  /** Reflect watch-mode on/off in the panel (drives the live "watching" strip). */
  setWatch(enabled: boolean): void {
    this.watchEnabled = enabled;
    this.postState(false);
  }

  private postState(activate: boolean): void {
    this.view?.webview.postMessage({
      type: 'state',
      payload: {
        ...serialize(healerState.snapshot),
        hasConfig: this.hasConfig(),
        watch: this.watchEnabled,
      },
      activate,
    });
  }

  private postCapture(activate: boolean): void {
    this.view?.webview.postMessage({
      type: 'captureSeed',
      rows: this.captureRows.map((r) => ({
        ...r,
        status: this.captureStatus.get(r.selectorId) ?? 'pending',
      })),
      summary: this.captureSummary ?? null,
      activate,
    });
  }

  private html(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>${STYLES}</style>
</head>
<body>
  <div id="app"><div class="empty">Loading…</div></div>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
  }
}

function serialize(snap: HealerSnapshot): {
  phase: string;
  counts: ReturnType<typeof countResults>;
  items: DashItem[];
} {
  const items: DashItem[] = snap.results.map((r) => {
    const sel = r.selector;
    const top = snap.suggestionsByKey.get(`${sel.filePath}:${sel.line}`)?.[0];
    return {
      selectorId: sel.id,
      filePath: sel.filePath,
      fileName: sel.filePath.split(/[/\\]/).pop() ?? sel.filePath,
      line: sel.line,
      column: sel.column,
      rawValueLength: sel.rawValue.length,
      selectorType: sel.selectorType,
      rawValue: sel.rawValue,
      status: r.status,
      matchCount: r.matchCount,
      suggestion: top
        ? { code: top.replacementCode, pct: Math.round(top.confidence * 100) }
        : undefined,
      reason: snap.explanationsById.get(sel.id),
      error: r.error,
    };
  });

  items.sort((a, b) => {
    const sa = STATUS_ORDER[a.status] ?? 9;
    const sb = STATUS_ORDER[b.status] ?? 9;
    if (sa !== sb) return sa - sb;
    return a.fileName.localeCompare(b.fileName) || a.line - b.line;
  });

  return { phase: snap.phase, counts: countResults(snap.results), items };
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

const STYLES = /* css */ `
:root { --ok: var(--vscode-charts-green, #3fb950); --broken: var(--vscode-charts-red, #f85149); --multi: var(--vscode-charts-yellow, #d29922); --skip: var(--vscode-descriptionForeground, #8b949e); --run: var(--vscode-charts-blue, #58a6ff); }
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
.hpct { font-size: 30px; font-weight: 600; line-height: 1; }
.hsub { font-size: 12px; color: var(--vscode-descriptionForeground); margin-left: 8px; }
.hbar { display: flex; height: 8px; border-radius: 5px; overflow: hidden; margin: 11px 0 12px; background: rgba(128,128,128,.18); }
.hbar > span { display: block; height: 100%; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
.chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; padding: 4px 9px; border-radius: 8px; background: var(--vscode-badge-background, rgba(128,128,128,.16)); }
.dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
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
.actions { display: flex; gap: 6px; margin-top: 9px; }
.actions .btn { flex: 1; display: flex; align-items: center; justify-content: center; gap: 5px; }
.actions .btn.icon { flex: 0 0 32px; padding: 5px; }
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
.ob { padding: 10px 4px; line-height: 1.55; }
.ob-title { font-size: 16px; font-weight: 600; margin-bottom: 8px; }
.ob-lead { font-size: 12.5px; color: var(--vscode-descriptionForeground); margin-bottom: 16px; }
.ob-note { font-size: 12px; margin-bottom: 12px; }
.ob-step { display: flex; gap: 9px; font-size: 12.5px; margin-bottom: 9px; }
.ob-num { flex: none; width: 19px; height: 19px; border-radius: 50%; background: var(--vscode-badge-background, rgba(128,128,128,.3)); color: var(--vscode-badge-foreground, var(--vscode-foreground)); display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; }
.ob-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
.ob-actions .btn { padding: 7px 14px; }
`;

const SCRIPT = /* js */ `
const vscode = acquireVsCodeApi();
const app = document.getElementById('app');

let lastState = null;   // verify payload (+ watch, hasConfig)
let capture = null;     // { rows, summary }
let mode = 'results';   // 'results' | 'capture'
let filter = 'all';     // all | broken | ambiguous | healthy

const ICON = {
  why:  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="6.4"/><path d="M8 7.2v3.4M8 4.7h.01" stroke-linecap="round"/></svg>',
  check:'<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 4.5 6.5 12 3 8.5"/></svg>',
  diff: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 2 2 5l3 3M2 5h7a2 2 0 0 1 2 2v2M11 14l3-3-3-3M14 11H7a2 2 0 0 1-2-2V7"/></svg>',
  open: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3H3v10h10v-3M9.5 3H13v3.5M13 3 7.5 8.5"/></svg>',
  heal: '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M8 1.2l1.35 3.28L13 5.1l-2.6 2.3.75 3.6L8 9.3 4.85 11l.75-3.6L3 5.1l3.65-.62z"/></svg>'
};

function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function barColor(p){return p>=80?'var(--ok)':p>=50?'var(--multi)':'var(--broken)';}
function statusColor(s){return s==='broken'?'var(--broken)':s==='multiple-matches'?'var(--multi)':s==='ok'?'var(--ok)':'var(--skip)';}
function post(type,extra){vscode.postMessage(Object.assign({type:type},extra||{}));}

function render(){ if(mode==='capture' && capture) renderCapture(); else renderResults(); bind(); }

function bind(){
  const byId=(id,fn)=>{const el=document.getElementById(id);if(el)fn(el);};
  byId('apply-all',el=>el.onclick=()=>post('applyAll'));
  byId('watch-off',el=>el.onclick=()=>post('watchToggle'));
  byId('run-verify',el=>el.onclick=()=>post('verify'));
  byId('run-capture',el=>el.onclick=()=>post('capture'));
  byId('create-config',el=>el.onclick=()=>post('init'));
  byId('cap-back',el=>{el.onclick=()=>{mode='results';render();};});
  app.querySelectorAll('[data-filter]').forEach(el=>el.onclick=()=>{filter=el.dataset.filter;render();});
  app.querySelectorAll('[data-open]').forEach(el=>el.onclick=()=>{const d=el.dataset;post('open',{filePath:d.file,line:+d.line,column:+d.col,rawValueLength:+d.len});});
  app.querySelectorAll('[data-apply]').forEach(el=>el.onclick=()=>{const d=el.dataset;post('apply',{filePath:d.file,line:+d.line,column:+d.col,rawValue:d.raw,replacementCode:d.code});});
  app.querySelectorAll('[data-preview]').forEach(el=>el.onclick=()=>{const d=el.dataset;post('preview',{filePath:d.file,line:+d.line,column:+d.col,rawValue:d.raw,replacementCode:d.code});});
}

/* ---------- Onboarding (first run) ---------- */
function onboarding(){
  const intro = '<div class="ob-title">🛡️ Selector Healer</div>'
    + '<div class="ob-lead">Catch broken test selectors before CI does — it snapshots each selector against your live DOM, flags the ones that broke, and suggests AST-based fixes. Fully local: no network, no telemetry.</div>';
  if(!lastState.hasConfig){
    return '<div class="ob">' + intro
      + '<div class="ob-note muted">No config yet — create one. It auto-detects your framework, base URL, and test directory.</div>'
      + '<button class="btn primary" id="create-config">＋ Create config</button></div>';
  }
  return '<div class="ob">' + intro
    + '<div class="ob-step"><span class="ob-num">1</span><span>Capture a baseline — snapshot your selectors.</span></div>'
    + '<div class="ob-step"><span class="ob-num">2</span><span>Verify — check them against the live DOM.</span></div>'
    + '<div class="ob-step"><span class="ob-num">3</span><span>Heal — apply suggested fixes for any that broke.</span></div>'
    + '<div class="ob-actions"><button class="btn primary" id="run-capture">Capture baseline</button>'
    + '<button class="btn" id="run-verify">Verify now</button></div></div>';
}

/* ---------- Results ---------- */
function seg(flex,color){ return flex>0 ? '<span style="flex:'+flex+';background:'+color+'"></span>' : ''; }
function chip(color,count,label){ return '<span class="chip"><span class="dot" style="background:'+color+'"></span>'+count+' '+label+'</span>'; }

function renderResults(){
  if(!lastState){ app.innerHTML = '<div class="empty">Loading…</div>'; return; }
  const c = lastState.counts;
  if(lastState.phase==='idle' && c.total===0){ app.innerHTML = onboarding(); return; }

  let html = '<div><span class="hpct" style="color:'+barColor(c.healthPct)+'">'+c.healthPct+'%</span>'
    + '<span class="hsub">healthy · '+c.ok+' of '+c.total+' checked</span></div>';
  html += '<div class="hbar">'+seg(c.ok,'var(--ok)')+seg(c.broken,'var(--broken)')+seg(c.multi,'var(--multi)')+seg(c.skipped+c.failed,'var(--skip)')+'</div>';
  html += '<div class="chips">'+chip('var(--ok)',c.ok,'ok')
    + (c.broken?chip('var(--broken)',c.broken,'broken'):'')
    + (c.multi?chip('var(--multi)',c.multi,'ambiguous'):'')
    + ((c.skipped+c.failed)?chip('var(--skip)',c.skipped+c.failed,'skipped'):'')
    + '</div>';
  if(lastState.phase==='running') html += '<div class="running"><span class="spinner"></span> Verifying…</div>';
  if(lastState.watch) html += '<div class="watch"><span class="dot"></span><span style="flex:1">Watching — re-verifies test files on save</span><button class="link" id="watch-off">turn off</button></div>';

  const healable = lastState.items.filter(i => i.status==='broken' && i.suggestion && i.suggestion.pct>=80);
  if(healable.length) html += '<button class="btn primary heal-all" id="apply-all">'+ICON.heal+' Heal '+healable.length+' selector'+(healable.length>1?'s':'')+'</button>';

  const tabs = [['all','All',c.total],['broken','Broken',c.broken],['ambiguous','Ambiguous',c.multi],['healthy','Healthy',c.ok]];
  html += '<div class="filter">'+tabs.map(t=>'<button class="seg'+(filter===t[0]?' on':'')+'" data-filter="'+t[0]+'">'+t[1]+(t[2]?'<span class="n">'+t[2]+'</span>':'')+'</button>').join('')+'</div>';

  const items = filtered(lastState.items);
  if(!items.length){
    html += '<div class="empty"><span class="big">✓</span>'+(filter==='all'?'All selectors healthy.':'Nothing here.')+'</div>';
  } else {
    for(const it of items) html += (it.status==='ok') ? compactRow(it) : card(it);
  }
  app.innerHTML = html;
}

function filtered(items){
  if(filter==='broken') return items.filter(i=>i.status==='broken');
  if(filter==='ambiguous') return items.filter(i=>i.status==='multiple-matches');
  if(filter==='healthy') return items.filter(i=>i.status==='ok');
  return items; // 'all' — already sorted with attention first
}

function badgeText(s){ return s==='broken'?'broken':s==='multiple-matches'?'ambiguous':s==='page-load-failed'?'page failed':'no baseline'; }
function dataAttrs(it){ return 'data-file="'+esc(it.filePath)+'" data-line="'+it.line+'" data-col="'+it.column+'" data-raw="'+esc(it.rawValue)+'" data-code="'+esc(it.suggestion.code)+'"'; }
function openAttrs(it){ return 'data-open data-file="'+esc(it.filePath)+'" data-line="'+it.line+'" data-col="'+it.column+'" data-len="'+it.rawValueLength+'"'; }

function card(it){
  const col = statusColor(it.status);
  let h = '<div class="card"><div class="chead"><span class="dot" style="background:'+col+'"></span>'
    + '<a class="loc" '+openAttrs(it)+'>'+esc(it.fileName)+':'+it.line+'</a>'
    + '<span class="badge" style="color:'+col+';background:color-mix(in srgb,'+col+' 16%,transparent)">'+badgeText(it.status)+'</span></div>'
    + '<div class="code mono">'+esc(it.rawValue)+'</div>';
  if(it.reason) h += '<div class="why">'+ICON.why+'<span>'+esc(it.reason)+'</span></div>';
  if(it.status==='broken' && it.suggestion){
    const pct = it.suggestion.pct, applyable = pct>=50, pc = barColor(pct);
    h += '<div class="fix"><div class="fixhead"><span style="color:'+pc+'">suggested fix</span><span class="muted">'+pct+'%'+(applyable?'':' · low, review first')+'</span></div>'
      + '<div class="code mono" style="color:var(--vscode-foreground)">'+esc(it.suggestion.code)+'</div>'
      + '<div class="confbar"><span style="width:'+pct+'%;background:'+pc+'"></span></div></div>'
      + '<div class="actions">'
      + (applyable ? '<button class="btn primary" data-apply '+dataAttrs(it)+'>'+ICON.check+' Apply</button>' : '')
      + '<button class="btn" data-preview '+dataAttrs(it)+'>'+ICON.diff+' Preview</button>'
      + '<button class="btn icon" title="Open in editor" '+openAttrs(it)+'>'+ICON.open+'</button>'
      + '</div>';
  } else if(it.status==='broken') h += '<div class="hint">No replacement found — the element may be gone, hidden, or only present after a setup step.</div>';
  else if(it.status==='multiple-matches') h += '<div class="hint">Matches '+it.matchCount+' elements — make this selector more specific.</div>';
  else if(it.status==='page-load-failed') h += '<div class="hint">'+esc(it.error || "Couldn't reach this page.")+'</div>';
  else h += '<div class="hint">No baseline — run Capture, or this element only appears after an interaction.</div>';
  return h + '</div>';
}

function compactRow(it){
  return '<div class="compact"><span class="dot" style="background:var(--ok)"></span>'
    + '<a class="loc" '+openAttrs(it)+'>'+esc(it.fileName)+':'+it.line+'</a>'
    + '<span class="csel mono muted">'+esc(it.rawValue)+'</span></div>';
}

/* ---------- Capture (inline mode) ---------- */
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

window.addEventListener('message', (e) => {
  const m = e.data;
  if(m.type==='state'){ lastState = m.payload; if(m.activate) mode='results'; render(); }
  else if(m.type==='captureSeed'){ capture = { rows: m.rows, summary: m.summary }; if(m.activate) mode='capture'; render(); }
  else if(m.type==='captureUpdate'){
    if(capture){ const r = capture.rows.find(x => x.selectorId===m.selectorId); if(r) r.status = m.status; }
    if(mode==='capture') captureUpdateDom(m.selectorId, m.status);
  } else if(m.type==='captureFinish'){
    if(capture) capture.summary = { captured: m.captured, total: m.total };
    if(mode==='capture') captureFinishDom(m.captured, m.total);
  }
});

// Tell the extension our listener is live so it can (re)send the last results —
// fixes the panel going blank after hide + reopen.
vscode.postMessage({ type: 'ready' });
`;
