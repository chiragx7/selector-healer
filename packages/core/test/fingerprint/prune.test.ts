import { describe, expect, it } from 'vitest';
import { pruneFingerprints } from '../../src/fingerprint/prune.js';
import type { DomFingerprint, SelectorUsage } from '../../src/types.js';

const ROOT = '/repo';

function fp(id: string, source?: DomFingerprint['source']): DomFingerprint {
  return {
    selectorId: id,
    capturedAt: '2026-01-01T00:00:00.000Z',
    tagName: 'input',
    attributes: {},
    textContent: '',
    parentChain: [],
    siblingIndex: 0,
    pageUrl: 'http://localhost/',
    ...(source ? { source } : {}),
  };
}

function sel(overrides: Partial<SelectorUsage> = {}): SelectorUsage {
  return {
    id: 'live1',
    filePath: '/repo/tests/login.spec.ts',
    line: 16,
    column: 11,
    selectorType: 'label',
    rawValue: 'Email',
    ...overrides,
  };
}

describe('pruneFingerprints', () => {
  it('keeps a live fingerprint whose id matches a current selector', () => {
    const store = new Map([['live1', fp('live1')]]);
    const { kept, removed } = pruneFingerprints(store, [sel({ id: 'live1' })], ROOT);
    expect(kept.has('live1')).toBe(true);
    expect(removed).toHaveLength(0);
  });

  it('removes an orphan whose id is gone and has no source', () => {
    const store = new Map([['gone', fp('gone')]]);
    const { kept, removed } = pruneFingerprints(store, [sel({ id: 'live1' })], ROOT);
    expect(kept.size).toBe(0);
    expect(removed.map((f) => f.selectorId)).toEqual(['gone']);
  });

  it('KEEPS a recovery orphan: different id, but its source call site still has a current selector', () => {
    // The renamed-selector case: a current selector sits at login.spec.ts:16:11,
    // and this orphan's source is the SAME call site — rename recovery needs it.
    const orphan = fp('old', { file: 'tests/login.spec.ts', line: 16, column: 11 });
    const store = new Map([['old', orphan]]);
    const { kept, removed } = pruneFingerprints(store, [sel({ id: 'live1' })], ROOT);
    expect(kept.has('old')).toBe(true);
    expect(removed).toHaveLength(0);
  });

  it('removes a stale orphan whose source call site no longer has any selector', () => {
    const orphan = fp('old', { file: 'tests/login.spec.ts', line: 99, column: 4 });
    const store = new Map([['old', orphan]]);
    const { kept, removed } = pruneFingerprints(store, [sel({ id: 'live1' })], ROOT);
    expect(kept.size).toBe(0);
    expect(removed.map((f) => f.selectorId)).toEqual(['old']);
  });

  it('removes everything when there are no current selectors', () => {
    const store = new Map([
      ['a', fp('a')],
      ['b', fp('b', { file: 'x.ts', line: 1, column: 1 })],
    ]);
    const { kept, removed } = pruneFingerprints(store, [], ROOT);
    expect(kept.size).toBe(0);
    expect(removed).toHaveLength(2);
  });

  it('handles an empty store', () => {
    const { kept, removed } = pruneFingerprints(new Map(), [sel()], ROOT);
    expect(kept.size).toBe(0);
    expect(removed).toHaveLength(0);
  });
});
