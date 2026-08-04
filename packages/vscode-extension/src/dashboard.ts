import * as vscode from 'vscode';
import { healerState } from './state.js';
import {
  type CaptureRow,
  type CaptureSink,
  type CaptureStatus,
  type DashMessage,
  baselineCount,
  buildWebviewHtml,
  handleWebviewMessage,
  hasWorkspaceConfig,
  serialize,
} from './webview-content.js';

export type { CaptureRow } from './webview-content.js';

/**
 * The Selector Healer sidebar panel — one unified webview showing health, the
 * selector list with inline heal actions, watch state, and live capture
 * progress. Shares its rendering with the full editor {@link DashboardPanel}.
 */
export class DashboardViewProvider implements vscode.WebviewViewProvider, CaptureSink {
  static readonly viewType = 'selectorHealerDashboard';

  private view?: vscode.WebviewView;
  private captureRows: CaptureRow[] = [];
  private captureStatus = new Map<string, CaptureStatus>();
  private captureSummary?: { captured: number; total: number };
  private hasCapture = false;
  private watchEnabled = false;
  private webviewReady = false;
  private pendingHistory = false;

  constructor(private readonly extensionUri: vscode.Uri) {
    healerState.onDidChange(() => this.postState(true));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.webviewReady = false; // a fresh webview isn't listening until it posts 'ready'
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = buildWebviewHtml(view.webview.cspSource, 'sidebar');

    view.webview.onDidReceiveMessage(async (msg: DashMessage) => {
      if (msg.type === 'ready') {
        // The webview's listener is live — (re)send state so it doesn't stay blank.
        this.webviewReady = true;
        this.postState(false);
        if (this.hasCapture) this.postCapture(false);
        if (this.pendingHistory) {
          this.pendingHistory = false;
          await this.postHistory();
        }
        return;
      }
      if (msg.type === 'showOverview') {
        const payload = await vscode.commands.executeCommand('selectorHealer.getOverview');
        this.view?.webview.postMessage({ type: 'overviewData', payload });
        return;
      }
      if (msg.type === 'showBaseline') {
        const rows = await vscode.commands.executeCommand('selectorHealer.getBaseline');
        this.view?.webview.postMessage({ type: 'baselineData', rows });
        return;
      }
      if (msg.type === 'showHistory') {
        await this.postHistory();
        return;
      }
      if (msg.type === 'undo') {
        if (msg.entryId) {
          await vscode.commands.executeCommand('selectorHealer.undoHistoryEntry', msg.entryId);
        }
        await this.postHistory();
        return;
      }
      if (msg.type === 'clearHistory') {
        await vscode.commands.executeCommand('selectorHealer.clearHistory');
        await this.postHistory();
        return;
      }
      await handleWebviewMessage(msg);
    });

    this.postState(false);
    if (this.hasCapture) this.postCapture(false);
  }

  /** Reveal/focus the sidebar view. */
  async focus(): Promise<void> {
    await vscode.commands.executeCommand(`${DashboardViewProvider.viewType}.focus`);
  }

  /** Open the sidebar and switch it to the Heal History view (for the menu command). */
  async showHistory(): Promise<void> {
    await this.focus();
    if (this.webviewReady) {
      // View is live and listening — switch it now.
      await this.postHistory();
    } else {
      // Not resolved yet; 'ready' will post (and clear the flag) once it loads.
      this.pendingHistory = true;
    }
  }

  private async postHistory(): Promise<void> {
    const entries = await vscode.commands.executeCommand('selectorHealer.getHistory');
    this.view?.webview.postMessage({ type: 'historyData', entries });
  }

  /** Begin a capture run: seed the live list and switch to the capture view. */
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

  /** Re-push state — re-checks whether a config now exists (e.g. after `init`). */
  refresh(): void {
    this.postState(false);
  }

  /** Reflect watch-mode on/off in the panel (drives the live "watching" strip). */
  setWatch(enabled: boolean): void {
    this.watchEnabled = enabled;
    this.postState(false);
  }

  /** Show/hide the "re-verifying…" banner during a watch run. */
  setVerifying(active: boolean, label?: string): void {
    this.view?.webview.postMessage({ type: 'verifying', active, label });
  }

  private postState(activate: boolean): void {
    this.view?.webview.postMessage({
      type: 'state',
      payload: {
        ...serialize(healerState.snapshot),
        hasConfig: hasWorkspaceConfig(),
        baseline: baselineCount(),
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
}
