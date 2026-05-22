import {
  captureFingerprints,
  healSelectors,
  loadFingerprints,
  parseDirectory,
  parseTestFile,
  verifySelectors,
} from '@selector-healer/core';
import type { HealSuggestion, HealerConfig } from '@selector-healer/core';
import * as vscode from 'vscode';
import {
  SelectorHealerCodeActionProvider,
  clearSuggestions,
  storeSuggestions,
} from './code-actions.js';
import type { StoredSuggestion } from './code-actions.js';
import {
  createDiagnosticCollection,
  selectorToDiagnostic,
  updateDiagnosticsFromResults,
} from './diagnostics.js';
import { createStatusBarItem, setIdle, setResults, setRunning } from './status-bar.js';

let diagnosticCollection: vscode.DiagnosticCollection;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  diagnosticCollection = createDiagnosticCollection();
  statusBarItem = createStatusBarItem();
  outputChannel = vscode.window.createOutputChannel('Selector Healer');

  context.subscriptions.push(diagnosticCollection, statusBarItem, outputChannel);

  const tsSelector: vscode.DocumentSelector = [
    { language: 'typescript', scheme: 'file' },
    { language: 'typescriptreact', scheme: 'file' },
  ];

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      tsSelector,
      new SelectorHealerCodeActionProvider(),
      { providedCodeActionKinds: SelectorHealerCodeActionProvider.providedCodeActionKinds },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('selectorHealer.verify', () => runVerify()),
    vscode.commands.registerCommand('selectorHealer.capture', () => runCapture()),
    vscode.commands.registerCommand('selectorHealer.applyAllFixes', () => applyAllFixes()),
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId === 'typescript' || doc.languageId === 'typescriptreact') {
        parseSingleFile(doc);
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.languageId === 'typescript' || doc.languageId === 'typescriptreact') {
        parseSingleFile(doc);
      }
    }),
  );
}

export function deactivate(): void {
  clearSuggestions();
}

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function parseSingleFile(doc: vscode.TextDocument): void {
  const result = parseTestFile(doc.uri.fsPath);
  if (result.isErr()) return;

  const selectors = result.value;
  if (selectors.length === 0) {
    diagnosticCollection.delete(doc.uri);
    return;
  }

  const root = getWorkspaceRoot();
  if (!root) return;

  const fpResult = loadFingerprints(root);
  if (fpResult.isErr()) return;

  const fingerprints = fpResult.value;
  const diagnostics: vscode.Diagnostic[] = [];

  for (const sel of selectors) {
    if (!fingerprints.has(sel.id)) {
      diagnostics.push(selectorToDiagnostic(sel, 'no-baseline'));
    }
  }

  diagnosticCollection.set(doc.uri, diagnostics);
}

async function loadConfig(): Promise<HealerConfig | undefined> {
  const root = getWorkspaceRoot();
  if (!root) {
    vscode.window.showErrorMessage('No workspace folder open.');
    return undefined;
  }

  const { cosmiconfig } = await import('cosmiconfig');
  const explorer = cosmiconfig('selector-healer');
  const result = await explorer.search(root);

  if (!result || result.isEmpty) {
    vscode.window.showWarningMessage(
      'No selector-healer config found. Run "Selector Healer: Capture Baseline" after creating one.',
    );
    return undefined;
  }

  const config = result.config as HealerConfig;
  const { resolve } = await import('node:path');
  config.testDir = resolve(root, config.testDir);
  return config;
}

async function runVerify(): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) return;

  const config = await loadConfig();
  if (!config) return;

  setRunning(statusBarItem);
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Starting verification...`);

  try {
    const parseResult = parseDirectory(config.testDir, config.testGlob);
    if (parseResult.isErr()) {
      vscode.window.showErrorMessage(`Parse error: ${parseResult.error.message}`);
      setIdle(statusBarItem);
      return;
    }

    const { selectors } = parseResult.value;
    outputChannel.appendLine(`Found ${selectors.length} selectors`);

    const results = await verifySelectors(selectors, { config, projectRoot: root });

    const ok = results.filter((r) => r.status === 'ok').length;
    const broken = results.filter((r) => r.status === 'broken');

    const suggestionMap = new Map<string, string>();
    const allSuggestions: StoredSuggestion[] = [];

    if (broken.length > 0) {
      const healResults = await healSelectors(broken, { config, projectRoot: root });

      for (const h of healResults) {
        const top = h.candidates[0];
        if (top) {
          suggestionMap.set(h.selectorId, top.replacementCode);

          const sel = broken.find((r) => r.selector.id === h.selectorId)?.selector;
          if (sel) {
            for (const c of h.candidates) {
              allSuggestions.push({
                selectorId: h.selectorId,
                filePath: sel.filePath,
                line: sel.line,
                column: sel.column,
                rawValue: sel.rawValue,
                replacementCode: c.replacementCode,
                confidence: c.confidence,
              });
            }
          }
        }
      }
    }

    storeSuggestions(allSuggestions);
    updateDiagnosticsFromResults(diagnosticCollection, results, suggestionMap);
    setResults(statusBarItem, ok, broken.length, results.length);

    outputChannel.appendLine(
      `Verification complete: ${ok} ok, ${broken.length} broken, ${results.length} total`,
    );

    if (broken.length > 0) {
      vscode.window.showWarningMessage(
        `Selector Healer: ${broken.length} broken selector${broken.length > 1 ? 's' : ''} found. Check the Problems panel for details.`,
      );
    } else {
      vscode.window.showInformationMessage('Selector Healer: All selectors verified OK.');
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    outputChannel.appendLine(`Error: ${msg}`);
    vscode.window.showErrorMessage(`Verification failed: ${msg}`);
    setIdle(statusBarItem);
  }
}

async function runCapture(): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) return;

  const config = await loadConfig();
  if (!config) return;

  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Starting capture...`);

  try {
    const parseResult = parseDirectory(config.testDir, config.testGlob);
    if (parseResult.isErr()) {
      vscode.window.showErrorMessage(`Parse error: ${parseResult.error.message}`);
      return;
    }

    const { selectors } = parseResult.value;
    outputChannel.appendLine(`Found ${selectors.length} selectors to capture`);

    const result = await captureFingerprints(selectors, config, root);

    outputChannel.appendLine(`Captured: ${result.captured}, Errors: ${result.errors.length}`);
    vscode.window.showInformationMessage(
      `Selector Healer: Captured ${result.captured} fingerprints.`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    outputChannel.appendLine(`Error: ${msg}`);
    vscode.window.showErrorMessage(`Capture failed: ${msg}`);
  }
}

async function applyAllFixes(): Promise<void> {
  vscode.window.showInformationMessage(
    'Use the Quick Fix (Ctrl+.) on individual broken selectors to apply fixes.',
  );
}
