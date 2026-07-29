import * as vscode from 'vscode';
import { findCallExpressionRange, stripLeadingReceiver } from './code-actions.js';
import type { StoredSuggestion } from './code-actions.js';
import type { AppliedHeal } from './history.js';

/**
 * Apply a single heal suggestion to its source file via a {@link vscode.WorkspaceEdit}.
 * Replaces the entire selector method call (e.g. `getByRole('button', { name: 'x' })`)
 * with the suggested replacement, preserving the surrounding line.
 *
 * @param s - the stored suggestion to apply (carries file, line, column, replacement)
 * @returns the applied edit's details (for history/undo), or `null` if nothing was applied
 *
 * @example
 * const applied = await applySuggestion(suggestion); // { filePath, line, column, before, after }
 */
export async function applySuggestion(s: StoredSuggestion): Promise<AppliedHeal | null> {
  const uri = vscode.Uri.file(s.filePath);
  const doc = await vscode.workspace.openTextDocument(uri);
  const lineIdx = s.line - 1;
  if (lineIdx < 0 || lineIdx >= doc.lineCount) return null;

  const lineText = doc.lineAt(lineIdx).text;
  const callRange = findCallExpressionRange(lineText, s.column - 1);

  const startCol = callRange ? callRange.start : s.column - 1;
  const endCol = callRange ? callRange.end : s.column - 1 + s.rawValue.length;
  const before = lineText.slice(startCol, endCol);

  // The callRange begins at the method name (after the receiver's dot), so drop
  // the replacement's own `page.`/`cy.` head to avoid `this.page.page.getBy…`.
  const after = callRange ? stripLeadingReceiver(s.replacementCode) : s.replacementCode;

  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    uri,
    new vscode.Range(new vscode.Position(lineIdx, startCol), new vscode.Position(lineIdx, endCol)),
    after,
  );
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) return null;
  // Persist to disk so a re-verify (which re-parses the file from disk) sees the fix.
  await doc.save();
  return { filePath: s.filePath, line: s.line, column: startCol + 1, before, after };
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
