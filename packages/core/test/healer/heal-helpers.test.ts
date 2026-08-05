import { describe, expect, it } from 'vitest';
import {
  bestConfidence,
  dedupeByCode,
  isNoOpReplacement,
  keepCompetitiveCandidates,
} from '../../src/healer/heal.js';
import type { DomFingerprint, HealCandidate, SelectorUsage } from '../../src/types.js';

function selector(
  over: Partial<SelectorUsage> & Pick<SelectorUsage, 'selectorType' | 'rawValue'>,
): SelectorUsage {
  return { id: 'x', filePath: '/t.spec.ts', line: 1, column: 1, ...over };
}

const FP_STUB: DomFingerprint = {
  selectorId: 'x',
  capturedAt: '2026-01-01T00:00:00.000Z',
  tagName: 'div',
  attributes: {},
  textContent: '',
  parentChain: [],
  siblingIndex: 0,
  pageUrl: 'https://app.com',
};

function cand(replacementCode: string, confidence: number): HealCandidate {
  return { replacementCode, confidence, reasoning: '', matchedFingerprint: FP_STUB };
}

describe('keepCompetitiveCandidates', () => {
  it('returns empty or single-candidate lists unchanged', () => {
    expect(keepCompetitiveCandidates([])).toEqual([]);
    const one = [cand('only', 0.42)];
    expect(keepCompetitiveCandidates(one)).toEqual(one);
  });

  it('drops weak look-alikes behind a clear winner (the OrangeHRM case)', () => {
    // 0.90 winner; 0.52 / 0.48 are structural look-alikes >0.3 behind → dropped.
    const out = keepCompetitiveCandidates([
      cand('Add', 0.9),
      cand('Reset', 0.52),
      cand('Search', 0.48),
    ]);
    expect(out.map((c) => c.replacementCode)).toEqual(['Add']);
  });

  it('keeps a genuinely-competitive alternative, drops the distant one', () => {
    // 0.88 top; 0.64 is within 0.3 (kept); 0.41 is 0.47 behind (dropped).
    const out = keepCompetitiveCandidates([
      cand('testid', 0.88),
      cand('label', 0.64),
      cand('css', 0.41),
    ]);
    expect(out.map((c) => c.replacementCode)).toEqual(['testid', 'label']);
  });

  it('keeps all close alternatives when the top itself is uncertain', () => {
    expect(
      keepCompetitiveCandidates([cand('a', 0.5), cand('b', 0.45), cand('c', 0.3)]),
    ).toHaveLength(3);
  });

  it('treats an exactly-0.3 gap as still competitive (boundary)', () => {
    expect(keepCompetitiveCandidates([cand('a', 0.9), cand('b', 0.6)])).toHaveLength(2);
  });
});

describe('bestConfidence', () => {
  it('returns 0 for undefined or empty input', () => {
    expect(bestConfidence(undefined)).toBe(0);
    expect(bestConfidence([])).toBe(0);
  });

  it('returns the highest confidence regardless of order', () => {
    expect(bestConfidence([cand('a', 0.3), cand('b', 0.83), cand('c', 0.5)])).toBe(0.83);
    expect(bestConfidence([cand('a', 0.83), cand('b', 0.3)])).toBe(0.83);
  });

  it('handles a single candidate', () => {
    expect(bestConfidence([cand('only', 0.42)])).toBe(0.42);
  });
});

describe('dedupeByCode', () => {
  it('returns an empty array for no candidates', () => {
    expect(dedupeByCode([])).toEqual([]);
  });

  it('keeps distinct replacement codes', () => {
    const out = dedupeByCode([cand('a', 0.5), cand('b', 0.4)]);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.replacementCode).sort()).toEqual(['a', 'b']);
  });

  it('collapses duplicate codes, keeping the highest confidence', () => {
    // The same element found on two pages (e.g. Phase 1 weak, Phase 2 strong).
    const out = dedupeByCode([
      cand("page.getByTestId('avatar')", 0.3),
      cand("page.getByTestId('avatar')", 0.83),
      cand("page.getByText('x')", 0.4),
    ]);
    expect(out).toHaveLength(2);
    const avatar = out.find((c) => c.replacementCode === "page.getByTestId('avatar')");
    expect(avatar?.confidence).toBe(0.83);
  });

  it('is order-independent for which duplicate wins', () => {
    const lowFirst = dedupeByCode([cand('dup', 0.2), cand('dup', 0.9)]);
    const highFirst = dedupeByCode([cand('dup', 0.9), cand('dup', 0.2)]);
    expect(lowFirst[0]?.confidence).toBe(0.9);
    expect(highFirst[0]?.confidence).toBe(0.9);
  });
});

describe('isNoOpReplacement', () => {
  it('flags a candidate identical to the selector it would replace', () => {
    // The original bug: role=alert breaks by cascade, healer re-derives getByRole('alert').
    const s = selector({ selectorType: 'role', rawValue: 'alert' });
    expect(isNoOpReplacement(s, "page.getByRole('alert')")).toBe(true);
  });

  it('ignores an incidental receiver difference', () => {
    const s = selector({ selectorType: 'testid', rawValue: 'submit-btn' });
    expect(isNoOpReplacement(s, "getByTestId('submit-btn')")).toBe(true);
  });

  it('does not flag a genuinely different replacement', () => {
    const s = selector({ selectorType: 'role', rawValue: 'alert' });
    expect(isNoOpReplacement(s, "page.getByTestId('error-banner')")).toBe(false);
  });

  it('respects the role name option', () => {
    const s = selector({ selectorType: 'role', rawValue: 'button', options: { name: 'Log in' } });
    expect(isNoOpReplacement(s, "page.getByRole('button', { name: 'Log in' })")).toBe(true);
    expect(isNoOpReplacement(s, "page.getByRole('button', { name: 'Sign up' })")).toBe(false);
  });

  it('returns false for non-Playwright frameworks (nothing to reconstruct)', () => {
    const s = selector({ selectorType: 'testid', rawValue: 'x' });
    expect(isNoOpReplacement(s, '$(\'[data-testid="x"]\')', 'cypress')).toBe(false);
  });
});
