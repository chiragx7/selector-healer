import { describe, expect, it } from 'vitest';
import type { DomFingerprint } from '../../src/types.js';
import { compareFingerprints } from '../../src/verifier/compare.js';

function makeFp(overrides: Partial<DomFingerprint> = {}): DomFingerprint {
  return {
    selectorId: 'abc123def456',
    capturedAt: '2026-01-01T00:00:00.000Z',
    tagName: 'button',
    attributes: { id: 'submit', class: 'btn primary', role: 'button', 'data-testid': 'submit-btn' },
    textContent: 'Submit',
    parentChain: [
      { tagName: 'div', id: 'root', classes: ['app'], role: 'main' },
      { tagName: 'form', id: 'login', classes: ['auth-form'], role: 'form' },
    ],
    siblingIndex: 0,
    pageUrl: 'https://app.com/login',
    ...overrides,
  };
}

describe('compareFingerprints', () => {
  it('returns identical=true for matching fingerprints', () => {
    const a = makeFp();
    const b = makeFp();
    const result = compareFingerprints(a, b);
    expect(result.identical).toBe(true);
    expect(result.similarity).toBe(1);
  });

  it('detects tagName mismatch', () => {
    const stored = makeFp();
    const live = makeFp({ tagName: 'a' });
    const result = compareFingerprints(stored, live);
    expect(result.identical).toBe(false);
    const tagDetail = result.details.find((d) => d.field === 'tagName');
    expect(tagDetail?.match).toBe(false);
  });

  it('detects id change', () => {
    const stored = makeFp();
    const live = makeFp({ attributes: { ...makeFp().attributes, id: 'different' } });
    const result = compareFingerprints(stored, live);
    expect(result.identical).toBe(false);
    const idDetail = result.details.find((d) => d.field === 'id');
    expect(idDetail?.match).toBe(false);
  });

  it('detects class divergence beyond threshold', () => {
    const stored = makeFp({ attributes: { class: 'btn primary large' } });
    const live = makeFp({ attributes: { class: 'link secondary small' } });
    const result = compareFingerprints(stored, live);
    const classDetail = result.details.find((d) => d.field === 'classes');
    expect(classDetail?.match).toBe(false);
  });

  it('accepts minor class changes', () => {
    const stored = makeFp({ attributes: { class: 'btn primary large active' } });
    const live = makeFp({ attributes: { class: 'btn primary large' } });
    const result = compareFingerprints(stored, live);
    const classDetail = result.details.find((d) => d.field === 'classes');
    expect(classDetail?.match).toBe(true);
  });

  it('detects testid change', () => {
    const stored = makeFp();
    const live = makeFp({
      attributes: { ...makeFp().attributes, 'data-testid': 'different' },
    });
    const result = compareFingerprints(stored, live);
    const testidDetail = result.details.find((d) => d.field === 'testid');
    expect(testidDetail?.match).toBe(false);
  });

  it('detects text content change', () => {
    const stored = makeFp();
    const live = makeFp({ textContent: 'Cancel' });
    const result = compareFingerprints(stored, live);
    const textDetail = result.details.find((d) => d.field === 'textContent');
    expect(textDetail?.match).toBe(false);
  });

  it('matches partial text content', () => {
    const stored = makeFp({ textContent: 'Submit Form' });
    const live = makeFp({ textContent: 'Submit' });
    const result = compareFingerprints(stored, live);
    const textDetail = result.details.find((d) => d.field === 'textContent');
    expect(textDetail?.match).toBe(true);
  });

  it('detects parent chain divergence', () => {
    const stored = makeFp();
    const live = makeFp({
      parentChain: [{ tagName: 'section', classes: ['other'] }],
    });
    const result = compareFingerprints(stored, live);
    const parentDetail = result.details.find((d) => d.field === 'parentChain');
    expect(parentDetail?.match).toBe(false);
  });

  it('detects sibling index change', () => {
    const stored = makeFp({ siblingIndex: 0 });
    const live = makeFp({ siblingIndex: 3 });
    const result = compareFingerprints(stored, live);
    const siblingDetail = result.details.find((d) => d.field === 'siblingIndex');
    expect(siblingDetail?.match).toBe(false);
  });

  it('similarity is between 0 and 1', () => {
    const stored = makeFp();
    const live = makeFp({
      tagName: 'a',
      textContent: 'Different',
      attributes: {},
      parentChain: [],
      siblingIndex: 5,
    });
    const result = compareFingerprints(stored, live);
    expect(result.similarity).toBeGreaterThanOrEqual(0);
    expect(result.similarity).toBeLessThanOrEqual(1);
  });

  it('handles empty attributes gracefully', () => {
    const stored = makeFp({ attributes: {} });
    const live = makeFp({ attributes: {} });
    const result = compareFingerprints(stored, live);
    const classDetail = result.details.find((d) => d.field === 'classes');
    expect(classDetail?.match).toBe(true);
  });

  it('handles empty parent chains', () => {
    const stored = makeFp({ parentChain: [] });
    const live = makeFp({ parentChain: [] });
    const result = compareFingerprints(stored, live);
    const parentDetail = result.details.find((d) => d.field === 'parentChain');
    expect(parentDetail?.match).toBe(true);
  });
});
