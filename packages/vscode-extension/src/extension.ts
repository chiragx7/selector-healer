import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  captureFingerprints,
  detectProjectConfig,
  healSelectors,
  loadFingerprints,
  openHealerBrowser,
  parseDirectory,
  parseTestFile,
  pruneFingerprints,
  renderConfigFile,
  renderSelectorCode,
  saveFingerprints,
  verifySelectors,
} from '@selector-healer/core';
import type {
  DomFingerprint,
  HealerBrowser,
  HealerConfig,
  SelectorUsage,
  VerificationResult,
} from '@selector-healer/core';
import * as vscode from 'vscode';
import { applySuggestion } from './apply.js';
import {
  SelectorHealerCodeActionProvider,
  clearSuggestions,
  findCallExpressionRange,
  storeSuggestions,
  stripLeadingReceiver,
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
import { type HealHistoryEntry, healHistory, undoHeal } from './history.js';
import type { AppliedHeal } from './history.js';
import { SelectorHoverProvider } from './hover.js';
import { lintDiagnostics } from './lint.js';
import { DashboardPanel } from './panel.js';
import { HEAL_PREVIEW_SCHEME, HealPreviewProvider, previewAndApplyHeal } from './preview.js';
import { countResults, healerState } from './state.js';
import {
  STATUS_MENU_COMMAND,
  WATCH_TOGGLE_COMMAND,
  createStatusBarItem,
  createWatchStatusItem,
  setIdle,
  setResults,
  setRunning,
  setWatch,
} from './status-bar.js';
import { Debouncer, isTestFilePath, selectorSignature, selectorsChangedSince } from './watch.js';
import { activeResults } from './webview-content.js';
import type { BaselineRow, CaptureSink, HistoryRow } from './webview-content.js';

let diagnosticCollection: vscode.DiagnosticCollection;
// Verify diagnostics (rebuilt wholesale on state change) live in their own
// collection so they never clobber the on-save fragility/no-baseline lint below.
let lintDiagnosticCollection: vscode.DiagnosticCollection;
let statusBarItem: vscode.StatusBarItem;
let watchStatusItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let dashboard: DashboardViewProvider;

// ── Watch mode: auto re-verify a test file when it's saved (opt-in) ──────────
const WATCH_DEBOUNCE_MS = 400;
const WATCH_STATE_KEY = 'selectorHealer.watch';
const SNAPSHOT_KEY = 'selectorHealer.lastSnapshot';
const DISMISSED_KEY = 'selectorHealer.dismissed';
let watchEnabled = false;
let watchRunning = false;
// Constructed in activate() from the configurable `selectorHealer.watch.debounceMs`.
let watchDebouncer: Debouncer;
const pendingWatchFiles = new Set<string>();
// A warm browser kept alive while watch is on, reused across saves so each
// re-verify skips the ~1s cold Chromium launch. Opened lazily, closed on
// watch-off / config change / deactivate.
let watchBrowser: HealerBrowser | undefined;

const DOC_SELECTOR: vscode.DocumentSelector = [
  { language: 'typescript', scheme: 'file' },
  { language: 'typescriptreact', scheme: 'file' },
  { language: 'javascript', scheme: 'file' },
  { language: 'javascriptreact', scheme: 'file' },
];

const TS_LANGS = new Set(['typescript', 'typescriptreact', 'javascript', 'javascriptreact']);

export function activate(context: vscode.ExtensionContext): void {
  // Heal history persists in the workspace's Memento (local-first, survives reloads).
  healHistory.init(context.workspaceState);
  // Watch debounce is user-configurable (reload to apply a change).
  watchDebouncer = new Debouncer(
    vscode.workspace.getConfiguration('selectorHealer').get('watch.debounceMs', WATCH_DEBOUNCE_MS),
  );
  diagnosticCollection = createDiagnosticCollection();
  lintDiagnosticCollection = vscode.languages.createDiagnosticCollection('selector-healer-lint');
  statusBarItem = createStatusBarItem();
  watchStatusItem = createWatchStatusItem();
  watchEnabled = context.workspaceState.get(WATCH_STATE_KEY, false);
  setWatch(watchStatusItem, watchEnabled ? 'on' : 'off');
  outputChannel = vscode.window.createOutputChannel('Selector Healer');
  outputChannel.appendLine(`[${time()}] Selector Healer activated · watch-diagnostics build`);
  dashboard = new DashboardViewProvider(context.extensionUri);
  dashboard.setWatch(watchEnabled);
  const healPreview = new HealPreviewProvider();

  context.subscriptions.push(
    diagnosticCollection,
    lintDiagnosticCollection,
    statusBarItem,
    watchStatusItem,
    outputChannel,
    vscode.workspace.registerTextDocumentContentProvider(HEAL_PREVIEW_SCHEME, healPreview),
    vscode.window.registerWebviewViewProvider(DashboardViewProvider.viewType, dashboard, {
      // Keep the panel's DOM + state alive when the view is hidden, so switching
      // away and back doesn't blank the Verify/Capture tabs.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.languages.registerCodeActionsProvider(
      DOC_SELECTOR,
      new SelectorHealerCodeActionProvider(),
      {
        providedCodeActionKinds: SelectorHealerCodeActionProvider.providedCodeActionKinds,
      },
    ),
    vscode.languages.registerCodeLensProvider(DOC_SELECTOR, new SelectorCodeLensProvider()),
    vscode.languages.registerHoverProvider(DOC_SELECTOR, new SelectorHoverProvider()),
    initDecorations(context.extensionUri),
  );

  // Single source of truth: state changes drive the status bar.
  // (The dashboard, CodeLens, and decorations subscribe to state themselves.)
  context.subscriptions.push(
    healerState.onDidChange((snap) => {
      if (snap.phase === 'running') {
        setRunning(statusBarItem);
      } else if (snap.phase === 'done') {
        // Count the active set so the status bar agrees with the dashboard health
        // (Skipped selectors are set aside, not counted as needing attention).
        setResults(statusBarItem, countResults(activeResults(snap)));
      } else {
        setIdle(statusBarItem);
      }
    }),
    // Persist every completed run so a window reload can restore it.
    healerState.onDidChange(() => persistSnapshot(context)),
    // Keep editor diagnostics (Problems panel + squiggles) in sync with state —
    // including Skip/restore, which only mutates the dismissed set. activeResults
    // drops Skipped selectors, so they're silenced in the editor too, not just
    // the dashboard. This one subscription is the single builder of diagnostics.
    healerState.onDidChange((snap) => {
      updateDiagnosticsFromResults(
        diagnosticCollection,
        activeResults(snap),
        topSuggestionById(snap.suggestionsByKey),
        snap.explanationsById,
      );
      // A file that has verify results shouldn't also carry the on-save lint
      // diagnostics (they'd double up on the same selectors). maybeParse skips
      // such files going forward; this clears any lint left from before results
      // arrived. Verify's own collection.clear() no longer touches lint.
      for (const path of new Set(snap.results.map((r) => r.selector.filePath))) {
        lintDiagnosticCollection.delete(vscode.Uri.file(path));
      }
    }),
  );

  // Seed the user's "Skip" dismissals before restoring results, so the restored
  // snapshot preserves them.
  healerState.hydrateDismissed(new Set(context.workspaceState.get<string[]>(DISMISSED_KEY, [])));

  // Restore the last verify results (if any) so a reload lands back on the
  // health/cards view instead of the onboarding screen.
  restoreSnapshot(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('selectorHealer.init', () => runInit()),
    vscode.commands.registerCommand('selectorHealer.verify', () => runVerify()),
    vscode.commands.registerCommand('selectorHealer.capture', () => runCapture()),
    vscode.commands.registerCommand('selectorHealer.captureMissing', () => runCaptureMissing()),
    vscode.commands.registerCommand('selectorHealer.applyAllFixes', () => applyAllFixes()),
    vscode.commands.registerCommand('selectorHealer.refresh', () => runVerify()),
    vscode.commands.registerCommand(STATUS_MENU_COMMAND, () => showMenu()),
    vscode.commands.registerCommand('selectorHealer.focusDashboard', () => dashboard.focus()),
    vscode.commands.registerCommand('selectorHealer.openDashboard', () => {
      DashboardPanel.show(context.extensionUri, watchEnabled);
    }),
    vscode.commands.registerCommand(
      'selectorHealer.previewHeal',
      async (uri: vscode.Uri, range: vscode.Range, text: string, label: string) => {
        const applied = await previewAndApplyHeal(healPreview, uri, range, text, label);
        if (applied) {
          await healHistory.record({ ...applied, label });
          await verifyTargeted([healToStored(applied)]);
        }
      },
    ),
    vscode.commands.registerCommand('selectorHealer.applyFixAt', (s: StoredSuggestion) =>
      applyAndReverify(s),
    ),
    vscode.commands.registerCommand('selectorHealer.previewFixAt', (s: StoredSuggestion) =>
      previewFixAt(s),
    ),
    vscode.commands.registerCommand('selectorHealer.undoLastHeal', () => undoLastHeal()),
    vscode.commands.registerCommand('selectorHealer.showHealHistory', () => showHealHistory()),
    vscode.commands.registerCommand('selectorHealer.getBaseline', () => gatherBaseline()),
    vscode.commands.registerCommand('selectorHealer.dismiss', (id: string) =>
      setSelectorDismissed(id, true, context),
    ),
    vscode.commands.registerCommand('selectorHealer.restore', (id: string) =>
      setSelectorDismissed(id, false, context),
    ),
    vscode.commands.registerCommand('selectorHealer.getHistory', () => getHistoryRows()),
    vscode.commands.registerCommand('selectorHealer.undoHistoryEntry', (id: string) =>
      undoHistoryEntry(id),
    ),
    vscode.commands.registerCommand('selectorHealer.clearHistory', () => clearHealHistory()),
    vscode.commands.registerCommand('selectorHealer.pruneStale', () => runPruneStale()),
    vscode.commands.registerCommand(WATCH_TOGGLE_COMMAND, () => toggleWatch(context)),
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      maybeParse(doc);
      // A config edit invalidates the warm watch browser (baseUrl / browser /
      // globalSetup may have changed) — reopen on the next run.
      if (CONFIG_FILES.includes(basename(doc.uri.fsPath))) void closeWatchBrowser();
      if (TS_LANGS.has(doc.languageId)) {
        outputChannel.appendLine(
          `[${time()}] saved ${basename(doc.uri.fsPath)} · watch=${watchEnabled ? 'on' : 'off'}`,
        );
        if (watchEnabled) scheduleWatchVerify([doc.uri.fsPath]);
      }
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => maybeParse(doc)),
    // Scan the file the user switches to — `onDidOpen` does NOT fire for editors
    // that were already restored after a window reload.
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) maybeParse(editor.document);
    }),
    // Toggling fragility lint takes effect immediately: clear, then re-scan
    // whatever's open (re-adds warnings if now enabled, keeps them gone if off).
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('selectorHealer.lint.enabled')) {
        lintDiagnosticCollection.clear();
        for (const ed of vscode.window.visibleTextEditors) maybeParse(ed.document);
      }
    }),
  );

  // Scan whatever is open right now (covers the just-reloaded case).
  if (vscode.window.activeTextEditor) maybeParse(vscode.window.activeTextEditor.document);
}

