import type { VerificationResult } from '@selector-healer/core';
import * as vscode from 'vscode';
import { applySuggestion, revealSelector } from './apply.js';
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
}

interface DashMessage {
  type: 'verify' | 'capture' | 'applyAll' | 'open' | 'apply';
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

/**
 * Rich webview dashboard in the Selector Healer activity-bar container. It has
 * two modes shown in the same panel (no separate editor tab):
 * - **results**: health ring, status chips, per-selector heal cards.
 * - **capture**: a live PASS/FAIL list streamed while a baseline is captured.
 */
export class DashboardViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'selectorHealerDashboard';

  private view?: vscode.WebviewView;
  private mode: 'results' | 'capture' = 'results';
  private captureRows: CaptureRow[] = [];
  private captureStatus = new Map<string, CaptureStatus>();
  private captureSummary?: { captured: number; total: number };

  constructor(private readonly extensionUri: vscode.Uri) {
    healerState.onDidChange(() => {
      // A verify run produces results → switch back to the results view.
      this.mode = 'results';
      this.post();
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage(async (msg: DashMessage) => {
      switch (msg.type) {
        case 'verify':
          await vscode.commands.executeCommand('selectorHealer.verify');
          break;
        case 'capture':
          await vscode.commands.executeCommand('selectorHealer.capture');
          break;
        case 'applyAll':
          await vscode.commands.executeCommand('selectorHealer.applyAllFixes');
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
            const ok = await applySuggestion(s);
            if (ok) await vscode.commands.executeCommand('selectorHealer.verify');
          }
          break;
      }
    });

    this.post();
  }

  /** Reveal/focus the dashboard view. */
  async focus(): Promise<void> {
    await vscode.commands.executeCommand(`${DashboardViewProvider.viewType}.focus`);
  }

  /** Switch the dashboard into capture mode and seed the live list. */
  startCapture(rows: CaptureRow[]): void {
    this.mode = 'capture';
    this.captureRows = rows;
    this.captureStatus = new Map(rows.map((r) => [r.selectorId, 'pending' as CaptureStatus]));
    this.captureSummary = undefined;
    this.post();
  }

  /** Update one selector's live capture status. */
  updateCapture(selectorId: string, status: CaptureStatus): void {
    this.captureStatus.set(selectorId, status);
    this.view?.webview.postMessage({ type: 'captureUpdate', selectorId, status });
  }

  /** Finalize the capture view with a summary. */
  finishCapture(captured: number, total: number): void {
    this.captureSummary = { captured, total };
    this.view?.webview.postMessage({ type: 'captureFinish', captured, total });
  }

  private post(): void {
    if (!this.view) return;
    if (this.mode === 'capture') {
      this.view.webview.postMessage({
        type: 'captureSeed',
        rows: this.captureRows.map((r) => ({
          ...r,
          status: this.captureStatus.get(r.selectorId) ?? 'pending',
        })),
        summary: this.captureSummary ?? null,
      });
    } else {
      this.view.webview.postMessage({ type: 'state', payload: serialize(healerState.snapshot) });
    }
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
  <div class="toolbar">
    <button id="btn-verify" class="btn primary" title="Verify selectors against the live DOM">Verify</button>
    <button id="btn-capture" class="btn" title="Capture baseline fingerprints">Capture</button>
  </div>
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
  lastRunAt?: number;
  message?: string;
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
    };
  });

  items.sort((a, b) => {
    const sa = STATUS_ORDER[a.status] ?? 9;
    const sb = STATUS_ORDER[b.status] ?? 9;
    if (sa !== sb) return sa - sb;
    return a.fileName.localeCompare(b.fileName) || a.line - b.line;
  });

  return {
    phase: snap.phase,
    counts: countResults(snap.results),
    items,
    lastRunAt: snap.lastRunAt,
    message: snap.message,
  };
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

