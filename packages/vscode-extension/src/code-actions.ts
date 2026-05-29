import * as vscode from 'vscode';
import { DIAGNOSTIC_SOURCE } from './diagnostics.js';

export interface StoredSuggestion {
  selectorId: string;
  filePath: string;
  line: number;
  column: number;
  rawValue: string;
  replacementCode: string;
  confidence: number;
}

const suggestionStore = new Map<string, StoredSuggestion[]>();

export function storeSuggestions(suggestions: StoredSuggestion[]): void {
  suggestionStore.clear();
  for (const s of suggestions) {
    const key = `${s.filePath}:${s.line}`;
    const list = suggestionStore.get(key) ?? [];
    list.push(s);
    suggestionStore.set(key, list);
  }
}

export function clearSuggestions(): void {
  suggestionStore.clear();
}

/**
 * Locate the full Playwright method call range (e.g. `getByRole('button', { name: 'Log in' })`)
 * from the position of the raw-value string argument inside it.
 *
 * @param lineText - the full line of source text
 * @param rawValueCol - 0-based column where the raw value string starts
 * @returns start/end columns of `methodName(…)`, or undefined if not found
 *
 * @example
 * // Given line: `  await page.getByRole('button', { name: 'Log in' }).click();`
 * // rawValueCol pointing at 'b' in 'button' → returns range covering `getByRole('button', { name: 'Log in' })`
 */
export function findCallExpressionRange(
  lineText: string,
  rawValueCol: number,
): { start: number; end: number } | undefined {
  // Walk backwards from rawValue to the '.' that precedes the method name
  let pos = rawValueCol;
  while (pos > 0 && lineText[pos - 1] !== '.') {
    pos--;
  }
  if (pos === 0) return undefined;

  const methodStart = pos; // first char of method name (just after '.')

  // Walk forward to the opening '('
  let parenPos = methodStart;
  while (parenPos < lineText.length && lineText[parenPos] !== '(') {
    parenPos++;
  }
  if (parenPos >= lineText.length) return undefined;

  // Find the matching ')' respecting string literals and nesting
  let depth = 1;
  let endPos = parenPos + 1;
  let inString: string | null = null;

  while (endPos < lineText.length && depth > 0) {
    const ch = lineText[endPos];

    if (inString) {
      if (ch === '\\') {
        endPos++; // skip escaped character
      } else if (ch === inString) {
        inString = null;
      }
    } else {
      if (ch === "'" || ch === '"' || ch === '`') {
        inString = ch;
      } else if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
      }
    }
    endPos++;
  }

  if (depth !== 0) return undefined;

  return { start: methodStart, end: endPos };
}

export class SelectorHealerCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== DIAGNOSTIC_SOURCE) continue;
      if (diagnostic.code !== 'broken') continue;

      const key = `${document.uri.fsPath}:${diagnostic.range.start.line + 1}`;
      const suggestions = suggestionStore.get(key);
      if (!suggestions) continue;

      // Compute the full method-call range so the replacement swaps the entire call
      const lineText = document.lineAt(diagnostic.range.start.line).text;
      const callRange = findCallExpressionRange(lineText, diagnostic.range.start.character);

      const replaceRange = callRange
        ? new vscode.Range(
            new vscode.Position(diagnostic.range.start.line, callRange.start),
            new vscode.Position(diagnostic.range.start.line, callRange.end),
          )
        : diagnostic.range;

      for (const s of suggestions) {
        const pct = Math.round(s.confidence * 100);
        const action = new vscode.CodeAction(
          `Replace with ${s.replacementCode} (${pct}%)`,
          vscode.CodeActionKind.QuickFix,
        );

        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(document.uri, replaceRange, s.replacementCode);
        action.diagnostics = [diagnostic];
        action.isPreferred = s.confidence >= 0.8;
        actions.push(action);
      }
    }

    return actions;
  }
}
