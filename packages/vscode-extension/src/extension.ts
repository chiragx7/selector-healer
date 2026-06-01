import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  captureFingerprints,
  detectProjectConfig,
  healSelectors,
  loadFingerprints,
  parseDirectory,
  parseTestFile,
  renderConfigFile,
  verifySelectors,
} from '@selector-healer/core';
import type { HealerConfig, SelectorUsage } from '@selector-healer/core';
import * as vscode from 'vscode';
import { applySuggestion } from './apply.js';
import {
  SelectorHealerCodeActionProvider,
  clearSuggestions,
  storeSuggestions,
} from './code-actions.js';
import type { StoredSuggestion } from './code-actions.js';
import { SelectorCodeLensProvider } from './code-lens.js';
import { DashboardViewProvider } from './dashboard.js';
import { initDecorations } from './decorations.js';
import {
  createDiagnosticCollection,
  selectorToDiagnostic,
  updateDiagnosticsFromResults,
} from './diagnostics.js';
import { countResults, healerState } from './state.js';
import {
  STATUS_MENU_COMMAND,
  createStatusBarItem,
  setIdle,
  setResults,
  setRunning,
} from './status-bar.js';
import { type SelectorItem, SelectorTreeProvider } from './tree-view.js';

let diagnosticCollection: vscode.DiagnosticCollection;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let treeProvider: SelectorTreeProvider;
let dashboard: DashboardViewProvider;

const DOC_SELECTOR: vscode.DocumentSelector = [
  { language: 'typescript', scheme: 'file' },
  { language: 'typescriptreact', scheme: 'file' },
  { language: 'javascript', scheme: 'file' },
  { language: 'javascriptreact', scheme: 'file' },
];

const TS_LANGS = new Set(['typescript', 'typescriptreact', 'javascript', 'javascriptreact']);