export function deactivate(): void {
  watchDebouncer.cancel();
  pendingWatchFiles.clear();
  void closeWatchBrowser();
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
    lintDiagnosticCollection.delete(doc.uri);
    return;
  }

  const root = getWorkspaceRoot();
  if (!root) return;

  // Static fragility lint must run even with no baseline, so fall back to an
  // empty set on a fingerprint-load error rather than bailing out.
  const fpResult = loadFingerprints(root);
  const fingerprints: Map<string, DomFingerprint> = fpResult.isOk() ? fpResult.value : new Map();
  const diagnostics: vscode.Diagnostic[] = [];
  for (const sel of selectors) {
    if (!fingerprints.has(sel.id)) {
      diagnostics.push(selectorToDiagnostic(sel, 'no-baseline'));
    }
  }
  // Proactive fragility lint (Information): flags text/CSS/XPath locators and,
  // when a baseline exists, suggests a sturdier replacement via a quick-fix.
  // Opt-out via the `selectorHealer.lint.enabled` setting (read fresh each parse).
  const lintEnabled = vscode.workspace.getConfiguration('selectorHealer').get('lint.enabled', true);
  const fragile = lintEnabled ? lintDiagnostics(doc.uri.fsPath, selectors, fingerprints) : [];
  lintDiagnosticCollection.set(doc.uri, [...diagnostics, ...fragile]);
}

