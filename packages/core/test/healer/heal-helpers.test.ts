import { describe, expect, it } from 'vitest';
import { type SelectorFeedback, emptyFeedback } from '../../src/healer/feedback.js';
import {
  bestConfidence,
  buildScoredCandidate,
  dedupeByCode,
  isNoOpReplacement,
  isUnreachable,
  keepCompetitiveCandidates,
  rankCandidates,
  samePage,
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

/** A candidate whose structural (gate/rank) and nudged (display) scores differ. */
function candSN(replacementCode: string, structural: number, nudged: number): HealCandidate {
  return {
    replacementCode,
    confidence: nudged,
    structuralConfidence: structural,
    reasoning: '',
    matchedFingerprint: FP_STUB,
  };
}

describe('buildScoredCandidate - learning nudge', () => {
  // A well-matched testid candidate against a slightly different baseline, so the
  // base score has room below 1.0 for the nudge to be visible.
  const stored: DomFingerprint = {
    ...FP_STUB,
    tagName: 'button',
    attributes: { 'data-testid': 'save' },
    textContent: 'Save changes',
  };
  const candidate: DomFingerprint = {
    ...FP_STUB,
    tagName: 'div',
    attributes: { 'data-testid': 'save' },
    textContent: '',
  };

  it('leaves confidence untouched and sets no note without feedback', () => {
    const c = buildScoredCandidate(stored, candidate, 'playwright', emptyFeedback());
    expect(c.replacementCode).toContain('getByTestId');
    expect(c.learningNote).toBeUndefined();
  });

  it('boosts a well-accepted kind and records the note', () => {
    const base = buildScoredCandidate(stored, candidate, 'playwright', emptyFeedback());
    const fb: SelectorFeedback = { version: 1, byType: { testid: { accepted: 9, rejected: 1 } } };
    const learned = buildScoredCandidate(stored, candidate, 'playwright', fb);
    // structuralConfidence stays the pure score; only `confidence` (display/rank)
    // is nudged - so gates keyed on structuralConfidence are unaffected.
    expect(learned.structuralConfidence).toBe(base.confidence);
    expect(learned.confidence).toBeGreaterThan(learned.structuralConfidence ?? 0);
    expect(learned.learningNote).toMatch(/you usually accept testid fixes/);
  });
});

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

  it('drops a far-behind look-alike of a confident top (the reported Admin/PIM case)', () => {
    // 0.96 top; 0.67 alternatives are >25% below it → different elements, dropped.
    const out = keepCompetitiveCandidates([
      cand('Admin', 0.96),
      cand('PIM', 0.67),
      cand('Leave', 0.67),
    ]);
    expect(out.map((c) => c.replacementCode)).toEqual(['Admin']);
  });

  it('keeps a genuinely-competitive alternative, drops the distant one', () => {
    // top 0.88 → floor 0.66: 0.70 is competitive (kept), 0.41 is far behind (dropped).
    const out = keepCompetitiveCandidates([
      cand('testid', 0.88),
      cand('label', 0.7),
      cand('css', 0.41),
    ]);
    expect(out.map((c) => c.replacementCode)).toEqual(['testid', 'label']);
  });

  it('keeps close alternatives when the top itself is uncertain', () => {
    // top 0.5 → floor 0.375: 0.45 and 0.4 both clear it.
    expect(
      keepCompetitiveCandidates([cand('a', 0.5), cand('b', 0.45), cand('c', 0.4)]),
    ).toHaveLength(3);
  });

  it('keeps an alternative exactly at the ratio floor (boundary)', () => {
    // 0.6 === 0.8 × 0.75 exactly.
    expect(keepCompetitiveCandidates([cand('a', 0.8), cand('b', 0.6)])).toHaveLength(2);
  });
});