export function activate(context: vscode.ExtensionContext): void {
  diagnosticCollection = createDiagnosticCollection();
  statusBarItem = createStatusBarItem();
  outputChannel = vscode.window.createOutputChannel('Selector Healer');
  treeProvider = new SelectorTreeProvider();
  dashboard = new DashboardViewProvider(context.extensionUri);

  context.subscriptions.push(
    diagnosticCollection,
    statusBarItem,
    outputChannel,
    vscode.window.registerWebviewViewProvider(DashboardViewProvider.viewType, dashboard, {
      // Keep the panel's DOM + state alive when the view is hidden, so switching
      // away and back doesn't blank the Verify/Capture tabs.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.createTreeView('selectorHealerExplorer', {
      treeDataProvider: treeProvider,
      showCollapseAll: true,
    }),
    vscode.languages.registerCodeActionsProvider(
      DOC_SELECTOR,
      new SelectorHealerCodeActionProvider(),
      {
        providedCodeActionKinds: SelectorHealerCodeActionProvider.providedCodeActionKinds,
      },
    ),
    vscode.languages.registerCodeLensProvider(DOC_SELECTOR, new SelectorCodeLensProvider()),
    initDecorations(context.extensionUri),
  );

  // Single source of truth: state changes drive the tree + status bar.
  // (The dashboard, CodeLens, and decorations subscribe to state themselves.)
  context.subscriptions.push(
    healerState.onDidChange((snap) => {
      if (snap.phase === 'running') {
        setRunning(statusBarItem);
      } else if (snap.phase === 'done') {
        setResults(statusBarItem, countResults(snap.results));
        treeProvider.refresh(snap.results, snap.suggestionsByKey);
      } else {
        setIdle(statusBarItem);
        treeProvider.clear();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('selectorHealer.init', () => runInit()),
    vscode.commands.registerCommand('selectorHealer.verify', () => runVerify()),
    vscode.commands.registerCommand('selectorHealer.capture', () => runCapture()),
    vscode.commands.registerCommand('selectorHealer.applyAllFixes', () => applyAllFixes()),
    vscode.commands.registerCommand('selectorHealer.refresh', () => runVerify()),
    vscode.commands.registerCommand(STATUS_MENU_COMMAND, () => showMenu()),
    vscode.commands.registerCommand('selectorHealer.focusDashboard', () => dashboard.focus()),
    vscode.commands.registerCommand('selectorHealer.applyFixAt', (s: StoredSuggestion) =>
      applyAndReverify(s),
    ),
    vscode.commands.registerCommand('selectorHealer.applyFixFromTree', (item: SelectorItem) => {
      if (item?.suggestion) applyAndReverify(item.suggestion);
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => maybeParse(doc)),
    vscode.workspace.onDidOpenTextDocument((doc) => maybeParse(doc)),
  );
}

export function deactivate(): void {
  clearSuggestions();
  healerState.reset();
}

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function time(): string {
  return new Date().toLocaleTimeString();
}

function maybeParse(doc: vscode.TextDocument): void {
  if (TS_LANGS.has(doc.languageId)) parseSingleFile(doc);
}

function parseSingleFile(doc: vscode.TextDocument): void {
  // Once a file has verification results, the verify run owns its diagnostics.
  const hasResults = healerState.snapshot.results.some(
    (r) => r.selector.filePath === doc.uri.fsPath,
  );
  if (hasResults) return;

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
    vscode.window.showErrorMessage('Selector Healer: no workspace folder open.');
    return undefined;
  }

  const { cosmiconfig } = await import('cosmiconfig');
  const explorer = cosmiconfig('selector-healer');
  const result = await explorer.search(root);

  if (!result || result.isEmpty) {
    vscode.window.showWarningMessage(
      'Selector Healer: no config found. Create a selector-healer.config.cjs first.',
    );
    return undefined;
  }

  const config = result.config as HealerConfig;
  const { resolve } = await import('node:path');
  config.testDir = resolve(root, config.testDir);
  return config;
}

const CONFIG_FILES = [
  'selector-healer.config.ts',
  'selector-healer.config.js',
  'selector-healer.config.mjs',
  'selector-healer.config.cjs',
];

/**
 * Scaffold a config by auto-detecting the project's framework, base URL, and
 * test directory (shared with the CLI's `init`). Opens the generated file and
 * flags any low-confidence fields for review.
 */
async function runInit(): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) {
    vscode.window.showErrorMessage('Selector Healer: open a project folder first.');
    return;
  }

  const existing = CONFIG_FILES.find((f) => existsSync(join(root, f)));
  if (existing) {
    const open = 'Open config';
    const choice = await vscode.window.showInformationMessage(
      `Selector Healer: ${existing} already exists.`,
      open,
    );
    if (choice === open) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(join(root, existing)));
      await vscode.window.showTextDocument(doc);
    }
    return;
  }

  const detection = detectProjectConfig(root);
  const { filename, content } = renderConfigFile(detection);

  const storeDir = join(root, '.selector-healer');
  if (!existsSync(storeDir)) mkdirSync(storeDir, { recursive: true });
  const configPath = join(root, filename);
  writeFileSync(configPath, content, 'utf8');
  outputChannel.appendLine(
    `[${time()}] Created ${filename} — framework=${detection.framework}, baseUrl=${detection.baseUrl} (${detection.baseUrlSource}), testDir=${detection.testDir} (${detection.testDirSource})`,
  );

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(configPath));
  await vscode.window.showTextDocument(doc);

  const review: string[] = [];
  if (detection.frameworkConfidence !== 'detected') review.push('framework');
  if (!detection.baseUrlConfident) review.push('baseUrl');
  if (!detection.testDirConfident) review.push('testDir');

  const summary = `${detection.framework} · ${detection.baseUrl} · ${detection.testDir}`;
  if (review.length > 0) {
    vscode.window.showWarningMessage(
      `Selector Healer: created ${filename} (${summary}). Please review: ${review.join(', ')}.`,
    );
  } else {
    vscode.window.showInformationMessage(
      `Selector Healer: created ${filename} (${summary}). Run Capture next.`,
    );
  }
}

