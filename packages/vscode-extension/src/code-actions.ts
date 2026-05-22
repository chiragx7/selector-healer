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

export class SelectorHealerCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== DIAGNOSTIC_SOURCE) continue;
      if (diagnostic.code !== 'broken') continue;

      const key = `${document.uri.fsPath}:${diagnostic.range.start.line + 1}`;
      const suggestions = suggestionStore.get(key);
      if (!suggestions) continue;

      for (const s of suggestions) {
        const pct = Math.round(s.confidence * 100);
        const action = new vscode.CodeAction(
          `Replace with ${s.replacementCode} (${pct}%)`,
          vscode.CodeActionKind.QuickFix,
        );

        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(document.uri, diagnostic.range, s.replacementCode);
        action.diagnostics = [diagnostic];
        action.isPreferred = s.confidence >= 0.8;
        actions.push(action);
      }
    }

    return actions;
  }
}