async function loadConfig(quiet = false): Promise<HealerConfig | undefined> {
  const root = getWorkspaceRoot();
  if (!root) {
    if (!quiet) vscode.window.showErrorMessage('Selector Healer: no workspace folder open.');
    return undefined;
  }

  const { cosmiconfig } = await import('cosmiconfig');
  const explorer = cosmiconfig('selector-healer');
  const result = await explorer.search(root);

  if (!result || result.isEmpty) {
    // Watch mode passes quiet=true so a missing config doesn't nag on every save.
    if (!quiet)
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

  // Config now exists — refresh the dashboard so onboarding switches to "Get started".
  dashboard.refresh();
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

    const built = await healToSuggestions(broken, config, root);
    storeSuggestions(built.allSuggestions);
    // Diagnostics are rebuilt reactively by the onDidChange subscription in activate.
    healerState.setResults(results, built.suggestionsByKey, built.explanationMap);

    // Log the full picture (diagnostic); surface the *actionable* count in the
    // toast — Skipped selectors are set aside, so they match the dashboard.
    const c = countResults(results);
    outputChannel.appendLine(
      `[${time()}] Done — ${c.ok} ok, ${c.broken} broken, ${c.multi} ambiguous, ${c.skipped + c.failed} skipped`,
    );
    const shown = countResults(activeResults(healerState.snapshot));

    if (shown.broken > 0) {
      vscode.window.showWarningMessage(
        `Selector Healer: ${shown.broken} broken selector${shown.broken > 1 ? 's' : ''} — open the dashboard to heal.`,
      );
    } else {
      vscode.window.showInformationMessage(
        `Selector Healer: ${shown.healthPct}% healthy (${shown.ok}/${shown.total} OK).`,
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

  const parseResult = parseDirectory(config.testDir, config.testGlob);
  if (parseResult.isErr()) {
    vscode.window.showErrorMessage(`Selector Healer parse error: ${parseResult.error.message}`);
    return;
  }
  await captureSelectors(parseResult.value.selectors, config, root);
}

/**
 * Capture fingerprints for the given selectors, broadcasting live progress to
 * every open surface. `captureFingerprints` merges into the existing baseline,
 * so capturing a subset (e.g. just the missing ones) never drops already-
 * captured entries.
 */
async function captureSelectors(
  selectors: SelectorUsage[],
  config: HealerConfig,
  root: string,
): Promise<void> {
  // Reveal the panel if it's open, otherwise the sidebar; broadcast to both.
  const sinks: CaptureSink[] = DashboardPanel.current
    ? [dashboard, DashboardPanel.current]
    : [dashboard];
  await (DashboardPanel.current ?? dashboard).focus();

  const rows = selectors.map((s) => ({
    selectorId: s.id,
    rawValue: s.rawValue,
    selectorType: s.selectorType,
    fileName: s.filePath.split(/[/\\]/).pop() ?? s.filePath,
    line: s.line,
  }));
  for (const sink of sinks) sink.startCapture(rows);

  try {
    const result = await captureFingerprints(selectors, config, root, (e) => {
      for (const sink of sinks) sink.updateCapture(e.selectorId, e.status);
    });
    for (const sink of sinks) sink.finishCapture(result.captured, selectors.length);
    outputChannel.appendLine(
      `[${time()}] Captured ${result.captured}/${selectors.length} (${result.errors.length} errors)`,
    );
    vscode.window.showInformationMessage(
      `Selector Healer: captured ${result.captured} of ${selectors.length} fingerprint${selectors.length === 1 ? '' : 's'}.`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    outputChannel.appendLine(`[${time()}] Capture error: ${msg}`);
    vscode.window.showErrorMessage(`Selector Healer capture failed: ${msg}`);
  }
}

/** Capture only the selectors that don't yet have a baseline (merges into it). */
async function runCaptureMissing(): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) return;
  const config = await loadConfig();
  if (!config) return;

  const parseResult = parseDirectory(config.testDir, config.testGlob);
  if (parseResult.isErr()) {
    vscode.window.showErrorMessage(`Selector Healer parse error: ${parseResult.error.message}`);
    return;
  }
  const fpResult = loadFingerprints(root);
  const fingerprints = fpResult.isOk() ? fpResult.value : new Map<string, DomFingerprint>();
  const missing = parseResult.value.selectors.filter((s) => !fingerprints.has(s.id));
  if (missing.length === 0) {
    vscode.window.showInformationMessage('Selector Healer: every selector already has a baseline.');
    return;
  }
  outputChannel.appendLine(`[${time()}] Capturing ${missing.length} missing selector(s)…`);
  await captureSelectors(missing, config, root);
}

/**
 * Remove baseline fingerprints for selectors that no longer exist (renamed,
 * moved, or deleted). Reachable rename-recovery orphans are kept. Asks first,
 * then rewrites `fingerprints.json`.
 */
async function runPruneStale(): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) return;
  const config = await loadConfig();
  if (!config) return;

  const parseResult = parseDirectory(config.testDir, config.testGlob);
  if (parseResult.isErr()) {
    vscode.window.showErrorMessage(`Selector Healer parse error: ${parseResult.error.message}`);
    return;
  }
  const fpResult = loadFingerprints(root);
  if (fpResult.isErr()) {
    vscode.window.showErrorMessage(`Selector Healer: ${fpResult.error.message}`);
    return;
  }

  const { kept, removed } = pruneFingerprints(fpResult.value, parseResult.value.selectors, root);
  if (removed.length === 0) {
    vscode.window.showInformationMessage(
      'Selector Healer: baseline is already clean — no stale fingerprints.',
    );
    return;
  }

  // Safety: never prune from an untrustworthy current-selector list. Parse errors
  // (an incomplete list) or zero selectors (a misconfigured testDir) would make live
  // fingerprints look orphaned and delete valid baselines. `removed > 0` here.
  if (parseResult.value.errors.length > 0) {
    const n = parseResult.value.errors.length;
    vscode.window.showWarningMessage(
      `Selector Healer: ${n} test file${n === 1 ? '' : 's'} failed to parse, so the selector list is incomplete. Fix ${n === 1 ? 'it' : 'them'} and re-run Prune — otherwise valid baselines could be removed.`,
    );
    return;
  }
  if (parseResult.value.selectors.length === 0) {
    vscode.window.showWarningMessage(
      `Selector Healer: no selectors found in ${config.testDir}. Refusing to prune — this would remove the entire baseline. Check your testDir.`,
    );
    return;
  }

  const plural = removed.length === 1 ? '' : 's';
  const choice = await vscode.window.showWarningMessage(
    `Remove ${removed.length} stale fingerprint${plural}? These are baselines for selectors that no longer exist. The file is committed to git, so this is reversible.`,
    { modal: true },
    'Remove',
  );
  if (choice !== 'Remove') return;

  const saveResult = saveFingerprints(root, kept);
  if (saveResult.isErr()) {
    vscode.window.showErrorMessage(`Selector Healer: could not save — ${saveResult.error.message}`);
    return;
  }
  outputChannel.appendLine(
    `[${time()}] Pruned ${removed.length} stale fingerprint(s), ${kept.size} kept`,
  );
  vscode.window.showInformationMessage(
    `Selector Healer: removed ${removed.length} stale fingerprint${plural}, ${kept.size} kept.`,
  );
  dashboard.refresh();
}

