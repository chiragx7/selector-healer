import type { SelectorUsage, VerificationResult } from '@selector-healer/core';
import * as vscode from 'vscode';
import type { StoredSuggestion } from './code-actions.js';

type TreeItem = FileItem | SelectorItem;

/**
 * Tree data provider for the Selector Healer sidebar.
 * Shows selectors grouped by file with status icons.
 */
export class SelectorTreeProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private results: VerificationResult[] = [];
  private suggestions = new Map<string, StoredSuggestion[]>();

  refresh(results: VerificationResult[], suggestions: Map<string, StoredSuggestion[]>): void {
    this.results = results;
    this.suggestions = suggestions;
    this._onDidChangeTreeData.fire(undefined);
  }

  clear(): void {
    this.results = [];
    this.suggestions.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeItem): TreeItem[] {
    if (!element) {
      return this.getFileItems();
    }
    if (element instanceof FileItem) {
      return this.getSelectorItems(element.filePath);
    }
    return [];
  }

  private getFileItems(): FileItem[] {
    const byFile = new Map<string, VerificationResult[]>();

    for (const r of this.results) {
      const list = byFile.get(r.selector.filePath) ?? [];
      list.push(r);
      byFile.set(r.selector.filePath, list);
    }

    const items: FileItem[] = [];
    for (const [filePath, results] of byFile) {
      const ok = results.filter((r) => r.status === 'ok').length;
      const broken = results.filter((r) => r.status === 'broken').length;
      const skipped = results.filter(
        (r) => r.status === 'skipped' || r.status === 'page-load-failed',
      ).length;
      const multi = results.filter((r) => r.status === 'multiple-matches').length;

      items.push(new FileItem(filePath, results.length, ok, broken, multi, skipped));
    }

    return items.sort((a, b) => {
      // Broken files first
      if (a.broken !== b.broken) return b.broken - a.broken;
      const aName = a.label?.toString() ?? '';
      const bName = b.label?.toString() ?? '';
      return aName.localeCompare(bName);
    });
  }

  private getSelectorItems(filePath: string): SelectorItem[] {
    return this.results
      .filter((r) => r.selector.filePath === filePath)
      .map((r) => {
        const key = `${r.selector.filePath}:${r.selector.line}`;
        const sug = this.suggestions.get(key);
        const topSuggestion = sug?.[0];
        return new SelectorItem(r, topSuggestion);
      });
  }
}

class FileItem extends vscode.TreeItem {
  constructor(
    public readonly filePath: string,
    public readonly total: number,
    public readonly ok: number,
    public readonly broken: number,
    public readonly multi: number,
    public readonly skipped: number,
  ) {
    const fileName = filePath.split(/[/\\]/).pop() ?? filePath;
    super(fileName, vscode.TreeItemCollapsibleState.Expanded);

    this.resourceUri = vscode.Uri.file(filePath);
    this.tooltip = `${total} selectors: ${ok} ok, ${broken} broken, ${multi} ambiguous, ${skipped} skipped`;

    if (broken > 0) {
      this.description = `${broken} broken, ${ok} ok`;
      this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    } else if (multi > 0) {
      this.description = `${multi} ambiguous, ${ok} ok`;
      this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('testing.iconQueued'));
    } else {
      this.description = `${ok} ok${skipped > 0 ? `, ${skipped} skipped` : ''}`;
      this.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
    }
  }
}

class SelectorItem extends vscode.TreeItem {
  constructor(result: VerificationResult, suggestion?: StoredSuggestion) {
    const sel = result.selector;
    const displayValue = truncate(sel.rawValue, 40);
    super(displayValue, vscode.TreeItemCollapsibleState.None);

    this.description = `${sel.selectorType} (line ${sel.line})`;
    this.tooltip = buildTooltip(result, suggestion);

    // Click navigates to the selector in the editor
    this.command = {
      command: 'vscode.open',
      title: 'Go to selector',
      arguments: [
        vscode.Uri.file(sel.filePath),
        {
          selection: new vscode.Range(
            new vscode.Position(sel.line - 1, sel.column - 1),
            new vscode.Position(sel.line - 1, sel.column - 1 + sel.rawValue.length),
          ),
        } satisfies vscode.TextDocumentShowOptions,
      ],
    };

    switch (result.status) {
      case 'ok':
        this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
        break;
      case 'broken':
        this.iconPath = new vscode.ThemeIcon('close', new vscode.ThemeColor('testing.iconFailed'));
        break;
      case 'multiple-matches':
        this.iconPath = new vscode.ThemeIcon(
          'warning',
          new vscode.ThemeColor('testing.iconQueued'),
        );
        break;
      case 'skipped':
      case 'page-load-failed':
        this.iconPath = new vscode.ThemeIcon(
          'circle-slash',
          new vscode.ThemeColor('testing.iconSkipped'),
        );
        break;
    }
  }
}

function truncate(str: string, max: number): string {
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

function buildTooltip(result: VerificationResult, suggestion?: StoredSuggestion): string {
  const sel = result.selector;
  const lines = [
    `${sel.selectorType}('${sel.rawValue}')`,
    `File: ${sel.filePath}`,
    `Line ${sel.line}`,
  ];

  if (result.status === 'broken' && suggestion) {
    const pct = Math.round(suggestion.confidence * 100);
    lines.push('', `Suggestion: ${suggestion.replacementCode} (${pct}%)`);
  }

  if (result.status === 'multiple-matches') {
    lines.push('', 'This selector matches multiple elements — make it more specific.');
  }

  return lines.join('\n');
}
