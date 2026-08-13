import * as vscode from 'vscode';
import type { StatusCounts } from './state.js';

/** Command shown when the status-bar item is clicked (opens a quick-pick menu). */
export const STATUS_MENU_COMMAND = 'selectorHealer.showMenu';

/** Command bound to the watch-mode status item (toggles watch on/off). */
export const WATCH_TOGGLE_COMMAND = 'selectorHealer.toggleWatch';

/**
 * Create the Selector Healer status-bar item. Clicking it opens the action menu.
 */
export function createStatusBarItem(): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  item.command = STATUS_MENU_COMMAND;
  setIdle(item);
  item.show();
  return item;
}

/**
 * Create the watch-mode status-bar item - a small toggle sitting next to the
 * main item. Hidden until {@link setWatch} shows it in the `on`/`running` state.
 */
export function createWatchStatusItem(): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  item.command = WATCH_TOGGLE_COMMAND;
  return item;
}

/** Render the watch item: hidden when off, an eye when on, a spinner mid-run. */
export function setWatch(item: vscode.StatusBarItem, state: 'off' | 'on' | 'running'): void {
  if (state === 'off') {
    item.hide();
    return;
  }
  item.text = state === 'running' ? '$(sync~spin) Watch' : '$(eye) Watch';
  item.tooltip =
    state === 'running'
      ? 'Selector Healer: watch is re-verifying the file you saved…'
      : 'Selector Healer: watch on - saving a test file re-verifies it. Click to turn off.';
  item.show();
}

/** Neutral, no-results state. */
export function setIdle(item: vscode.StatusBarItem): void {
  item.text = '$(shield) Selector Healer';
  item.tooltip = 'Selector Healer - click for actions';
  item.backgroundColor = undefined;
}

/** In-progress verification state. */
export function setRunning(item: vscode.StatusBarItem): void {
  item.text = '$(sync~spin) Verifying selectors…';
  item.tooltip = 'Selector Healer: verification in progress';
  item.backgroundColor = undefined;
}

/**
 * Render verification results: red when broken, amber when only ambiguous,
 * neutral with a health percentage when clean.
 */
export function setResults(item: vscode.StatusBarItem, counts: StatusCounts): void {
  const { ok, broken, multi, total, healthPct } = counts;

  if (broken > 0) {
    item.text = `$(error) ${broken} broken selector${broken > 1 ? 's' : ''}`;
    item.tooltip = `Selector Healer: ${broken} broken, ${multi} ambiguous, ${ok}/${total} OK - click for actions`;
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else if (multi > 0) {
    item.text = `$(warning) ${multi} ambiguous`;
    item.tooltip = `Selector Healer: ${multi} ambiguous, ${ok}/${total} OK - click for actions`;
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else {
    item.text = `$(shield) ${healthPct}% healthy`;
    item.tooltip = `Selector Healer: ${ok}/${total} selectors OK - click for actions`;
    item.backgroundColor = undefined;
  }
}