/**
 * Preview a heal from the panel: reconstruct the selector call's range (as the
 * apply path does), then hand off to the shared `previewHeal` command — which
 * opens the before→after diff and, on confirm, applies + records + re-verifies.
 */
async function previewFixAt(s: StoredSuggestion): Promise<void> {
  const uri = vscode.Uri.file(s.filePath);
  const doc = await vscode.workspace.openTextDocument(uri);
  const lineIdx = s.line - 1;
  if (lineIdx < 0 || lineIdx >= doc.lineCount) return;

  const lineText = doc.lineAt(lineIdx).text;
  const callRange = findCallExpressionRange(lineText, s.column - 1);
  const startCol = callRange ? callRange.start : s.column - 1;
  const endCol = callRange ? callRange.end : s.column - 1 + s.rawValue.length;
  const range = new vscode.Range(
    new vscode.Position(lineIdx, startCol),
    new vscode.Position(lineIdx, endCol),
  );
  const replacement = callRange ? stripLeadingReceiver(s.replacementCode) : s.replacementCode;

  await vscode.commands.executeCommand(
    'selectorHealer.previewHeal',
    uri,
    range,
    replacement,
    `${s.rawValue} → ${s.replacementCode}`,
  );
}

async function applyAndReverify(s: StoredSuggestion): Promise<void> {
  const applied = await applySuggestion(s);
  if (applied) {
    await healHistory.record({ ...applied, label: healLabel(s), selectorId: s.selectorId });
    vscode.window.showInformationMessage(`Selector Healer: applied ${s.replacementCode}`);
    await verifyTargeted([s]);
  } else {
    vscode.window.showErrorMessage('Selector Healer: could not apply the fix.');
  }
}