describe('rankCandidates', () => {
  it('retains the structurally-best fix even when a nudge ranks it last (finding: auto-apply pool)', () => {
    // A is the best *structural* match (0.82) but its kind is disliked, so its
    // nudged/display score (0.72) sits below three liked-kind look-alikes. Slicing
    // the pool by nudged confidence (the old behaviour) would drop A entirely -
    // starving CLI --fix / Apply-All, which pick the structurally-best *survivor*.
    const A = candSN('page.getByTestId("real")', 0.82, 0.72);
    const out = rankCandidates([
      candSN('b', 0.7, 0.8),
      candSN('c', 0.68, 0.78),
      candSN('d', 0.66, 0.76),
      A,
    ]);
    expect(out.map((c) => c.replacementCode)).toContain('page.getByTestId("real")');
    // …and it stays the structural-best of the survivors, so auto-apply selects it.
    const best = out.reduce((m, c) =>
      (c.structuralConfidence ?? c.confidence) > (m.structuralConfidence ?? m.confidence) ? c : m,
    );
    expect(best.replacementCode).toBe('page.getByTestId("real")');
  });

  it('still drops sibling look-alikes behind a confident winner (the Admin case)', () => {
    const out = rankCandidates([
      candSN('Admin', 0.9, 0.96),
      candSN('PIM', 0.61, 0.67),
      candSN('Leave', 0.61, 0.67),
    ]);
    expect(out.map((c) => c.replacementCode)).toEqual(['Admin']);
  });

  it('caps the displayed list at three', () => {
    const out = rankCandidates([
      candSN('a', 0.9, 0.9),
      candSN('b', 0.85, 0.85),
      candSN('c', 0.8, 0.8),
      candSN('d', 0.78, 0.78),
      candSN('e', 0.76, 0.76),
    ]);
    expect(out.length).toBeLessThanOrEqual(3);
  });

  it('presents survivors in nudged order, not structural order', () => {
    // Structural order is a,b,c; nudges flip b ahead of a for display.
    const out = rankCandidates([
      candSN('a', 0.85, 0.8),
      candSN('b', 0.82, 0.88),
      candSN('c', 0.8, 0.79),
    ]);
    expect(out.map((c) => c.replacementCode)).toEqual(['b', 'a', 'c']);
  });

  it('re-adds the structural-best when the nudged-ratio trim would drop it', () => {
    // Finding: A is the structural-best (0.66) but its kind is disliked (nudged
    // 0.56); B is structurally weaker (0.65) but liked (nudged 0.75). The nudged
    // floor (0.75 × 0.75 = 0.5625) would drop A as a "look-alike" - but it's the
    // strongest match, and auto-apply picks the structural-best survivor, so it
    // must remain present.
    const A = candSN('page.getByTestId("best")', 0.66, 0.56);
    const out = rankCandidates([A, candSN('page.getByText("liked")', 0.65, 0.75)]);
    expect(out.map((c) => c.replacementCode)).toContain('page.getByTestId("best")');
    const best = out.reduce((m, c) =>
      (c.structuralConfidence ?? c.confidence) > (m.structuralConfidence ?? m.confidence) ? c : m,
    );
    expect(best.replacementCode).toBe('page.getByTestId("best")');
  });
});

describe('isUnreachable', () => {
  const base = {
    hasCandidate: false,
    hasBaseline: true,
    scannedOk: false,
    scanFailed: true,
    wrongPage: false,
  };

  it('is true when a baseline existed but every page we tried failed to load', () => {
    // The reported case: heal's page scan hard-failed (timeout/refused), no candidate.
    expect(isUnreachable(base)).toBe(true);
  });

  it('is true when a page loaded but was the wrong one (login-redirect, no hard failure)', () => {
    // The login-bounce case: the protected route 200s to a login screen, so no load
    // FAILED, but we never reached the element's own page - "couldn't reach", not gone.
    expect(isUnreachable({ ...base, scanFailed: false, wrongPage: true })).toBe(true);
  });

  it('is false once any candidate was found (we clearly reached a page)', () => {
    expect(isUnreachable({ ...base, hasCandidate: true })).toBe(false);
  });

  it('is false without a baseline (that is a "no baseline" case, not unreachable)', () => {
    expect(isUnreachable({ ...base, hasBaseline: false })).toBe(false);
  });

  it("is false when we reached the element's own page - nothing matched means gone", () => {
    // scannedOk wins over any wrong-page visits: we DID reach where the element lives.
    expect(isUnreachable({ ...base, scannedOk: true, wrongPage: true })).toBe(false);
  });

  it('is false with no positive evidence we could not reach (neither failed nor wrong)', () => {
    expect(isUnreachable({ ...base, scanFailed: false, wrongPage: false })).toBe(false);
  });
});

describe('samePage', () => {
  it('matches identical URLs, and ignores query + hash + trailing slash', () => {
    expect(samePage('https://app.com/dashboard', 'https://app.com/dashboard')).toBe(true);
    expect(samePage('https://app.com/dashboard?tab=1#x', 'https://app.com/dashboard')).toBe(true);
    expect(samePage('https://app.com/dashboard/', 'https://app.com/dashboard')).toBe(true);
  });

  it('rejects a different path (the login-redirect signal)', () => {
    expect(samePage('https://app.com/login', 'https://app.com/dashboard')).toBe(false);
    expect(
      samePage('https://app.com/auth/login?next=/dashboard', 'https://app.com/dashboard'),
    ).toBe(false);
  });

  it('rejects a different origin (host/port/scheme)', () => {
    expect(samePage('https://evil.com/dashboard', 'https://app.com/dashboard')).toBe(false);
    expect(samePage('http://app.com:3000/x', 'http://app.com:4000/x')).toBe(false);
  });

  it('treats blank or unparseable input as a match (never over-claims "wrong page")', () => {
    // Old baselines can lack a pageUrl; we must not flag those as unreachable.
    expect(samePage('https://app.com/x', '')).toBe(true);
    expect(samePage('', 'https://app.com/x')).toBe(true);
    expect(samePage('not-a-url', 'https://app.com/x')).toBe(true);
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