const STYLES = /* css */ `
:root {
  --ok: #3fb950; --broken: #f85149; --multi: #d29922; --skip: #8b949e; --run: #58a6ff;
}
* { box-sizing: border-box; }
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); color: var(--vscode-foreground); padding: 0; margin: 0; }
.muted { color: var(--vscode-descriptionForeground); }
.toolbar { display: flex; gap: 6px; padding: 10px 12px; position: sticky; top: 0; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); border-bottom: 1px solid var(--vscode-panel-border, transparent); z-index: 2; }
.btn { flex: 1; cursor: pointer; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.15)); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); padding: 5px 10px; border-radius: 4px; font-size: 12px; }
.btn:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,.25)); }
.btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.btn.primary:hover { background: var(--vscode-button-hoverBackground); }
#app { padding: 12px; }
.empty { text-align: center; color: var(--vscode-descriptionForeground); padding: 28px 12px; line-height: 1.6; }
.empty .big { font-size: 28px; opacity: .5; }
.health { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
.ring { width: 64px; height: 64px; flex: 0 0 auto; }
.ring text { fill: var(--vscode-foreground); font-size: 15px; font-weight: 700; }
.health-meta { font-size: 12px; color: var(--vscode-descriptionForeground); }
.health-meta .title { font-size: 13px; color: var(--vscode-foreground); font-weight: 600; margin-bottom: 2px; }
.chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
.chip { font-size: 11px; padding: 1px 7px; border-radius: 10px; border: 1px solid transparent; white-space: nowrap; }
.chip.ok { color: var(--ok); border-color: var(--ok); }
.chip.broken { color: var(--broken); border-color: var(--broken); }
.chip.multi { color: var(--multi); border-color: var(--multi); }
.chip.skip { color: var(--skip); border-color: var(--skip); }
.applyall { width: 100%; margin: 0 0 12px; }
.section-title { font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: var(--vscode-descriptionForeground); margin: 14px 0 6px; }
.card { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); border-left-width: 3px; border-radius: 6px; padding: 9px 10px; margin-bottom: 8px; background: var(--vscode-editorWidget-background, transparent); }
.card.broken { border-left-color: var(--broken); }
.card.multi { border-left-color: var(--multi); }
.card.skip { border-left-color: var(--skip); }
.card-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.badge { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px; padding: 1px 6px; border-radius: 4px; }
.badge.broken { color: var(--broken); background: color-mix(in srgb, var(--broken) 18%, transparent); }
.badge.multi { color: var(--multi); background: color-mix(in srgb, var(--multi) 18%, transparent); }
.badge.skip { color: var(--skip); background: color-mix(in srgb, var(--skip) 18%, transparent); }
.loc { font-size: 11px; color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
.loc:hover { text-decoration: underline; }
.sel { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; margin: 6px 0; word-break: break-all; }
.bar { height: 5px; border-radius: 3px; background: rgba(128,128,128,.25); overflow: hidden; margin: 7px 0 4px; }
.bar > span { display: block; height: 100%; background: var(--ok); transition: width .2s ease; }
.conf { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 6px; }
.fix { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.fix code { flex: 1; font-family: var(--vscode-editor-font-family, monospace); font-size: 11.5px; background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.12)); padding: 3px 6px; border-radius: 4px; word-break: break-all; }
.apply { cursor: pointer; border: none; border-radius: 4px; padding: 4px 10px; font-size: 11px; white-space: nowrap; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.apply:hover { background: var(--vscode-button-hoverBackground); }
.hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
.running { display: flex; align-items: center; gap: 8px; color: var(--vscode-descriptionForeground); padding: 12px 0; }
.spinner { width: 14px; height: 14px; border: 2px solid rgba(128,128,128,.4); border-top-color: var(--run); border-radius: 50%; animation: spin .8s linear infinite; display: inline-block; }
@keyframes spin { to { transform: rotate(360deg); } }
/* Capture view */
.cap-title { font-size: 14px; font-weight: 600; }
.cap-sum { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 2px 0 8px; }
.caprow { display: flex; align-items: center; gap: 8px; padding: 5px 4px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.12)); }
.caprow.pending { opacity: .5; }
.capicon { width: 16px; text-align: center; flex: 0 0 auto; font-size: 12px; }
.capsel { flex: 1; font-family: var(--vscode-editor-font-family, monospace); font-size: 11.5px; word-break: break-all; }
.caploc { font-size: 10.5px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
.tag { font-size: 9.5px; font-weight: 700; padding: 1px 5px; border-radius: 3px; white-space: nowrap; }
.tag.pass { color: var(--ok); background: color-mix(in srgb, var(--ok) 18%, transparent); }
.tag.fail { color: var(--broken); background: color-mix(in srgb, var(--broken) 18%, transparent); }
`;

