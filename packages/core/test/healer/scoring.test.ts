import { describe, expect, it } from 'vitest';
import { getScoringRules, scoreCandidate } from '../../src/healer/scoring.js';
import type { DomFingerprint } from '../../src/types.js';

function makeFp(overrides: Partial<DomFingerprint> = {}): DomFingerprint {
  return {
    selectorId: 'abc123def456',
    capturedAt: '2026-01-01T00:00:00.000Z',
    tagName: 'button',
    attributes: {
      id: 'submit',
      class: 'btn primary',
      role: 'button',
      'data-testid': 'submit-btn',
      type: 'submit',
    },
    textContent: 'Submit',
    parentChain: [{ tagName: 'form', id: 'login', classes: ['auth-form'], role: 'form' }],
    siblingIndex: 0,
    pageUrl: 'https://app.com/login',
    ...overrides,
  };
}

describe('scoreCandidate', () => {
  it('returns 1.0 for identical fingerprints', () => {
    const stored = makeFp();
    const candidate = makeFp();
    const result = scoreCandidate(stored, candidate);
    expect(result.confidence).toBe(1);
    expect(result.matchedRules.length).toBeGreaterThan(0);
  });

  it('scores high for data-testid match', () => {
    const stored = makeFp();
    const candidate = makeFp({
      tagName: 'a',
      attributes: { 'data-testid': 'submit-btn' },
      textContent: 'Different',
      parentChain: [],
    });
    const result = scoreCandidate(stored, candidate);
    expect(result.confidence).toBeGreaterThanOrEqual(0.3);
    expect(result.matchedRules).toContain('data-testid match');
  });

  it('scores for id match', () => {
    const stored = makeFp();
    const candidate = makeFp({
      attributes: { id: 'submit' },
      textContent: '',
      parentChain: [],
    });
    const result = scoreCandidate(stored, candidate);
    expect(result.matchedRules).toContain('id attribute match');
  });

  it('scores for role match', () => {
    const stored = makeFp();
    const candidate = makeFp({
      attributes: { role: 'button' },
      textContent: '',
      parentChain: [],
    });
    const result = scoreCandidate(stored, candidate);
    expect(result.matchedRules).toContain('role match');
  });

  it('scores for exact text match', () => {
    const stored = makeFp({ textContent: 'Submit' });
    const candidate = makeFp({
      attributes: {},
      textContent: 'Submit',
      parentChain: [],
    });
    const result = scoreCandidate(stored, candidate);
    expect(result.matchedRules).toContain('text similarity');
  });

  it('scores for partial text (substring)', () => {
    const stored = makeFp({ textContent: 'Submit Form' });
    const candidate = makeFp({
      attributes: {},
      textContent: 'Submit',
      parentChain: [],
    });
    const result = scoreCandidate(stored, candidate);
    expect(result.matchedRules).toContain('text similarity');
    // Substring match scores at 0.8 quality, lower than exact match
    const textRule = result.ruleScores.find((r) => r.name === 'text similarity');
    expect(textRule?.quality).toBe(0.8);
  });

  it('scores for fuzzy text (Levenshtein)', () => {
    const stored = makeFp({ textContent: 'Submit Order' });
    const candidate = makeFp({
      attributes: {},
      textContent: 'Sbmit Order',
      parentChain: [],
    });
    const result = scoreCandidate(stored, candidate);
    expect(result.matchedRules).toContain('text similarity');
    const textRule = result.ruleScores.find((r) => r.name === 'text similarity');
    // One typo — quality should be high but below 0.8
    expect(textRule?.quality).toBeGreaterThan(0.5);
    expect(textRule?.quality).toBeLessThan(1);
  });

  it('ignores text below similarity threshold', () => {
    const stored = makeFp({ textContent: 'Submit' });
    const candidate = makeFp({
      attributes: {},
      textContent: 'Completely different text',
      parentChain: [],
    });
    const result = scoreCandidate(stored, candidate);
    const textRule = result.ruleScores.find((r) => r.name === 'text similarity');
    expect(textRule?.quality).toBe(0);
  });

  it('scores for tag name match', () => {
    const stored = makeFp({ tagName: 'button' });
    const candidate = makeFp({
      tagName: 'button',
      attributes: {},
      textContent: '',
      parentChain: [],
    });
    const result = scoreCandidate(stored, candidate);
    expect(result.matchedRules).toContain('tag name match');
  });

  it('scores for sibling index match', () => {
    const stored = makeFp({ siblingIndex: 2 });
    const candidate = makeFp({
      siblingIndex: 2,
      attributes: {},
      textContent: '',
      parentChain: [],
    });
    const result = scoreCandidate(stored, candidate);
    expect(result.matchedRules).toContain('sibling position match');
  });

  it('gives partial credit for nearby sibling index', () => {
    const stored = makeFp({ siblingIndex: 2 });
    const candidate = makeFp({
      siblingIndex: 3,
      attributes: {},
      textContent: '',
      parentChain: [],
    });
    const result = scoreCandidate(stored, candidate);
    const siblingRule = result.ruleScores.find((r) => r.name === 'sibling position match');
    expect(siblingRule?.quality).toBe(0.5);
  });

  it('scores for parent structure match', () => {
    const chain = [{ tagName: 'form', id: 'login', classes: ['auth'], role: 'form' }];
    const stored = makeFp({ parentChain: chain });
    const candidate = makeFp({
      parentChain: chain,
      attributes: {},
      textContent: '',
    });
    const result = scoreCandidate(stored, candidate);
    expect(result.matchedRules).toContain('parent chain similarity');
  });

  it('scores for deep parent chain similarity', () => {
    const storedChain = [
      { tagName: 'main', id: 'app', classes: [], role: 'main' },
      { tagName: 'div', classes: ['content'] },
      { tagName: 'form', id: 'login', classes: ['auth-form'], role: 'form' },
    ];
    const candidateChain = [
      { tagName: 'main', id: 'app', classes: [], role: 'main' },
      { tagName: 'div', classes: ['wrapper'] },
      { tagName: 'form', id: 'login', classes: ['auth-form'], role: 'form' },
    ];
    const stored = makeFp({ parentChain: storedChain });
    const candidate = makeFp({ parentChain: candidateChain, attributes: {}, textContent: '' });
    const result = scoreCandidate(stored, candidate);
    const parentRule = result.ruleScores.find((r) => r.name === 'parent chain similarity');
    // Leaf matches well, middle differs slightly, root matches
    expect(parentRule?.quality).toBeGreaterThan(0.5);
  });

  it('scores for class overlap', () => {
    const stored = makeFp({ attributes: { class: 'btn primary large' } });
    const candidate = makeFp({
      tagName: 'span',
      attributes: { class: 'btn primary new-class' },
      textContent: '',
      parentChain: [],
    });
    const result = scoreCandidate(stored, candidate);
    expect(result.matchedRules).toContain('class overlap');
    const classRule = result.ruleScores.find((r) => r.name === 'class overlap');
    // Jaccard: {btn, primary} ∩ {btn, primary, large, new-class} = 2/4 = 0.5
    expect(classRule?.quality).toBe(0.5);
  });

  it('scores for aria/accessibility match', () => {
    const stored = makeFp({
      attributes: { 'aria-label': 'Close dialog', placeholder: 'Search...' },
    });
    const candidate = makeFp({
      attributes: { 'aria-label': 'Close dialog', placeholder: 'Search...' },
      textContent: '',
      parentChain: [],
    });
    const result = scoreCandidate(stored, candidate);
    expect(result.matchedRules).toContain('aria/accessibility match');
    const ariaRule = result.ruleScores.find((r) => r.name === 'aria/accessibility match');
    expect(ariaRule?.quality).toBe(1);
  });

  it('scores for attribute coverage', () => {
    const stored = makeFp({
      attributes: { type: 'submit', name: 'btn', 'data-action': 'login' },
    });
    const candidate = makeFp({
      attributes: { type: 'submit', name: 'btn' },
      textContent: '',
      parentChain: [],
    });
    const result = scoreCandidate(stored, candidate);
    expect(result.matchedRules).toContain('attribute coverage');
    const attrRule = result.ruleScores.find((r) => r.name === 'attribute coverage');
    // 2 of 3 semantic attrs match
    expect(attrRule?.quality).toBeCloseTo(2 / 3, 1);
  });

  it('returns 0 for completely different element', () => {
    const stored = makeFp();
    const candidate = makeFp({
      tagName: 'span',
      attributes: {},
      textContent: '',
      parentChain: [{ tagName: 'div', classes: [] }],
      siblingIndex: 5,
    });
    const result = scoreCandidate(stored, candidate);
    expect(result.confidence).toBe(0);
    expect(result.matchedRules).toHaveLength(0);
    expect(result.reasoning).toBe('No scoring rules matched');
  });

  it('confidence is clamped to [0, 1]', () => {
    const stored = makeFp();
    const candidate = makeFp();
    const result = scoreCandidate(stored, candidate);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('reasoning lists matched rules with scores', () => {
    const stored = makeFp();
    const candidate = makeFp();
    const result = scoreCandidate(stored, candidate);
    expect(result.reasoning).toContain('Matched:');
    expect(result.reasoning).toContain('confidence');
  });

  it('ruleScores has an entry for every rule', () => {
    const stored = makeFp();
    const candidate = makeFp();
    const result = scoreCandidate(stored, candidate);
    const rules = getScoringRules();
    expect(result.ruleScores).toHaveLength(rules.length);
    for (const rs of result.ruleScores) {
      expect(rs.quality).toBeGreaterThanOrEqual(0);
      expect(rs.quality).toBeLessThanOrEqual(1);
      expect(rs.weighted).toBeGreaterThanOrEqual(0);
    }
  });

  it('scores a no-testid/id/role element high when structure matches', () => {
    // A plain <button> identified only by tag, text, class, and structure —
    // no data-testid, id, or explicit role attribute. The presence-gated rules
    // must count as "not applicable" (not 0-penalties), so a near-perfect match
    // clears the 0.8 auto-apply threshold instead of being dragged down to ~38%.
    const base: Partial<DomFingerprint> = {
      tagName: 'button',
      attributes: { class: 'oxd-button oxd-button--main', type: 'submit' },
      textContent: 'Login',
      parentChain: [{ tagName: 'form', classes: ['oxd-form'] }],
      siblingIndex: 0,
    };
    const result = scoreCandidate(makeFp(base), makeFp(base));
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    // The absent identifiers are not in the matched-rules list.
    expect(result.matchedRules).not.toContain('data-testid match');
    expect(result.matchedRules).not.toContain('id attribute match');
    expect(result.matchedRules).not.toContain('role match');
  });
});

describe('getScoringRules', () => {
  it('returns the rule table', () => {
    const rules = getScoringRules();
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.name).toBeTruthy();
      expect(rule.weight).toBeGreaterThan(0);
      expect(typeof rule.score).toBe('function');
    }
  });

  it('rule weights sum to 1.0', () => {
    const rules = getScoringRules();
    const sum = rules.reduce((acc, r) => acc + r.weight, 0);
    expect(sum).toBeCloseTo(1.0);
  });
});