async function runVerify(): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) return;

  const config = await loadConfig();
  if (!config) return;

  healerState.setRunning('Verifying selectors against the live DOM…');
  outputChannel.appendLine(`[${time()}] Verifying…`);

  try {
    const parseResult = parseDirectory(config.testDir, config.testGlob);
    if (parseResult.isErr()) {
      vscode.window.showErrorMessage(`Selector Healer parse error: ${parseResult.error.message}`);
      healerState.reset();
      return;
    }

    const { selectors } = parseResult.value;
    const results = await verifySelectors(selectors, { config, projectRoot: root });
    const broken = results.filter((r) => r.status === 'broken');

    const suggestionMap = new Map<string, string>();
    const allSuggestions: StoredSuggestion[] = [];
    const suggestionsByKey = new Map<string, StoredSuggestion[]>();

    if (broken.length > 0) {
      const healResults = await healSelectors(broken, { config, projectRoot: root });
      for (const h of healResults) {
        const top = h.candidates[0];
        const sel = broken.find((r) => r.selector.id === h.selectorId)?.selector;
        if (!top || !sel) continue;

        suggestionMap.set(h.selectorId, top.replacementCode);
        const key = `${sel.filePath}:${sel.line}`;
        const list = suggestionsByKey.get(key) ?? [];
        for (const c of h.candidates) {
          const stored: StoredSuggestion = {
            selectorId: h.selectorId,
            filePath: sel.filePath,
            line: sel.line,
            column: sel.column,
            rawValue: sel.rawValue,
            replacementCode: c.replacementCode,
            confidence: c.confidence,
          };
          allSuggestions.push(stored);
          list.push(stored);
        }
        suggestionsByKey.set(key, list);
      }
    }

    storeSuggestions(allSuggestions);
    updateDiagnosticsFromResults(diagnosticCollection, results, suggestionMap);
    healerState.setResults(results, suggestionsByKey);

    const c = countResults(results);
    outputChannel.appendLine(
      `[${time()}] Done — ${c.ok} ok, ${c.broken} broken, ${c.multi} ambiguous, ${c.skipped + c.failed} skipped`,
    );

    if (c.broken > 0) {
      vscode.window.showWarningMessage(
        `Selector Healer: ${c.broken} broken selector${c.broken > 1 ? 's' : ''} — open the dashboard to heal.`,
      );
    } else {
      vscode.window.showInformationMessage(
        `Selector Healer: ${c.healthPct}% healthy (${c.ok}/${c.total} OK).`,
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    outputChannel.appendLine(`[${time()}] Error: ${msg}`);
    vscode.window.showErrorMessage(`Selector Healer verification failed: ${msg}`);
    healerState.reset();
  }
}

async function runCapture(): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) return;

  const config = await loadConfig();
  if (!config) return;

  outputChannel.appendLine(`[${time()}] Capturing baseline…`);

  try {
    const parseResult = parseDirectory(config.testDir, config.testGlob);
    if (parseResult.isErr()) {
      vscode.window.showErrorMessage(`Selector Healer parse error: ${parseResult.error.message}`);
      return;
    }

    const { selectors } = parseResult.value;

    await dashboard.focus();
    dashboard.startCapture(
      selectors.map((s) => ({
        selectorId: s.id,
        rawValue: s.rawValue,
        selectorType: s.selectorType,
        fileName: s.filePath.split(/[/\\]/).pop() ?? s.filePath,
        line: s.line,
      })),
    );

    const result = await captureFingerprints(selectors, config, root, (e) =>
      dashboard.updateCapture(e.selectorId, e.status),
    );
    dashboard.finishCapture(result.captured, selectors.length);

    outputChannel.appendLine(
      `[${time()}] Captured ${result.captured}/${selectors.length} (${result.errors.length} errors)`,
    );
    vscode.window.showInformationMessage(
      `Selector Healer: captured ${result.captured} of ${selectors.length} fingerprints.`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    outputChannel.appendLine(`[${time()}] Capture error: ${msg}`);
    vscode.window.showErrorMessage(`Selector Healer capture failed: ${msg}`);
  }
}

async function applyAndReverify(s: StoredSuggestion): Promise<void> {
  const applied = await applySuggestion(s);
  if (applied) {
    vscode.window.showInformationMessage(`Selector Healer: applied ${s.replacementCode}`);
    await verifyTargeted([s]);
  } else {
    vscode.window.showErrorMessage('Selector Healer: could not apply the fix.');
  }
}