const SCRIPT = /* js */ `
const vscode = acquireVsCodeApi();
const app = document.getElementById('app');
document.getElementById('btn-verify').addEventListener('click', () => vscode.postMessage({ type: 'verify' }));
document.getElementById('btn-capture').addEventListener('click', () => vscode.postMessage({ type: 'capture' }));

function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function ringColor(p){return p>=80?'var(--ok)':p>=50?'var(--multi)':'var(--broken)';}

/* ---------- results mode ---------- */
function renderResults(p) {
  if (p.phase === 'idle' && p.counts.total === 0) {
    app.innerHTML = '<div class="empty"><div class="big">🛡️</div><div>No results yet.</div><div class="muted">Run <b>Verify</b> to check your selectors against the live DOM.</div></div>';
    return;
  }
  const c = p.counts;
  const r = 28, circ = 2 * Math.PI * r, off = circ * (1 - c.healthPct / 100), col = ringColor(c.healthPct);
  let html = '<div class="health">'
    + '<svg class="ring" viewBox="0 0 64 64">'
    + '<circle cx="32" cy="32" r="' + r + '" fill="none" stroke="rgba(128,128,128,.25)" stroke-width="6"/>'
    + '<circle cx="32" cy="32" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="6" stroke-linecap="round" stroke-dasharray="' + circ.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '" transform="rotate(-90 32 32)"/>'
    + '<text x="32" y="37" text-anchor="middle">' + c.healthPct + '%</text></svg>'
    + '<div class="health-meta"><div class="title">Selector health</div>'
    + '<div>' + c.total + ' selectors checked</div>'
    + '<div class="chips">' + chip('ok', c.ok + ' OK')
    + (c.broken ? chip('broken', c.broken + ' broken') : '')
    + (c.multi ? chip('multi', c.multi + ' ambiguous') : '')
    + (c.skipped + c.failed ? chip('skip', (c.skipped + c.failed) + ' skipped') : '')
    + '</div></div></div>';

  if (p.phase === 'running') html += '<div class="running"><div class="spinner"></div><div>' + esc(p.message || 'Verifying…') + '</div></div>';

  const healable = p.items.filter(i => i.status === 'broken' && i.suggestion && i.suggestion.pct >= 80);
  if (healable.length) html += '<button class="btn primary applyall" id="apply-all">✨ Apply ' + healable.length + ' high-confidence fix' + (healable.length > 1 ? 'es' : '') + '</button>';

  const attention = p.items.filter(i => i.status !== 'ok');
  if (attention.length === 0) html += '<div class="empty"><div class="big">✓</div><div>All selectors healthy.</div></div>';
  else { html += '<div class="section-title">Needs attention (' + attention.length + ')</div>'; for (const it of attention) html += card(it); }

  app.innerHTML = html;
  const aa = document.getElementById('apply-all');
  if (aa) aa.addEventListener('click', () => vscode.postMessage({ type: 'applyAll' }));
  app.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', () => { const d = el.dataset; vscode.postMessage({ type: 'open', filePath: d.file, line: +d.line, column: +d.col, rawValueLength: +d.len }); }));
  app.querySelectorAll('[data-apply]').forEach(el => el.addEventListener('click', () => { const d = el.dataset; vscode.postMessage({ type: 'apply', filePath: d.file, line: +d.line, column: +d.col, rawValue: d.raw, replacementCode: d.code }); }));
}
function chip(cls, label) { return '<span class="chip ' + cls + '">' + esc(label) + '</span>'; }
function card(it) {
  const kind = it.status === 'broken' ? 'broken' : it.status === 'multiple-matches' ? 'multi' : 'skip';
  const badge = it.status === 'broken' ? 'Broken' : it.status === 'multiple-matches' ? 'Ambiguous' : it.status === 'page-load-failed' ? 'Page failed' : 'No baseline';
  let body = '<div class="card ' + kind + '"><div class="card-head"><span class="badge ' + kind + '">' + badge + '</span>'
    + '<a class="loc" data-open data-file="' + esc(it.filePath) + '" data-line="' + it.line + '" data-col="' + it.column + '" data-len="' + it.rawValueLength + '">' + esc(it.fileName) + ':' + it.line + '</a></div>'
    + '<div class="sel muted">' + esc(it.selectorType) + ' · ' + esc(it.rawValue) + '</div>';
  if (it.status === 'broken' && it.suggestion) {
    const pct = it.suggestion.pct;
    body += '<div class="bar"><span style="width:' + pct + '%;background:' + ringColor(pct) + '"></span></div>'
      + '<div class="conf">' + pct + '% confidence</div>'
      + '<div class="fix"><code>' + esc(it.suggestion.code) + '</code>'
      + '<button class="apply" data-apply data-file="' + esc(it.filePath) + '" data-line="' + it.line + '" data-col="' + it.column + '" data-raw="' + esc(it.rawValue) + '" data-code="' + esc(it.suggestion.code) + '">Apply</button></div>';
  } else if (it.status === 'broken') body += '<div class="hint">No confident replacement found.</div>';
  else if (it.status === 'multiple-matches') body += '<div class="hint">Matches ' + it.matchCount + ' elements — make this selector more specific.</div>';
  else body += '<div class="hint">No baseline — run Capture, or this element only appears after an interaction.</div>';
  return body + '</div>';
}

/* ---------- capture mode ---------- */
function capIcon(s){ if(s==='captured')return '<span style="color:var(--ok)">✓</span>'; if(s==='missed')return '<span style="color:var(--broken)">✗</span>'; if(s==='capturing')return '<span class="spinner"></span>'; return '<span class="muted">○</span>'; }
function capTag(s){ if(s==='captured')return '<span class="tag pass">PASS</span>'; if(s==='missed')return '<span class="tag fail">FAIL</span>'; if(s==='capturing')return '<span class="muted">capturing…</span>'; return '<span class="muted">waiting</span>'; }
function capRow(r){
  return '<div class="caprow ' + r.status + '" id="cap_' + esc(r.selectorId) + '">'
    + '<span class="capicon">' + capIcon(r.status) + '</span>'
    + '<span class="capsel"><span class="muted">' + esc(r.selectorType) + '</span> ' + esc(r.rawValue) + '</span>'
    + '<span class="caploc">' + esc(r.fileName) + ':' + r.line + '</span>'
    + '<span class="captag">' + capTag(r.status) + '</span></div>';
}
function renderCapture(rows, summary) {
  const total = rows.length;
  const resolved = rows.filter(r => r.status==='captured' || r.status==='missed').length;
  const captured = rows.filter(r => r.status==='captured').length;
  const pct = summary ? 100 : (total ? Math.round(resolved/total*100) : 0);
  const col = summary ? (summary.captured < summary.total ? 'var(--broken)' : 'var(--ok)') : 'var(--run)';
  const sumText = summary ? (summary.captured + ' captured · ' + (summary.total - summary.captured) + ' missed · ' + summary.total + ' total') : (resolved + ' / ' + total + ' · ' + captured + ' captured');
  app.innerHTML = '<div class="cap-title">Capturing fingerprints</div>'
    + '<div class="cap-sum" id="cap-sum">' + sumText + '</div>'
    + '<div class="bar"><span id="cap-bar" style="width:' + pct + '%;background:' + col + '"></span></div>'
    + '<div id="cap-rows">' + rows.map(capRow).join('') + '</div>';
}
function captureUpdate(id, status) {
  const el = document.getElementById('cap_' + id);
  if (!el) return;
  el.className = 'caprow ' + status;
  el.querySelector('.capicon').innerHTML = capIcon(status);
  el.querySelector('.captag').innerHTML = capTag(status);
  const rows = [...document.querySelectorAll('.caprow')];
  const total = rows.length;
  const resolved = rows.filter(r => r.classList.contains('captured') || r.classList.contains('missed')).length;
  const captured = rows.filter(r => r.classList.contains('captured')).length;
  const sum = document.getElementById('cap-sum'); if (sum) sum.textContent = resolved + ' / ' + total + ' · ' + captured + ' captured';
  const bar = document.getElementById('cap-bar'); if (bar) bar.style.width = (total ? Math.round(resolved/total*100) : 0) + '%';
}
function captureFinish(captured, total) {
  const sum = document.getElementById('cap-sum'); if (sum) sum.textContent = captured + ' captured · ' + (total - captured) + ' missed · ' + total + ' total';
  const bar = document.getElementById('cap-bar'); if (bar) { bar.style.width = '100%'; bar.style.background = captured < total ? 'var(--broken)' : 'var(--ok)'; }
}

window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'state') renderResults(m.payload);
  else if (m.type === 'captureSeed') renderCapture(m.rows, m.summary);
  else if (m.type === 'captureUpdate') captureUpdate(m.selectorId, m.status);
  else if (m.type === 'captureFinish') captureFinish(m.captured, m.total);
});
`;
