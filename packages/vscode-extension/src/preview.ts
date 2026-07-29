import * as vscode from 'vscode';

/** Virtual-document scheme backing the heal diff preview (its right-hand pane). */
export const HEAL_PREVIEW_SCHEME = 'selector-healer-preview';

/**
 * Serves the "after" side of the heal diff — a read-only virtual document
 * holding the file's text with the proposed replacement already spliced in.
 * Registered once in `activate` for {@link HEAL_PREVIEW_SCHEME}.
 */
export class HealPreviewProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  /** Register (or refresh) the preview content shown for a virtual URI. */
  set(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    this.emitter.fire(uri);
  }
}

/**
 * Replace the `[start, end)` slice of `text` with `replacement`. Pure — the
 * core of both building the "after" preview and applying the heal.
 *
 * @example
 * spliceText('a(x)b', 1, 4, 'y'); // 'ayb'
 */
export function spliceText(text: string, start: number, end: number, replacement: string): string {
  return text.slice(0, start) + replacement + text.slice(end);
}

/**
 * Show a before→after diff of a single heal, then apply it only if the user
 * confirms. The "after" pane is a read-only virtual document; on confirm the
 * replacement is written to the real file.
 *
 * @param provider - the registered preview content provider
 * @param uri - the file being healed
 * @param range - the range of the selector call to replace
 * @param replacement - the replacement source text
 * @param label - short human label (e.g. `old → new`), shown in the diff title
 * @returns true when the heal was applied
 */
export async function previewAndApplyHeal(
  provider: HealPreviewProvider,
  uri: vscode.Uri,
  range: vscode.Range,
  replacement: string,
  label: string,
): Promise<boolean> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const after = spliceText(
      doc.getText(),
      doc.offsetAt(range.start),
      doc.offsetAt(range.end),
      replacement,
    );

    const previewUri = uri.with({ scheme: HEAL_PREVIEW_SCHEME });
    provider.set(previewUri, after);

    await vscode.commands.executeCommand('vscode.diff', uri, previewUri, `Heal preview — ${label}`);

    const choice = await vscode.window.showInformationMessage(
      `Apply this heal?  ${label}`,
      'Apply',
      'Dismiss',
    );
    if (choice !== 'Apply') return false;

    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, range, replacement);
    return await vscode.workspace.applyEdit(edit);
  } catch (e) {
    vscode.window.showErrorMessage(
      `Selector Healer: couldn't preview the heal — ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}
