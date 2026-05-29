import * as vscode from 'vscode';
import { findCallExpressionRange } from './code-actions.js';
import type { StoredSuggestion } from './code-actions.js';

/**
 * Apply a single heal suggestion to its source file via a {@link vscode.WorkspaceEdit}.
 * Replaces the entire selector method call (e.g. `getByRole('button', { name: 'x' })`)
 * with the suggested replacement, preserving the surrounding line.
 *
 * @param s - the stored suggestion to apply (carries file, line, column, replacement)
 * @returns `true` if the edit was applied successfully
 *
 * @example
 * const applied = await applySuggestion(suggestion); // true
 */
export async function applySuggestion(s: StoredSuggestion): Promise<boolean> {
  const uri = vscode.Uri.file(s.filePath);
  const doc = await vscode.workspace.openTextDocument(uri);
  const lineIdx = s.line - 1;
  if (lineIdx < 0 || lineIdx >= doc.lineCount) return false;

  const lineText = doc.lineAt(lineIdx).text;
  const callRange = findCallExpressionRange(lineText, s.column - 1);

  const range = callRange
    ? new vscode.Range(
        new vscode.Position(lineIdx, callRange.start),
        new vscode.Position(lineIdx, callRange.end),
      )
    : new vscode.Range(
        new vscode.Position(lineIdx, s.column - 1),
        new vscode.Position(lineIdx, s.column - 1 + s.rawValue.length),
      );

  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, range, s.replacementCode);
  return vscode.workspace.applyEdit(edit);
}

/**
 * Reveal a selector in the editor, selecting its raw value.
 *
 * @param filePath - absolute path of the file
 * @param line - 1-indexed line
 * @param column - 1-indexed column where the raw value begins
 * @param length - length of the raw value to select
 */
export async function revealSelector(
  filePath: string,
  line: number,
  column: number,
  length: number,
): Promise<void> {
  const uri = vscode.Uri.file(filePath);
  const selection = new vscode.Range(
    new vscode.Position(line - 1, column - 1),
    new vscode.Position(line - 1, column - 1 + length),
  );
  await vscode.window.showTextDocument(uri, { selection });
}