async function applyAllFixes(): Promise<void> {
  const snap = healerState.snapshot;
  const broken = snap.results.filter((r) => r.status === 'broken');
  const threshold = 0.8;

  const toApply: StoredSuggestion[] = [];
  for (const r of broken) {
    const top = snap.suggestionsByKey.get(`${r.selector.filePath}:${r.selector.line}`)?.[0];
    if (top && top.confidence >= threshold) toApply.push(top);
  }

  if (toApply.length === 0) {
    vscode.window.showInformationMessage(
      'Selector Healer: no high-confidence fixes (≥80%) to apply.',
    );
    return;
  }

  const applied: StoredSuggestion[] = [];
  for (const s of toApply) {
    if (await applySuggestion(s)) applied.push(s);
  }

  vscode.window.showInformationMessage(
    `Selector Healer: applied ${applied.length} fix${applied.length > 1 ? 'es' : ''}.`,
  );
  if (applied.length > 0) await verifyTargeted(applied);
}

/**
 * Re-verify ONLY the selectors that were just fixed — not the whole suite.
 * Re-parses each affected file, locates the (now-edited) selector at the fixed
 * line, checks it against the live DOM by match count (no baseline required),
 * and merges that single result into state. Falls back to a full verify if the
 * fixed selectors can't be re-located.
 */
async function verifyTargeted(suggestions: StoredSuggestion[]): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) return;

  const config = await loadConfig();
  if (!config) return;

  const targets: SelectorUsage[] = [];
  const parsedByFile = new Map<string, SelectorUsage[]>();
  for (const s of suggestions) {
    let sels = parsedByFile.get(s.filePath);
    if (!sels) {
      const parsed = parseTestFile(s.filePath);
      if (parsed.isErr()) continue;
      sels = parsed.value;
      parsedByFile.set(s.filePath, sels);
    }
    const sel = sels.find((u) => u.line === s.line);
    if (sel) targets.push(sel);
  }

  if (targets.length === 0) {
    // Couldn't re-locate the fixed selectors — fall back to a full verify.
    await runVerify();
    return;
  }

  const label =
    targets.length === 1
      ? 'Verifying the fixed selector…'
      : `Verifying ${targets.length} fixed selectors…`;
  healerState.setRunning(label);
  outputChannel.appendLine(`[${time()}] ${label}`);

  try {
    const results = await verifySelectors(targets, {
      config,
      projectRoot: root,
      requireBaseline: false,
    });
    healerState.mergeResults(results);

    const snap = healerState.snapshot;
    updateDiagnosticsFromResults(
      diagnosticCollection,
      snap.results,
      topSuggestionById(snap.suggestionsByKey),
    );

    const okNow = results.filter((r) => r.status === 'ok').length;
    outputChannel.appendLine(`[${time()}] Re-verify done — ${okNow}/${results.length} now OK`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    outputChannel.appendLine(`[${time()}] Re-verify error: ${msg}`);
    vscode.window.showErrorMessage(`Selector Healer re-verify failed: ${msg}`);
    // Restore the prior results (setRunning left the phase running).
    const snap = healerState.snapshot;
    healerState.setResults(snap.results, snap.suggestionsByKey);
  }
}

/** Map of selector id → top replacement code, for diagnostic messages. */
function topSuggestionById(byKey: Map<string, StoredSuggestion[]>): Map<string, string> {
  const map = new Map<string, string>();
  for (const list of byKey.values()) {
    const top = list[0];
    if (top) map.set(top.selectorId, top.replacementCode);
  }
  return map;
}

async function showMenu(): Promise<void> {
  const items: Array<vscode.QuickPickItem & { cmd: string }> = [
    {
      label: '$(play) Verify Now',
      detail: 'Check all selectors against the live DOM',
      cmd: 'selectorHealer.verify',
    },
    {
      label: '$(database) Capture Baseline',
      detail: 'Snapshot fingerprints for all selectors',
      cmd: 'selectorHealer.capture',
    },
    {
      label: '$(sparkle) Apply All High-Confidence Fixes',
      detail: 'Auto-heal selectors with ≥80% confidence',
      cmd: 'selectorHealer.applyAllFixes',
    },
    {
      label: '$(dashboard) Open Dashboard',
      detail: 'Show the Selector Healer panel',
      cmd: 'selectorHealer.focusDashboard',
    },
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Selector Healer' });
  if (pick) await vscode.commands.executeCommand(pick.cmd);
}
