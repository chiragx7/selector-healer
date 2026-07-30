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
  renderConfigFile,
  renderSelectorCode,
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
import { Debouncer, isTestFilePath, selectorsChangedSince } from './watch.js';
import type { BaselineRow, CaptureSink } from './webview-content.js';

let diagnosticCollection: vscode.DiagnosticCollection;
let statusBarItem: vscode.StatusBarItem;
let watchStatusItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let dashboard: DashboardViewProvider;

// ── Watch mode: auto re-verify a test file when it's saved (opt-in) ──────────
const WATCH_DEBOUNCE_MS = 400;
const WATCH_STATE_KEY = 'selectorHealer.watch';
const SNAPSHOT_KEY = 'selectorHealer.lastSnapshot';
let watchEnabled = false;
let watchRunning = false;
const watchDebouncer = new Debouncer(WATCH_DEBOUNCE_MS);
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
  diagnosticCollection = createDiagnosticCollection();
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
    initDecorations(context.extensionUri),
  );

  // Single source of truth: state changes drive the status bar.
  // (The dashboard, CodeLens, and decorations subscribe to state themselves.)
  context.subscriptions.push(
    healerState.onDidChange((snap) => {
      if (snap.phase === 'running') {
        setRunning(statusBarItem);
      } else if (snap.phase === 'done') {
        setResults(statusBarItem, countResults(snap.results));
      } else {
        setIdle(statusBarItem);
      }
    }),
    // Persist every completed run so a window reload can restore it.
    healerState.onDidChange(() => persistSnapshot(context)),
  );

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
    diagnosticCollection.delete(doc.uri);
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
  const fragile = lintDiagnostics(doc.uri.fsPath, selectors, fingerprints);
  diagnosticCollection.set(doc.uri, [...diagnostics, ...fragile]);
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
    updateDiagnosticsFromResults(
      diagnosticCollection,
      results,
      built.suggestionMap,
      built.explanationMap,
    );
    healerState.setResults(results, built.suggestionsByKey, built.explanationMap);

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

    const snap = healerState.snapshot;
    updateDiagnosticsFromResults(
      diagnosticCollection,
      snap.results,
      topSuggestionById(snap.suggestionsByKey),
      snap.explanationsById,
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

interface BuiltHeal {
  /** selector id → top replacement code (for diagnostic messages). */
  suggestionMap: Map<string, string>;
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
  const suggestionMap = new Map<string, string>();
  const explanationMap = new Map<string, string>();
  const suggestionsByKey = new Map<string, StoredSuggestion[]>();
  const allSuggestions: StoredSuggestion[] = [];
  if (broken.length === 0) {
    return { suggestionMap, explanationMap, suggestionsByKey, allSuggestions };
  }

  const healResults = await healSelectors(broken, { config, projectRoot: root, context });
  for (const h of healResults) {
    // The top break reason (why it broke) — shown in the diagnostic message.
    if (h.explanation?.[0]) explanationMap.set(h.selectorId, h.explanation[0].summary);
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
  return { suggestionMap, explanationMap, suggestionsByKey, allSuggestions };
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
  updateDiagnosticsFromResults(
    diagnosticCollection,
    data.results,
    topSuggestionById(suggestionsByKey),
    explanationsById,
  );
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
    updateDiagnosticsFromResults(
      diagnosticCollection,
      snap.results,
      topSuggestionById(snap.suggestionsByKey),
      snap.explanationsById,
    );
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

/** Compact "3m ago" style relative time for history entries. */
function relTime(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Revert one recorded heal, then drop it from history and offer to re-verify. */
async function undoEntry(entry: HealHistoryEntry): Promise<void> {
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

/** Browse the heal history in a QuickPick; pick an entry to undo it, or clear the log. */
async function showHealHistory(): Promise<void> {
  const entries = healHistory.all();
  if (entries.length === 0) {
    vscode.window.showInformationMessage('Selector Healer: no heal history yet.');
    return;
  }

  type Item = vscode.QuickPickItem & { entry?: HealHistoryEntry; action?: 'clear' };
  const items: Item[] = entries.map((e) => ({
    label: e.label,
    description: relTime(e.appliedAt),
    detail: `${basename(e.filePath)}:${e.line}`,
    entry: e,
  }));
  items.push({ label: '$(clear-all) Clear heal history', action: 'clear' });

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a heal to undo',
  });
  if (!pick) return;
  if (pick.action === 'clear') {
    await healHistory.clear();
    vscode.window.showInformationMessage('Selector Healer: heal history cleared.');
    return;
  }
  if (pick.entry) await undoEntry(pick.entry);
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
