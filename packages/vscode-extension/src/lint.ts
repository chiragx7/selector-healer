import { type DomFingerprint, type SelectorUsage, lintSelectors } from '@selector-healer/core';
import * as vscode from 'vscode';
import { DIAGNOSTIC_SOURCE } from './diagnostics.js';

/** Diagnostic code used for fragile-selector findings. */
export const FRAGILE_CODE = 'fragile-selector';

/** Upgrade replacement code keyed by `${filePath}:${line}`, for the quick-fix provider. */
const upgrades = new Map<string, string>();

/** The sturdier replacement recorded for a fragile selector, if any. */
export function getLintUpgrade(filePath: string, line: number): string | undefined {
  return upgrades.get(`${filePath}:${line}`);
}

export function clearLintUpgrades(): void {
  upgrades.clear();
}

/**
 * Build "fragile selector" diagnostics (Information severity) for one file and
 * record any DOM-backed upgrades so the code-action provider can offer a fix.
 *
 * @param filePath - the file being linted (all selectors must belong to it)
 * @param selectors - parsed selectors for the file
 * @param fingerprints - captured fingerprints (enables concrete upgrade suggestions)
 * @returns one Information diagnostic per fragile selector
 */
export function lintDiagnostics(
  filePath: string,
  selectors: SelectorUsage[],
  fingerprints: Map<string, DomFingerprint>,
): vscode.Diagnostic[] {
  // Drop this file's stale upgrade entries before recomputing.
  for (const key of [...upgrades.keys()]) {
    if (key.startsWith(`${filePath}:`)) upgrades.delete(key);
  }

  const diagnostics: vscode.Diagnostic[] = [];
  for (const finding of lintSelectors(selectors, { fingerprints })) {
    const col = Math.max(0, finding.column - 1);
    const range = new vscode.Range(
      new vscode.Position(finding.line - 1, col),
      new vscode.Position(finding.line - 1, col + finding.rawValue.length),
    );

    let message = finding.message;
    if (finding.upgrade) {
      message += ` Try ${finding.upgrade.replacementCode}.`;
      upgrades.set(`${filePath}:${finding.line}`, finding.upgrade.replacementCode);
    }

    const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Information);
    diagnostic.source = DIAGNOSTIC_SOURCE;
    diagnostic.code = FRAGILE_CODE;
    diagnostics.push(diagnostic);
  }
  return diagnostics;
}
