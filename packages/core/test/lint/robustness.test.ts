import { describe, expect, it } from 'vitest';
import { rateSelectorRobustness, rateSelectorType } from '../../src/lint/robustness.js';
import type { SelectorType, SelectorUsage } from '../../src/types.js';

function sel(selectorType: SelectorType, rawValue: string): SelectorUsage {
  return { id: 'x', filePath: '/a.ts', line: 1, column: 1, selectorType, rawValue };
}

describe('rateSelectorType', () => {
  it.each([
    ['testid', 'robust', 0],
    ['role', 'good', 1],
    ['label', 'good', 1],
    ['placeholder', 'moderate', 2],
    ['title', 'moderate', 2],
    ['alt', 'moderate', 2],
    ['text', 'fragile', 3],
    ['xpath', 'fragile', 3],
    ['css', 'fragile', 3],
    ['unknown', 'fragile', 3],
  ] as const)('%s → %s (rank %i)', (type, tier, rank) => {
    const r = rateSelectorType(type as SelectorType);
    expect(r.tier).toBe(tier);
    expect(r.rank).toBe(rank);
    expect(r.reason.length).toBeGreaterThan(0);
  });
});

describe('rateSelectorRobustness - CSS is value-aware', () => {
  it('rates a test-attribute CSS selector as robust', () => {
    expect(rateSelectorRobustness(sel('css', '[data-testid="submit"]')).tier).toBe('robust');
    expect(rateSelectorRobustness(sel('css', '[data-test="x"]')).tier).toBe('robust');
    expect(rateSelectorRobustness(sel('css', '[data-qa=login]')).tier).toBe('robust');
    expect(rateSelectorRobustness(sel('css', 'button[data-cy="go"]')).tier).toBe('robust');
  });

  it('rates a bare id selector as good', () => {
    expect(rateSelectorRobustness(sel('css', '#login-form')).tier).toBe('good');
  });

  it('rates class / structural / attribute CSS as fragile', () => {
    expect(rateSelectorRobustness(sel('css', '.oxd-button')).tier).toBe('fragile');
    expect(rateSelectorRobustness(sel('css', 'div > span.error')).tier).toBe('fragile');
    expect(rateSelectorRobustness(sel('css', 'form .field:nth-child(2)')).tier).toBe('fragile');
    expect(rateSelectorRobustness(sel('css', '#main .row')).tier).toBe('fragile'); // not a bare id
  });

  it('non-CSS kinds use the abstract rating', () => {
    expect(rateSelectorRobustness(sel('text', 'Forgot your password?')).tier).toBe('fragile');
    expect(rateSelectorRobustness(sel('testid', 'submit')).tier).toBe('robust');
    expect(rateSelectorRobustness(sel('role', 'button')).tier).toBe('good');
    expect(rateSelectorRobustness(sel('placeholder', 'Email')).tier).toBe('moderate');
  });
});