/**
 * Skip (dismiss) or restore a broken selector by id. Resolves the selector from
 * the current results, computes its signature (so editing the selector later
 * re-surfaces it), toggles the dismissal in state, and persists it across
 * reloads. No-op if the selector is no longer in the results.
 */
function setSelectorDismissed(
  selectorId: string,
  dismissed: boolean,
  context: vscode.ExtensionContext,
): void {
  const result = healerState.snapshot.results.find((r) => r.selector.id === selectorId);
  if (!result) return;
  healerState.setDismissed(selectorSignature(result.selector), dismissed);
  void context.workspaceState.update(DISMISSED_KEY, [...healerState.snapshot.dismissedSignatures]);
}

async function applyAllFixes(): Promise<void> {
  const snap = healerState.snapshot;
  // Exclude Skipped selectors — the user set them aside, so "Heal all" must not
  // silently auto-apply fixes to them (and this matches the dashboard's count).
  const broken = activeResults(snap).filter((r) => r.status === 'broken');
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
    const res = await applySuggestion(s);
    if (res) {
      await healHistory.record({ ...res, label: healLabel(s), selectorId: s.selectorId });
      applied.push(s);
    }
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
    // Diagnostics rebuild reactively (see the onDidChange subscription in activate).

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

interface BuiltHeal {
  /** selector id → top "why it broke" reason. */
  explanationMap: Map<string, string>;
  /** `file:line` → ranked suggestions (code actions + tree). */
  suggestionsByKey: Map<string, StoredSuggestion[]>;
  /** Flat list of every suggestion (for the code-action store). */
  allSuggestions: StoredSuggestion[];
}

/**
 * Heal a set of broken selectors and shape the results into the maps every UI
 * surface needs. Shared by the full verify and watch mode's per-file re-verify.
 */
async function healToSuggestions(
  broken: VerificationResult[],
  config: HealerConfig,
  root: string,
  context?: Awaited<ReturnType<typeof ensureWatchBrowser>>,
): Promise<BuiltHeal> {
  const explanationMap = new Map<string, string>();
  const suggestionsByKey = new Map<string, StoredSuggestion[]>();
  const allSuggestions: StoredSuggestion[] = [];
  if (broken.length === 0) {
    return { explanationMap, suggestionsByKey, allSuggestions };
  }

  const healResults = await healSelectors(broken, { config, projectRoot: root, context });
  for (const h of healResults) {
    // The top break reason (why it broke) — shown in the diagnostic message.
    if (h.explanation?.[0]) explanationMap.set(h.selectorId, h.explanation[0].summary);
    const top = h.candidates[0];
    const sel = broken.find((r) => r.selector.id === h.selectorId)?.selector;
    if (!top || !sel) continue;

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
        reasoning: c.reasoning,
        ruleScores: c.ruleScores,
      };
      allSuggestions.push(stored);
      list.push(stored);
    }
    suggestionsByKey.set(key, list);
  }
  return { explanationMap, suggestionsByKey, allSuggestions };
}

