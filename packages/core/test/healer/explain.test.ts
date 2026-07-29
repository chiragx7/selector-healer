import { describe, expect, it } from 'vitest';
import { explainBreak } from '../../src/healer/explain.js';
import type { DomFingerprint } from '../../src/types.js';

function fp(over: Partial<DomFingerprint> = {}): DomFingerprint {
  return {
    selectorId: 'x',
    capturedAt: '2026-01-01T00:00:00.000Z',
    tagName: 'button',
    attributes: {},
    textContent: '',
    parentChain: [{ tagName: 'form', classes: [] }],
    siblingIndex: 0,
    pageUrl: 'https://app.com',
    ...over,
  };
}

describe('explainBreak', () => {
  it('reports the element removed when no candidate is found', () => {
    const r = explainBreak(fp({ textContent: 'Save' }));
    expect(r).toHaveLength(1);
    expect(r[0]?.kind).toBe('removed');
  });

  it('detects a text change (renamed button)', () => {
    const r = explainBreak(
      fp({ textContent: 'Save changes' }),
      fp({ textContent: 'Update Profile' }),
    );
    const text = r.find((x) => x.kind === 'text');
    expect(text?.summary).toContain('Save changes');
    expect(text?.summary).toContain('Update Profile');
  });

  it('detects a removed data-testid', () => {
    const r = explainBreak(
      fp({ attributes: { 'data-testid': 'save-btn' } }),
      fp({ attributes: {} }),
    );
    const tid = r.find((x) => x.kind === 'testid');
    expect(tid?.summary).toContain('removed');
    expect(tid?.summary).toContain('save-btn');
  });

  it('detects a changed data-testid', () => {
    const r = explainBreak(
      fp({ attributes: { 'data-testid': 'old' } }),
      fp({ attributes: { 'data-testid': 'new' } }),
    );
    expect(r.find((x) => x.kind === 'testid')?.summary).toContain('changed');
  });

  it('detects a tag change', () => {
    const r = explainBreak(fp({ tagName: 'div' }), fp({ tagName: 'p' }));
    expect(r.find((x) => x.kind === 'tag')?.summary).toBe('tag changed from <div> to <p>');
  });

  it('detects a role change', () => {
    const r = explainBreak(
      fp({ attributes: { role: 'button' } }),
      fp({ attributes: { role: 'link' } }),
    );
    expect(r.find((x) => x.kind === 'role')).toBeDefined();
  });

  it('detects a move (changed ancestor chain)', () => {
    const r = explainBreak(
      fp({ parentChain: [{ tagName: 'form', classes: [] }] }),
      fp({ parentChain: [{ tagName: 'nav', classes: [] }] }),
    );
    expect(r.find((x) => x.kind === 'moved')).toBeDefined();
  });

  it('detects a sibling position shift when the ancestor chain is unchanged', () => {
    const r = explainBreak(fp({ siblingIndex: 0 }), fp({ siblingIndex: 2 }));
    expect(r.find((x) => x.kind === 'position')?.summary).toContain('0 → 2');
  });

  it('returns no reasons when nothing meaningful changed', () => {
    const same = fp({ textContent: 'Hello', attributes: { id: 'x' } });
    expect(explainBreak(same, { ...same })).toEqual([]);
  });

  it('reports multiple changes with the test-id first', () => {
    const r = explainBreak(
      fp({ tagName: 'button', textContent: 'Save', attributes: { 'data-testid': 'a' } }),
      fp({ tagName: 'a', textContent: 'Go', attributes: { 'data-testid': 'b' } }),
    );
    expect(r[0]?.kind).toBe('testid');
    expect(r.map((x) => x.kind)).toEqual(expect.arrayContaining(['testid', 'text', 'tag']));
  });

  it('normalizes whitespace before comparing text', () => {
    const r = explainBreak(
      fp({ textContent: 'Save  changes' }),
      fp({ textContent: 'Save changes' }),
    );
    expect(r.find((x) => x.kind === 'text')).toBeUndefined();
  });

  it('truncates very long text in the summary', () => {
    const long = 'x'.repeat(80);
    const r = explainBreak(fp({ textContent: 'short' }), fp({ textContent: long }));
    expect(r.find((x) => x.kind === 'text')?.summary).toContain('…');
  });
});
