import { describe, expect, it } from 'vitest';
import { lintSelectors } from '../../src/lint/lint.js';
import type { DomFingerprint, SelectorType, SelectorUsage } from '../../src/types.js';

let counter = 0;
function sel(
  selectorType: SelectorType,
  rawValue: string,
  over: Partial<SelectorUsage> = {},
): SelectorUsage {
  counter += 1;
  return {
    id: `id${counter}`,
    filePath: '/a.ts',
    line: counter,
    column: 1,
    selectorType,
    rawValue,
    ...over,
  };
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

describe('lintSelectors - static fragility', () => {
  it('flags only fragile selectors, leaving sturdy ones alone', () => {
    const selectors = [
      sel('testid', 'submit'),
      sel('role', 'button'),
      sel('label', 'Email'),
      sel('placeholder', 'Search'),
      sel('css', '#login'), // bare id → good
      sel('css', '[data-testid="x"]'), // robust
      sel('text', 'Forgot your password?'), // fragile
      sel('css', '.oxd-button'), // fragile
      sel('xpath', '//div[1]'), // fragile
    ];
    const flagged = lintSelectors(selectors).map((f) => f.rawValue);
    expect(flagged).toEqual(['Forgot your password?', '.oxd-button', '//div[1]']);
  });

  it('carries location + a helpful message, with no upgrade absent fingerprints', () => {
    const s = sel('text', 'Hi');
    const [finding] = lintSelectors([s]);
    expect(finding?.selectorId).toBe(s.id);
    expect(finding?.line).toBe(s.line);
    expect(finding?.tier).toBe('fragile');
    expect(finding?.message).toMatch(/Prefer getByRole or getByTestId/);
    expect(finding?.upgrade).toBeUndefined();
  });
});

describe('lintSelectors - DOM-backed upgrades', () => {
  it('suggests getByTestId when the matched element has a test-id', () => {
    const s = sel('text', 'Login');
    const fingerprints = new Map([
      [
        s.id,
        fp({ tagName: 'button', attributes: { 'data-testid': 'login-btn' }, textContent: 'Login' }),
      ],
    ]);
    const [finding] = lintSelectors([s], { fingerprints });
    expect(finding?.upgrade?.tier).toBe('robust');
    expect(finding?.upgrade?.replacementCode).toBe("page.getByTestId('login-btn')");
  });

  it('upgrades a fragile CSS selector to a role-based one', () => {
    const s = sel('css', '.oxd-userdropdown');
    const fingerprints = new Map([
      [s.id, fp({ tagName: 'button', attributes: { role: 'button', 'aria-label': 'User' } })],
    ]);
    const [finding] = lintSelectors([s], { fingerprints });
    expect(finding?.upgrade?.tier).toBe('good');
    expect(finding?.upgrade?.replacementCode).toContain('getByRole');
  });

  it('does NOT upgrade when the element exposes no sturdier anchor', () => {
    const s = sel('text', 'Hello');
    const fingerprints = new Map([[s.id, fp({ tagName: 'span', textContent: 'Hello' })]]);
    const [finding] = lintSelectors([s], { fingerprints });
    expect(finding?.upgrade).toBeUndefined();
  });

  it('emits the upgrade in the selector’s own framework', () => {
    const s = sel('text', 'Login', { framework: 'cypress' });
    const fingerprints = new Map([[s.id, fp({ attributes: { 'data-testid': 'login-btn' } })]]);
    const [finding] = lintSelectors([s], { fingerprints });
    expect(finding?.framework).toBe('cypress');
    expect(finding?.upgrade?.replacementCode).toBe('cy.get(\'[data-testid="login-btn"]\')');
  });

  it('falls back to the option framework when the selector carries none', () => {
    const s = sel('text', 'Login');
    const fingerprints = new Map([[s.id, fp({ attributes: { 'data-testid': 'x' } })]]);
    const [finding] = lintSelectors([s], { fingerprints, framework: 'webdriverio' });
    expect(finding?.framework).toBe('webdriverio');
    expect(finding?.upgrade?.replacementCode).toBe('$(\'[data-testid="x"]\')');
  });
});