/** Flatten the state's per-key suggestions into one list for the code-action store. */
function flattenSuggestions(byKey: Map<string, StoredSuggestion[]>): StoredSuggestion[] {
  const out: StoredSuggestion[] = [];
  for (const list of byKey.values()) out.push(...list);
  return out;
}

/** JSON-safe form of a completed run, stored in workspaceState across reloads. */
interface PersistedSnapshot {
  results: VerificationResult[];
  suggestions: Array<[string, StoredSuggestion[]]>;
  explanations: Array<[string, string]>;
  lastRunAt?: number;
}

/**
 * Build the baseline inventory: every parsed selector paired with whether it
 * has a captured fingerprint on disk (and when). Powers the panel's Baseline view.
 */
async function gatherBaseline(): Promise<BaselineRow[]> {
  const root = getWorkspaceRoot();
  if (!root) return [];
  const config = await loadConfig(true);
  if (!config) return [];

  const parsed = parseDirectory(config.testDir, config.testGlob);
  if (parsed.isErr()) return [];

  const fpResult = loadFingerprints(root);
  const fingerprints = fpResult.isOk() ? fpResult.value : new Map<string, DomFingerprint>();

  return parsed.value.selectors.map((sel) => {
    const fp = fingerprints.get(sel.id);
    return {
      selectorId: sel.id,
      display: renderSelectorCode(sel, sel.framework) ?? sel.rawValue,
      fileName: sel.filePath.split(/[/\\]/).pop() ?? sel.filePath,
      filePath: sel.filePath,
      line: sel.line,
      column: sel.column,
      rawValueLength: sel.rawValue.length,
      captured: fp !== undefined,
      capturedAt: fp?.capturedAt,
      pageUrl: fp?.pageUrl,
    };
  });
}

/** Save the current completed run so a window reload can restore it. */
function persistSnapshot(context: vscode.ExtensionContext): void {
  const snap = healerState.snapshot;
  if (snap.phase !== 'done') return;
  const data: PersistedSnapshot = {
    results: snap.results,
    suggestions: [...snap.suggestionsByKey.entries()],
    explanations: [...snap.explanationsById.entries()],
    lastRunAt: snap.lastRunAt,
  };
  void context.workspaceState.update(SNAPSHOT_KEY, data);
}

/** Restore the last completed run into state, the suggestion store, and diagnostics. */
function restoreSnapshot(context: vscode.ExtensionContext): void {
  const data = context.workspaceState.get<PersistedSnapshot>(SNAPSHOT_KEY);
  if (!data || !Array.isArray(data.results) || data.results.length === 0) return;

  const suggestionsByKey = new Map(data.suggestions);
  const explanationsById = new Map(data.explanations);
  healerState.hydrate({
    results: data.results,
    suggestionsByKey,
    explanationsById,
    lastRunAt: data.lastRunAt,
  });
  storeSuggestions(flattenSuggestions(suggestionsByKey));
  // Diagnostics rebuild reactively: healerState.hydrate above fired onDidChange.
}

/** Lazily open (and reuse) the warm watch browser; returns its context, or undefined on failure. */
async function ensureWatchBrowser(config: HealerConfig, root: string) {
  if (!watchBrowser) {
    try {
      watchBrowser = await openHealerBrowser(config, root);
      outputChannel.appendLine(`[${time()}] Watch: opened a warm browser session`);
    } catch (e) {
      outputChannel.appendLine(
        `[${time()}] Watch: warm browser unavailable (${e instanceof Error ? e.message : String(e)}); using a fresh browser per run`,
      );
      watchBrowser = undefined;
    }
  }
  return watchBrowser?.context;
}

/** Tear down the warm watch browser (on watch-off, config change, or deactivate). */
async function closeWatchBrowser(): Promise<void> {
  const session = watchBrowser;
  if (!session) return;
  watchBrowser = undefined;
  try {
    await session.close();
  } catch {
    // Already gone — nothing to do.
  }
}

/** Queue a debounced watch re-verify for the given saved files. */
function scheduleWatchVerify(files: string[]): void {
  for (const f of files) pendingWatchFiles.add(f);
  watchDebouncer.schedule(() => {
    const batch = [...pendingWatchFiles];
    pendingWatchFiles.clear();
    void runWatchVerify(batch);
  });
}

/**
 * Watch mode's per-save re-verify: parse the saved test file(s), verify + heal
 * just their selectors, and merge into state (updating diagnostics, tree, and
 * status bar) without disturbing other files. Quiet — no dialogs; the watch
 * status item shows a spinner while it runs.
 */
