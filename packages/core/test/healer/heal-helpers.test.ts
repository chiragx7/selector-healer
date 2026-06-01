import { describe, expect, it } from 'vitest';
import { bestConfidence, dedupeByCode } from '../../src/healer/heal.js';
import type { DomFingerprint, HealCandidate } from '../../src/types.js';

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
