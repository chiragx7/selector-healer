import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./__mocks__/vscode.js'));

const { SelectorTreeProvider, GroupItem, SelectorItem } = await import('../src/tree-view.js');
const vscode = await import('./__mocks__/vscode.js');

/** Safe array access that throws in tests rather than using a non-null assertion. */
function at<T>(arr: T[], index: number): T {
  const item = arr[index];
  if (item === undefined) throw new Error(`Expected item at index ${index}`);
  return item;
}

let counter = 0;
function makeResult(
  status: string,
  selectorOverrides: Record<string, unknown> = {},
): {
  selector: Record<string, unknown>;
  status: string;
  matchCount: number;
} {
  counter += 1;
  return {
    selector: {
      id: `sel_${counter}`,
      filePath: '/test/login.spec.ts',
      line: 10,
      column: 5,
      rawValue: '#submit-btn',
      selectorType: 'css',
      framework: 'playwright',
      ...selectorOverrides,
    },
    status,
    matchCount: status === 'ok' ? 1 : status === 'multiple-matches' ? 5 : 0,
  };
}

function makeSuggestion(overrides: Record<string, unknown> = {}) {
  return {
    selectorId: 'sel_x',
    filePath: '/test/login.spec.ts',
    line: 10,
    column: 5,
    rawValue: '#submit-btn',
    replacementCode: 'getByTestId("submit")',
    confidence: 0.92,
    ...overrides,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: test fixtures are loosely typed
function refresh(provider: any, results: unknown[], suggestions = new Map()) {
  provider.refresh(results, suggestions);
}

describe('SelectorTreeProvider (grouped by status)', () => {
  // biome-ignore lint/suspicious/noExplicitAny: provider instance
  let provider: any;

  beforeEach(() => {
    provider = new SelectorTreeProvider();
  });

  it('returns no groups when empty', () => {
    expect(provider.getChildren()).toEqual([]);
  });

  it('fires onDidChangeTreeData on refresh', () => {
    let fired = false;
    provider.onDidChangeTreeData(() => {
      fired = true;
    });
    refresh(provider, []);
    expect(fired).toBe(true);
  });

  describe('status groups', () => {
    it('creates a group per non-empty status', () => {
      refresh(provider, [makeResult('ok'), makeResult('broken'), makeResult('ok')]);
      const groups = provider.getChildren();
      expect(groups.length).toBe(2); // Broken + OK
      for (const g of groups) expect(g instanceof GroupItem).toBe(true);
    });

    it('puts Broken first', () => {
      refresh(provider, [makeResult('ok'), makeResult('broken')]);
      const first = at(provider.getChildren(), 0);
      expect(first.key).toBe('broken');
      expect(String(first.label)).toContain('Broken');
    });

    it('includes the count in the group label', () => {
      refresh(provider, [makeResult('broken'), makeResult('broken')]);
      const group = at(provider.getChildren(), 0);
      expect(String(group.label)).toContain('(2)');
    });

    it('expands Broken, collapses OK', () => {
      refresh(provider, [makeResult('broken'), makeResult('ok')]);
      const groups = provider.getChildren();
      const broken = groups.find((g: { key: string }) => g.key === 'broken');
      const ok = groups.find((g: { key: string }) => g.key === 'ok');
      expect(broken.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Expanded);
      expect(ok.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
    });

    it('uses an error icon for the Broken group', () => {
      refresh(provider, [makeResult('broken')]);
      const group = at(provider.getChildren(), 0);
      expect((group.iconPath as { id: string }).id).toBe('error');
    });

    it('groups multiple-matches under Ambiguous', () => {
      refresh(provider, [makeResult('multiple-matches')]);
      const group = at(provider.getChildren(), 0);
      expect(group.key).toBe('multi');
      expect(String(group.label)).toContain('Ambiguous');
    });

    it('groups skipped and page-load-failed together', () => {
      refresh(provider, [makeResult('skipped'), makeResult('page-load-failed')]);
      const group = at(provider.getChildren(), 0);
      expect(group.key).toBe('skipped');
      expect(String(group.label)).toContain('(2)');
    });
  });

  describe('selector items', () => {
    it('returns the selectors within a group', () => {
      refresh(provider, [
        makeResult('broken'),
        makeResult('broken', { line: 20 }),
        makeResult('ok'),
      ]);
      const brokenGroup = at(provider.getChildren(), 0);
      const children = provider.getChildren(brokenGroup);
      expect(children.length).toBe(2);
      for (const c of children) expect(c instanceof SelectorItem).toBe(true);
    });

    it('shows an error icon for broken selectors', () => {
      refresh(provider, [makeResult('broken')]);
      const group = at(provider.getChildren(), 0);
      const item = at(provider.getChildren(group), 0);
      expect((item.iconPath as { id: string }).id).toBe('error');
    });

    it('shows a pass icon for ok selectors', () => {
      refresh(provider, [makeResult('ok')]);
      const group = at(provider.getChildren(), 0);
      const item = at(provider.getChildren(group), 0);
      expect((item.iconPath as { id: string }).id).toBe('pass');
    });

    it('labels items as fileName:line', () => {
      refresh(provider, [makeResult('ok', { line: 42 })]);
      const group = at(provider.getChildren(), 0);
      const item = at(provider.getChildren(group), 0);
      expect(String(item.label)).toBe('login.spec.ts:42');
    });

    it('navigates to the selector on click', () => {
      refresh(provider, [makeResult('ok')]);
      const group = at(provider.getChildren(), 0);
      const item = at(provider.getChildren(group), 0);
      expect(item.command?.command).toBe('vscode.open');
    });

    it('shows match count in description for ambiguous', () => {
      refresh(provider, [makeResult('multiple-matches')]);
      const group = at(provider.getChildren(), 0);
      const item = at(provider.getChildren(group), 0);
      expect(item.description).toContain('5 matches');
    });
  });

  describe('inline apply on broken items', () => {
    it('marks broken-with-suggestion items as healerBroken and shows the fix', () => {
      const suggestions = new Map([['/test/login.spec.ts:10', [makeSuggestion()]]]);
      refresh(provider, [makeResult('broken')], suggestions);
      const group = at(provider.getChildren(), 0);
      const item = at(provider.getChildren(group), 0);
      expect(item.contextValue).toBe('healerBroken');
      expect(item.description).toContain('→');
      expect(item.description).toContain('92%');
      expect(item.suggestion).toBeDefined();
    });

    it('broken without a suggestion is not inline-applyable', () => {
      refresh(provider, [makeResult('broken')]);
      const group = at(provider.getChildren(), 0);
      const item = at(provider.getChildren(group), 0);
      expect(item.contextValue).toBe('healerSelector');
      expect(item.suggestion).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('empties all groups and fires change', () => {
      refresh(provider, [makeResult('broken')]);
      let fired = false;
      provider.onDidChangeTreeData(() => {
        fired = true;
      });
      provider.clear();
      expect(fired).toBe(true);
      expect(provider.getChildren()).toEqual([]);
    });
  });
});
