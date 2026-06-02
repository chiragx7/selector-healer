import * as vscode from 'vscode';
import { DIAGNOSTIC_SOURCE } from './diagnostics.js';
import { FRAGILE_CODE, getLintUpgrade } from './lint.js';

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

/**
 * Strip a generated replacement's own leading receiver (e.g. `page.`, `cy.`)
 * so it can be spliced into a range that already begins after the source's
 * receiver dot. {@link findCallExpressionRange} returns a range starting at the
 * method name, so `this.page.` + `page.getByText(...)` would otherwise produce
 * the doubled `this.page.page.getByText(...)`. Replacements that have no
 * `receiver.` head (`$('…')`, `Selector('…')`) are returned unchanged.
 *
 * @param replacementCode - the generated replacement, e.g. `page.getByRole('button', { name: 'Login' })`
 * @returns the replacement with any single leading `identifier.` removed
 *
 * @example
 * stripLeadingReceiver("page.getByText('Login')"); // "getByText('Login')"
 */
export function stripLeadingReceiver(replacementCode: string): string {
  return replacementCode.replace(/^[A-Za-z_$][\w$]*\./, '');
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
      if (diagnostic.code !== 'broken' && diagnostic.code !== FRAGILE_CODE) continue;

      const line = diagnostic.range.start.line;

      // Compute the full method-call range so a replacement swaps the entire call.
      const lineText = document.lineAt(line).text;
      const callRange = findCallExpressionRange(lineText, diagnostic.range.start.character);
      const replaceRange = callRange
        ? new vscode.Range(
            new vscode.Position(line, callRange.start),
            new vscode.Position(line, callRange.end),
          )
        : diagnostic.range;

      // When the range starts at the method name (callRange), drop the
      // replacement's own `page.`/`cy.` head so the existing receiver isn't
      // duplicated (`this.page.` + `page.getBy…` → `this.page.getBy…`).
      const editFor = (replacementCode: string): vscode.WorkspaceEdit => {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
          document.uri,
          replaceRange,
          callRange ? stripLeadingReceiver(replacementCode) : replacementCode,
        );
        return edit;
      };

      if (diagnostic.code === 'broken') {
        const suggestions = suggestionStore.get(`${document.uri.fsPath}:${line + 1}`);
        if (!suggestions) continue;
        for (const s of suggestions) {
          const pct = Math.round(s.confidence * 100);
          const lowConfidence = s.confidence < 0.5;
          const action = new vscode.CodeAction(
            `Replace with ${s.replacementCode} (${pct}%${lowConfidence ? ', low confidence' : ''})`,
            vscode.CodeActionKind.QuickFix,
          );
          action.edit = editFor(s.replacementCode);
          action.diagnostics = [diagnostic];
          action.isPreferred = s.confidence >= 0.8;
          actions.push(action);
        }
      } else {
        // fragile-selector → offer the recorded DOM-backed upgrade, if any.
        const upgrade = getLintUpgrade(document.uri.fsPath, line + 1);
        if (!upgrade) continue;
        const action = new vscode.CodeAction(
          `Replace with ${upgrade} (sturdier locator)`,
          vscode.CodeActionKind.QuickFix,
        );
        action.edit = editFor(upgrade);
        action.diagnostics = [diagnostic];
        actions.push(action);
      }
    }

    return actions;
  }
}
