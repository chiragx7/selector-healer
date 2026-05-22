import * as vscode from 'vscode';

export function createStatusBarItem(): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  item.command = 'selectorHealer.verify';
  setIdle(item);
  item.show();
  return item;
}

export function setIdle(item: vscode.StatusBarItem): void {
  item.text = '$(shield) Selector Healer';
  item.tooltip = 'Click to verify selectors';
  item.backgroundColor = undefined;
}

export function setRunning(item: vscode.StatusBarItem): void {
  item.text = '$(sync~spin) Verifying selectors...';
  item.tooltip = 'Verification in progress';
}

export function setResults(
  item: vscode.StatusBarItem,
  ok: number,
  broken: number,
  total: number,
): void {
  if (broken === 0) {
    item.text = `$(shield) ${ok}/${total} selectors OK`;
    item.tooltip = 'All selectors verified successfully';
    item.backgroundColor = undefined;
  } else {
    item.text = `$(warning) ${broken} broken selector${broken > 1 ? 's' : ''}`;
    item.tooltip = `${broken} broken, ${ok} ok out of ${total} total`;
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
}
