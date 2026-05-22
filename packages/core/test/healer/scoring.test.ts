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
    expect(result.confidence).toBeGreaterThanOrEqual(0.35);
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

  it('scores for text content match', () => {
    const stored = makeFp({ textContent: 'Submit' });
    const candidate = makeFp({
      attributes: {},
      textContent: 'Submit',
      parentChain: [],
    });
    const result = scoreCandidate(stored, candidate);
    expect(result.matchedRules).toContain('text content match');
  });

  it('matches partial text content', () => {
    const stored = makeFp({ textContent: 'Submit Form' });
    const candidate = makeFp({
      attributes: {},
      textContent: 'Submit',
      parentChain: [],
    });
    const result = scoreCandidate(stored, candidate);
    expect(result.matchedRules).toContain('text content match');
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

  it('scores for parent structure match', () => {
    const chain = [{ tagName: 'form', id: 'login', classes: ['auth'], role: 'form' }];
    const stored = makeFp({ parentChain: chain });
    const candidate = makeFp({
      parentChain: chain,
      attributes: {},
      textContent: '',
    });
    const result = scoreCandidate(stored, candidate);
    expect(result.matchedRules).toContain('parent structure match');
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

  it('reasoning lists matched rules', () => {
    const stored = makeFp();
    const candidate = makeFp();
    const result = scoreCandidate(stored, candidate);
    expect(result.reasoning).toContain('Matched:');
    expect(result.reasoning).toContain('%');
  });
});

describe('getScoringRules', () => {
  it('returns the rule table', () => {
    const rules = getScoringRules();
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.name).toBeTruthy();
      expect(rule.weight).toBeGreaterThan(0);
      expect(typeof rule.match).toBe('function');
    }
  });

  it('rule weights sum to 1.0', () => {
    const rules = getScoringRules();
    const sum = rules.reduce((acc, r) => acc + r.weight, 0);
    expect(sum).toBeCloseTo(1.0);
  });
});
