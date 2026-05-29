import type { VerificationResult, VerificationStatus } from '@selector-healer/core';
import * as vscode from 'vscode';
import type { StoredSuggestion } from './code-actions.js';

type TreeNode = GroupItem | SelectorItem;

export type GroupKey = 'broken' | 'multi' | 'skipped' | 'ok';

interface GroupMeta {
  label: string;
  icon: string;
  color: string;
  statuses: VerificationStatus[];
  expanded: boolean;
}

const GROUP_META: Record<GroupKey, GroupMeta> = {
  broken: {
    label: 'Broken',
    icon: 'error',
    color: 'testing.iconFailed',
    statuses: ['broken'],
    expanded: true,
  },
  multi: {
    label: 'Ambiguous',
    icon: 'warning',
    color: 'testing.iconQueued',
    statuses: ['multiple-matches'],
    expanded: true,
  },
  skipped: {
    label: 'Skipped',
    icon: 'circle-slash',
    color: 'testing.iconSkipped',
    statuses: ['skipped', 'page-load-failed'],
    expanded: false,
  },
  ok: {
    label: 'OK',
    icon: 'pass',
    color: 'testing.iconPassed',
    statuses: ['ok'],
    expanded: false,
  },
};

const GROUP_ORDER: GroupKey[] = ['broken', 'multi', 'skipped', 'ok'];

/**
 * Tree data provider for the Selector Healer sidebar.
 * Groups selectors by status (Broken → Ambiguous → Skipped → OK), showing only
 * non-empty groups. Broken items expose an inline "Apply fix" action.
 */
export class SelectorTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
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
    this.suggestions = new Map();
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      return this.getGroups();
    }
    if (element instanceof GroupItem) {
      return this.getSelectors(element.key);
    }
    return [];
  }

  private getGroups(): GroupItem[] {
    const groups: GroupItem[] = [];
    for (const key of GROUP_ORDER) {
      const count = this.results.filter((r) => GROUP_META[key].statuses.includes(r.status)).length;
      if (count > 0) groups.push(new GroupItem(key, count));
    }
    return groups;
  }

  private getSelectors(key: GroupKey): SelectorItem[] {
    const statuses = GROUP_META[key].statuses;
    return this.results
      .filter((r) => statuses.includes(r.status))
      .map((r) => {
        const suggestion = this.suggestions.get(`${r.selector.filePath}:${r.selector.line}`)?.[0];
        return new SelectorItem(r, suggestion);
      });
  }
}

export class GroupItem extends vscode.TreeItem {
  constructor(
    public readonly key: GroupKey,
    public readonly count: number,
  ) {
    const meta = GROUP_META[key];
    super(
      `${meta.label} (${count})`,
      meta.expanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.contextValue = 'healerGroup';
    this.iconPath = new vscode.ThemeIcon(meta.icon, new vscode.ThemeColor(meta.color));
  }
}

export class SelectorItem extends vscode.TreeItem {
  constructor(
    public readonly result: VerificationResult,
    public readonly suggestion?: StoredSuggestion,
  ) {
    const sel = result.selector;
    const fileName = sel.filePath.split(/[/\\]/).pop() ?? sel.filePath;
    super(`${fileName}:${sel.line}`, vscode.TreeItemCollapsibleState.None);

    this.description = describe(result, suggestion);
    this.tooltip = buildTooltip(result, suggestion);
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
        this.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
        this.contextValue = 'healerSelector';
        break;
      case 'broken':
        this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
        // Only broken items WITH a suggestion get the inline Apply action.
        this.contextValue = suggestion ? 'healerBroken' : 'healerSelector';
        break;
      case 'multiple-matches':
        this.iconPath = new vscode.ThemeIcon(
          'warning',
          new vscode.ThemeColor('testing.iconQueued'),
        );
        this.contextValue = 'healerSelector';
        break;
      default:
        this.iconPath = new vscode.ThemeIcon(
          'circle-slash',
          new vscode.ThemeColor('testing.iconSkipped'),
        );
        this.contextValue = 'healerSelector';
        break;
    }
  }
}

function describe(result: VerificationResult, suggestion?: StoredSuggestion): string {
  const sel = result.selector;
  if (result.status === 'broken' && suggestion) {
    const pct = Math.round(suggestion.confidence * 100);
    return `→ ${truncate(suggestion.replacementCode, 36)} (${pct}%)`;
  }
  if (result.status === 'multiple-matches') {
    return `${truncate(sel.rawValue, 28)} · ${result.matchCount} matches`;
  }
  return `${sel.selectorType} · ${truncate(sel.rawValue, 30)}`;
}

function truncate(str: string, max: number): string {
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

function buildTooltip(result: VerificationResult, suggestion?: StoredSuggestion): string {
  const sel = result.selector;
  const lines = [`${sel.selectorType}('${sel.rawValue}')`, `${sel.filePath}:${sel.line}`];

  if (result.status === 'broken' && suggestion) {
    const pct = Math.round(suggestion.confidence * 100);
    lines.push('', `Suggested fix: ${suggestion.replacementCode} (${pct}%)`);
  } else if (result.status === 'broken') {
    lines.push('', 'Broken — no confident replacement found.');
  } else if (result.status === 'multiple-matches') {
    lines.push('', `Matches ${result.matchCount} elements — make it more specific.`);
  } else if (result.status === 'skipped' || result.status === 'page-load-failed') {
    lines.push('', 'No baseline — run Capture, or this element needs an interaction to appear.');
  }

  return lines.join('\n');
}
