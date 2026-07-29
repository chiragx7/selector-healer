import * as vscode from 'vscode';
import { healerState } from './state.js';
import {
  type CaptureRow,
  type CaptureSink,
  type CaptureStatus,
  type DashMessage,
  buildWebviewHtml,
  handleWebviewMessage,
  hasWorkspaceConfig,
  serialize,
} from './webview-content.js';

/**
 * The full Selector Healer dashboard — the same unified view as the sidebar, but
 * rendered roomy in an editor tab (centered, multi-column card grid, its own
 * header toolbar). A workspace-wide singleton: opening it again reveals the
 * existing tab rather than spawning a second one.
 */
export class DashboardPanel implements CaptureSink {
  static readonly viewType = 'selectorHealerPanel';
  private static instance?: DashboardPanel;

  /** The live panel, if one is open. */
  static get current(): DashboardPanel | undefined {
    return DashboardPanel.instance;
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private captureRows: CaptureRow[] = [];
  private captureStatus = new Map<string, CaptureStatus>();
  private captureSummary?: { captured: number; total: number };
  private hasCapture = false;
  private watchEnabled = false;

  /** Open the dashboard (or reveal it if already open) and sync watch state. */
  static show(extensionUri: vscode.Uri, watchEnabled: boolean): DashboardPanel {
    if (DashboardPanel.instance) {
      DashboardPanel.instance.setWatch(watchEnabled);
      DashboardPanel.instance.panel.reveal();
      return DashboardPanel.instance;
    }
    const panel = vscode.window.createWebviewPanel(
      DashboardPanel.viewType,
      'Selector Healer',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      },
    );
    DashboardPanel.instance = new DashboardPanel(panel);
    DashboardPanel.instance.setWatch(watchEnabled);
    return DashboardPanel.instance;
  }

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    panel.webview.html = buildWebviewHtml(panel.webview.cspSource, 'panel');

    panel.webview.onDidReceiveMessage(
      async (msg: DashMessage) => {
        if (msg.type === 'ready') {
          this.postState(false);
          if (this.hasCapture) this.postCapture(false);
          return;
        }
        await handleWebviewMessage(msg);
      },
      null,
      this.disposables,
    );

    this.disposables.push(healerState.onDidChange(() => this.postState(false)));
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  async focus(): Promise<void> {
    this.panel.reveal();
  }

  startCapture(rows: CaptureRow[]): void {
    this.hasCapture = true;
    this.captureRows = rows;
    this.captureStatus = new Map(rows.map((r) => [r.selectorId, 'pending' as CaptureStatus]));
    this.captureSummary = undefined;
    this.postCapture(true);
  }

  updateCapture(selectorId: string, status: CaptureStatus): void {
    this.captureStatus.set(selectorId, status);
    this.panel.webview.postMessage({ type: 'captureUpdate', selectorId, status });
  }

  finishCapture(captured: number, total: number): void {
    this.captureSummary = { captured, total };
    this.panel.webview.postMessage({ type: 'captureFinish', captured, total });
  }

  /** Reflect watch-mode on/off in the panel (drives the live "watching" strip). */
  setWatch(enabled: boolean): void {
    this.watchEnabled = enabled;
    this.postState(false);
  }

  private postState(activate: boolean): void {
    this.panel.webview.postMessage({
      type: 'state',
      payload: {
        ...serialize(healerState.snapshot),
        hasConfig: hasWorkspaceConfig(),
        watch: this.watchEnabled,
      },
      activate,
    });
  }

  private postCapture(activate: boolean): void {
    this.panel.webview.postMessage({
      type: 'captureSeed',
      rows: this.captureRows.map((r) => ({
        ...r,
        status: this.captureStatus.get(r.selectorId) ?? 'pending',
      })),
      summary: this.captureSummary ?? null,
      activate,
    });
  }

  private dispose(): void {
    DashboardPanel.instance = undefined;
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}