async function runWatchVerify(files: string[]): Promise<void> {
  outputChannel.appendLine(
    `[${time()}] watch fired for ${files.map((f) => basename(f)).join(', ')}`,
  );
  // A watch verify is already in flight — requeue and let the current run drain it.
  if (watchRunning) {
    outputChannel.appendLine(`[${time()}] watch skip: a run is already in progress`);
    for (const f of files) pendingWatchFiles.add(f);
    return;
  }
  // A manual "Verify Now" or an apply re-verify is running — it already covers
  // this file, so drop the watch request rather than double-verifying.
  if (healerState.snapshot.phase === 'running') {
    outputChannel.appendLine(`[${time()}] watch skip: a verify is already running`);
    return;
  }

  const root = getWorkspaceRoot();
  if (!root) {
    outputChannel.appendLine(`[${time()}] watch skip: no workspace folder`);
    return;
  }
  const config = await loadConfig(true);
  if (!config) {
    outputChannel.appendLine(`[${time()}] watch skip: no config found`);
    return;
  }

  const testFiles = files.filter((f) => isTestFilePath(f, config.testDir));
  if (testFiles.length === 0) {
    outputChannel.appendLine(`[${time()}] watch skip: not under testDir (${config.testDir})`);
    return;
  }

  const selectors: SelectorUsage[] = [];
  for (const f of testFiles) {
    const parsed = parseTestFile(f);
    if (parsed.isOk()) selectors.push(...parsed.value);
  }
  if (selectors.length === 0) {
    outputChannel.appendLine(
      `[${time()}] watch skip: no selectors parsed from ${testFiles.length} file(s)`,
    );
    return;
  }

  // Re-verify ONLY the selectors the user actually changed (see
  // selectorsChangedSince — full signature, so a getByRole `name` edit counts).
  // Unchanged selectors keep their existing results, so watch never re-checks
  // (or wrongly flags) auth-/interaction-gated selectors that weren't touched.
  // A manual "Verify Now" still re-checks the whole suite.
  const changed = selectorsChangedSince(
    healerState.snapshot.results.map((r) => r.selector),
    selectors,
  );
  if (changed.length === 0) {
    outputChannel.appendLine(`[${time()}] watch: no selector changes to re-verify`);
    return;
  }
  outputChannel.appendLine(
    `[${time()}] watch: verifying ${changed.length} changed of ${selectors.length} selector(s)…`,
  );

  watchRunning = true;
  setWatch(watchStatusItem, 'running');
  const label =
    testFiles.length === 1
      ? `Re-verifying ${basename(testFiles[0] ?? '')}…`
      : `Re-verifying ${testFiles.length} files…`;
  notifyVerifying(true, label);
  const t0 = Date.now();
  try {
    // Reuse the warm browser so this save skips the cold Chromium launch.
    const context = await ensureWatchBrowser(config, root);
    const tReady = Date.now();
    // Verify by live match count (no baseline required) so selectors you're
    // actively editing get instant valid/broken feedback. Heal still enriches
    // any broken selector that does have a captured fingerprint.
    const results = await verifySelectors(changed, {
      config,
      projectRoot: root,
      requireBaseline: false,
      context,
    });
    const tVerify = Date.now();
    const broken = results.filter((r) => r.status === 'broken');
    const built = await healToSuggestions(broken, config, root, context);
    const tHeal = Date.now();

    healerState.mergeResults(results, built.suggestionsByKey, built.explanationMap);
    // Rebuild the code-action store from the merged state so this file's new
    // suggestions are usable without wiping other files'.
    const snap = healerState.snapshot;
    storeSuggestions(flattenSuggestions(snap.suggestionsByKey));
    // Diagnostics rebuild reactively: mergeResults above fired onDidChange.
    // Per-phase timings so the bottleneck is visible in the Output channel.
    outputChannel.appendLine(
      `[${time()}] Watch: ${broken.length} broken in ${testFiles.map((f) => basename(f)).join(', ')} · ` +
        `browser ${tReady - t0}ms · verify ${tVerify - tReady}ms (${selectors.length} sel) · ` +
        `heal ${tHeal - tVerify}ms (${broken.length} broken) · total ${tHeal - t0}ms`,
    );
  } catch (e) {
    outputChannel.appendLine(
      `[${time()}] Watch error: ${e instanceof Error ? e.message : String(e)}`,
    );
    // The warm browser may have crashed or been closed — discard it so the next
    // save reopens a fresh one rather than failing on a dead context.
    void closeWatchBrowser();
  } finally {
    watchRunning = false;
    notifyVerifying(false);
    setWatch(watchStatusItem, watchEnabled ? 'on' : 'off');
    // Drain any saves that arrived mid-run.
    if (pendingWatchFiles.size > 0) scheduleWatchVerify([]);
  }
}

/** Show/hide the "re-verifying…" banner on every open surface. */
function notifyVerifying(active: boolean, label?: string): void {
  dashboard.setVerifying(active, label);
  DashboardPanel.current?.setVerifying(active, label);
}

