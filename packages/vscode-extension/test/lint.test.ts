import type { DomFingerprint, SelectorUsage } from '@selector-healer/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./__mocks__/vscode.js'));

const { lintDiagnostics, getLintUpgrade, clearLintUpgrades, FRAGILE_CODE } = await import(
  '../src/lint.js'
);
const vscode = await import('./__mocks__/vscode.js');

function selUsage(
  o: Partial<SelectorUsage> & Pick<SelectorUsage, 'selectorType' | 'rawValue'>,
): SelectorUsage {
  return { id: 's', filePath: '/a.ts', line: 1, column: 1, ...o };
}

function fp(over: Partial<DomFingerprint> = {}): DomFingerprint {
  return {
    selectorId: 'x',
    capturedAt: '2026-01-01T00:00:00.000Z',
    tagName: 'div',
    attributes: {},
    textContent: '',
    parentChain: [],
    siblingIndex: 0,
    pageUrl: 'https://app.com',
    ...over,
  };
}

describe('lintDiagnostics', () => {
  beforeEach(() => clearLintUpgrades());

  it('emits an Information diagnostic for a fragile selector', () => {
    const diags = lintDiagnostics(
      '/a.ts',
      [selUsage({ selectorType: 'text', rawValue: 'Hi', line: 3 })],
      new Map(),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0]?.code).toBe(FRAGILE_CODE);
    expect(diags[0]?.source).toBe('selector-healer');
    expect(diags[0]?.severity).toBe(vscode.DiagnosticSeverity.Information);
  });

  it('does not flag sturdy selectors', () => {
    const diags = lintDiagnostics(
      '/a.ts',
      [
        selUsage({ selectorType: 'testid', rawValue: 'x' }),
        selUsage({ selectorType: 'role', rawValue: 'button' }),
      ],
      new Map(),
    );
    expect(diags).toHaveLength(0);
  });

  it('records a DOM-backed upgrade and mentions it in the message', () => {
    const sel = selUsage({ id: 's1', selectorType: 'text', rawValue: 'Login', line: 10 });
    const diags = lintDiagnostics(
      '/a.ts',
      [sel],
      new Map([['s1', fp({ attributes: { 'data-testid': 'login' } })]]),
    );
    expect(diags[0]?.message).toContain("page.getByTestId('login')");
    expect(getLintUpgrade('/a.ts', 10)).toBe("page.getByTestId('login')");
  });

  it('records no upgrade when the element exposes no sturdier anchor', () => {
    const sel = selUsage({ id: 's2', selectorType: 'text', rawValue: 'Hello', line: 5 });
    lintDiagnostics(
      '/a.ts',
      [sel],
      new Map([['s2', fp({ tagName: 'span', textContent: 'Hello' })]]),
    );
    expect(getLintUpgrade('/a.ts', 5)).toBeUndefined();
  });

  it('refreshes stale upgrades when a file is re-linted', () => {
    const sel = selUsage({ id: 's3', selectorType: 'text', rawValue: 'Login', line: 2 });
    lintDiagnostics('/a.ts', [sel], new Map([['s3', fp({ attributes: { 'data-testid': 'a' } })]]));
    expect(getLintUpgrade('/a.ts', 2)).toBe("page.getByTestId('a')");

    // Re-lint the same file; the line is now a sturdy test-id → stale entry cleared.
    lintDiagnostics(
      '/a.ts',
      [selUsage({ id: 's3b', selectorType: 'testid', rawValue: 'a', line: 2 })],
      new Map(),
    );
    expect(getLintUpgrade('/a.ts', 2)).toBeUndefined();
  });
});
