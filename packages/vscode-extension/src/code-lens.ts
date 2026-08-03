import type { VerificationResult } from '@selector-healer/core';
import * as vscode from 'vscode';
import { healerState } from './state.js';
import { activeResults } from './webview-content.js';

/**
 * Shows an inline CodeLens above every verified selector:
 * - ✓ OK
 * - ✨ Broken → heal to `<replacement>` (NN%)   [click applies the fix]
 * - ☰ N matches — make it specific
 * - ⊘ No baseline — capture
 *
 * Driven by {@link healerState}; refreshes whenever a new run completes.
 */
export class SelectorCodeLensProvider implements vscode.CodeLensProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changeEmitter.event;

  constructor() {
    healerState.onDidChange(() => this.changeEmitter.fire());
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const path = document.uri.fsPath;
    const lineCount = document.lineCount;
    const lenses: vscode.CodeLens[] = [];

    // activeResults, not .results: a Skipped selector shows no CodeLens either.
    for (const r of activeResults(healerState.snapshot)) {
      if (r.selector.filePath !== path) continue;
      const lineIdx = r.selector.line - 1;
      if (lineIdx < 0 || lineIdx >= lineCount) continue;

      const range = new vscode.Range(lineIdx, 0, lineIdx, 0);
      lenses.push(new vscode.CodeLens(range, buildCommand(r)));
    }

    return lenses;
  }
}

function buildCommand(r: VerificationResult): vscode.Command {
  switch (r.status) {
    case 'ok':
      return { title: '$(pass) Selector OK', command: 'selectorHealer.focusDashboard' };

    case 'broken': {
      const top = healerState.suggestionsFor(r.selector.filePath, r.selector.line)[0];
      if (top) {
        const pct = Math.round(top.confidence * 100);
        return {
          title: `$(sparkle) Heal → ${truncate(top.replacementCode, 42)} (${pct}%)`,
          command: 'selectorHealer.applyFixAt',
          arguments: [top],
        };
      }
      return {
        title: '$(error) Broken — no suggestion (re-verify)',
        command: 'selectorHealer.verify',
      };
    }

    case 'multiple-matches':
      return {
        title: `$(list-flat) ${r.matchCount} matches — make it specific`,
        command: 'selectorHealer.focusDashboard',
      };

    default:
      return {
        title: '$(circle-slash) No baseline — capture',
        command: 'selectorHealer.capture',
      };
  }
}

function truncate(str: string, max: number): string {
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}