/** Toggle watch mode on/off, persisting the choice per workspace. */
async function toggleWatch(context: vscode.ExtensionContext): Promise<void> {
  watchEnabled = !watchEnabled;
  await context.workspaceState.update(WATCH_STATE_KEY, watchEnabled);
  setWatch(watchStatusItem, watchEnabled ? 'on' : 'off');
  dashboard.setWatch(watchEnabled);
  DashboardPanel.current?.setWatch(watchEnabled);
  if (watchEnabled) {
    vscode.window.showInformationMessage(
      'Selector Healer: watch on — saving a test file re-verifies its selectors.',
    );
  } else {
    watchDebouncer.cancel();
    pendingWatchFiles.clear();
    void closeWatchBrowser();
    vscode.window.showInformationMessage('Selector Healer: watch off.');
  }
}

/** Human label for a heal, e.g. `'button' → getByTestId('save')`. */
function healLabel(s: StoredSuggestion): string {
  return `${s.rawValue} → ${s.replacementCode}`;
}

/** Minimal StoredSuggestion for re-verifying a just-applied/undone selector by file+line. */
function healToStored(h: AppliedHeal, selectorId = ''): StoredSuggestion {
  return {
    selectorId,
    filePath: h.filePath,
    line: h.line,
    column: h.column,
    rawValue: '',
    replacementCode: h.after,
    confidence: 0,
  };
}

/** Revert one recorded heal, then drop it from history and offer to re-verify. */
async function undoEntry(entry: HealHistoryEntry, opts: { silent?: boolean } = {}): Promise<void> {
  const res = await undoHeal(entry);
  if (!res.ok) {
    const detail =
      res.reason === 'file-missing'
        ? 'its file could not be opened'
        : res.reason === 'not-found'
          ? "the healed code wasn't found (the file may have changed)"
          : res.reason === 'ambiguous'
            ? 'the healed code now appears in more than one place'
            : 'the edit could not be applied';
    vscode.window.showWarningMessage(`Selector Healer: couldn't undo ${entry.label} — ${detail}.`);
    return;
  }

  await healHistory.remove(entry.id);
  outputChannel.appendLine(
    `[${time()}] Reverted ${entry.label} (${basename(entry.filePath)}:${entry.line})`,
  );
  // From the history view: a quiet, non-blocking toast so the view can refresh
  // in place. From the command palette: offer to re-verify.
  if (opts.silent) {
    vscode.window.showInformationMessage(`Selector Healer: reverted ${entry.label}.`);
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `Selector Healer: reverted ${entry.label}.`,
    'Verify now',
  );
  if (choice === 'Verify now') await runVerify();
}

/** Undo the most recently applied heal. */
async function undoLastHeal(): Promise<void> {
  const entry = healHistory.latest();
  if (!entry) {
    vscode.window.showInformationMessage('Selector Healer: no heals to undo yet.');
    return;
  }
  await undoEntry(entry);
}

/** Open the Heal History view in the dashboard (a persistent panel, not a dropdown). */
async function showHealHistory(): Promise<void> {
  await dashboard.showHistory();
}

/** Applied heals, newest first, shaped for the history view. */
function getHistoryRows(): HistoryRow[] {
  return healHistory.all().map((e) => ({
    id: e.id,
    label: e.label,
    fileName: basename(e.filePath),
    filePath: e.filePath,
    line: e.line,
    column: e.column,
    appliedAt: e.appliedAt,
  }));
}

/** Undo one recorded heal by id (from the history view's Undo button). */
async function undoHistoryEntry(id: string): Promise<void> {
  const entry = healHistory.all().find((e) => e.id === id);
  if (entry) await undoEntry(entry, { silent: true });
}

/** Clear the heal history log (the applied fixes stay; only the undo log is forgotten). */
async function clearHealHistory(): Promise<void> {
  if (healHistory.all().length === 0) return;
  const choice = await vscode.window.showWarningMessage(
    'Clear all heal history? The applied fixes stay in your files — you just lose one-click undo for them.',
    { modal: true },
    'Clear',
  );
  if (choice === 'Clear') await healHistory.clear();
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
      label: '$(discard) Undo Last Heal',
      detail: 'Revert the most recently applied fix',
      cmd: 'selectorHealer.undoLastHeal',
    },
    {
      label: '$(history) Heal History',
      detail: 'Browse and undo past fixes',
      cmd: 'selectorHealer.showHealHistory',
    },
    {
      label: '$(trash) Prune Stale Baseline',
      detail: 'Remove fingerprints for selectors that no longer exist',
      cmd: 'selectorHealer.pruneStale',
    },
    {
      label: watchEnabled ? '$(eye) Watch: On — click to turn off' : '$(eye-closed) Watch: Off',
      detail: 'Auto re-verify a test file when you save it',
      cmd: WATCH_TOGGLE_COMMAND,
    },
    {
      label: '$(multiple-windows) Open Full Dashboard',
      detail: 'Open the roomy dashboard in an editor tab',
      cmd: 'selectorHealer.openDashboard',
    },
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Selector Healer' });
  if (pick) await vscode.commands.executeCommand(pick.cmd);
}
