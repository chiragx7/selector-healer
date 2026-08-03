import * as vscode from 'vscode';
import { healerState } from './state.js';
import { activeResults } from './webview-content.js';

/**
 * Editor gutter + overview-ruler decorations that mark each selector line with a
 * colored status dot. Driven by {@link healerState}; re-applies on state change
 * and when the active/visible editors change.
 */
let decoTypes: Record<'ok' | 'broken' | 'multi' | 'skipped', vscode.TextEditorDecorationType>;

/**
 * Initialise gutter decorations. Call once during activation.
 *
 * @param extensionUri - the extension root URI (used to resolve gutter SVG icons)
 * @returns a disposable that tears down the decorations and subscriptions
 *
 * @example
 * context.subscriptions.push(initDecorations(context.extensionUri));
 */
export function initDecorations(extensionUri: vscode.Uri): vscode.Disposable {
  const icon = (name: string) => vscode.Uri.joinPath(extensionUri, 'resources', name);

  const make = (svg: string, color: string): vscode.TextEditorDecorationType =>
    vscode.window.createTextEditorDecorationType({
      gutterIconPath: icon(svg),
      gutterIconSize: 'contain',
      overviewRulerColor: color,
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

  decoTypes = {
    ok: make('gutter-ok.svg', '#3fb950'),
    broken: make('gutter-broken.svg', '#f85149'),
    multi: make('gutter-multi.svg', '#d29922'),
    skipped: make('gutter-skipped.svg', '#8b949e'),
  };

  const refreshAll = () => {
    for (const editor of vscode.window.visibleTextEditors) applyTo(editor);
  };

  const subscriptions: vscode.Disposable[] = [
    healerState.onDidChange(refreshAll),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) applyTo(editor);
    }),
    vscode.window.onDidChangeVisibleTextEditors(refreshAll),
    decoTypes.ok,
    decoTypes.broken,
    decoTypes.multi,
    decoTypes.skipped,
  ];

  refreshAll();

  return vscode.Disposable.from(...subscriptions);
}

function applyTo(editor: vscode.TextEditor): void {
  if (!decoTypes) return;
  const path = editor.document.uri.fsPath;
  const lineCount = editor.document.lineCount;

  const buckets: Record<'ok' | 'broken' | 'multi' | 'skipped', vscode.Range[]> = {
    ok: [],
    broken: [],
    multi: [],
    skipped: [],
  };

  // activeResults, not .results: a Skipped selector loses its gutter dot too.
  for (const r of activeResults(healerState.snapshot)) {
    if (r.selector.filePath !== path) continue;
    const lineIdx = r.selector.line - 1;
    if (lineIdx < 0 || lineIdx >= lineCount) continue;
    const range = new vscode.Range(lineIdx, 0, lineIdx, 0);

    switch (r.status) {
      case 'ok':
        buckets.ok.push(range);
        break;
      case 'broken':
        buckets.broken.push(range);
        break;
      case 'multiple-matches':
        buckets.multi.push(range);
        break;
      case 'skipped':
      case 'page-load-failed':
        buckets.skipped.push(range);
        break;
    }
  }

  editor.setDecorations(decoTypes.ok, buckets.ok);
  editor.setDecorations(decoTypes.broken, buckets.broken);
  editor.setDecorations(decoTypes.multi, buckets.multi);
  editor.setDecorations(decoTypes.skipped, buckets.skipped);
}
