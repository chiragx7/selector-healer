import type { SelectorUsage, VerificationResult } from '@selector-healer/core';
import * as vscode from 'vscode';

export const DIAGNOSTIC_SOURCE = 'selector-healer';

export function createDiagnosticCollection(): vscode.DiagnosticCollection {
  return vscode.languages.createDiagnosticCollection(DIAGNOSTIC_SOURCE);
}

export function selectorToDiagnostic(
  selector: SelectorUsage,
  status: 'no-baseline' | 'broken' | 'multiple-matches',
  suggestion?: string,
): vscode.Diagnostic {
  const range = new vscode.Range(
    new vscode.Position(selector.line - 1, selector.column - 1),
    new vscode.Position(selector.line - 1, selector.column - 1 + selector.rawValue.length),
  );

  let severity: vscode.DiagnosticSeverity;
  let message: string;

  switch (status) {
    case 'broken':
      severity = vscode.DiagnosticSeverity.Error;
      message = `Broken selector: ${selector.rawValue}`;
      if (suggestion) {
        message += ` — try ${suggestion}`;
      }
      break;
    case 'multiple-matches':
      severity = vscode.DiagnosticSeverity.Warning;
      message = `Ambiguous selector: ${selector.rawValue} matches multiple elements`;
      break;
    case 'no-baseline':
      severity = vscode.DiagnosticSeverity.Information;
      message = `No baseline fingerprint for ${selector.rawValue}. Run "Selector Healer: Capture Baseline"`;
      break;
  }

  const diagnostic = new vscode.Diagnostic(range, message, severity);
  diagnostic.source = DIAGNOSTIC_SOURCE;
  diagnostic.code = status;
  return diagnostic;
}

export function updateDiagnosticsFromResults(
  collection: vscode.DiagnosticCollection,
  results: VerificationResult[],
  suggestions: Map<string, string>,
): void {
  const byFile = new Map<string, vscode.Diagnostic[]>();

  for (const r of results) {
    if (r.status === 'ok') continue;

    const uri = r.selector.filePath;
    const list = byFile.get(uri) ?? [];

    if (r.status === 'broken') {
      list.push(selectorToDiagnostic(r.selector, 'broken', suggestions.get(r.selector.id)));
    } else if (r.status === 'multiple-matches') {
      list.push(selectorToDiagnostic(r.selector, 'multiple-matches'));
    } else if (r.status === 'skipped' && !r.error) {
      list.push(selectorToDiagnostic(r.selector, 'no-baseline'));
    }

    byFile.set(uri, list);
  }

  collection.clear();
  for (const [filePath, diagnostics] of byFile) {
    collection.set(vscode.Uri.file(filePath), diagnostics);
  }
}
