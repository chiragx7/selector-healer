import { describe, expect, it } from 'vitest';
import { findOrphanBaseline, toSourceFile } from '../../src/fingerprint/source-match.js';
import type { DomFingerprint, SelectorUsage } from '../../src/types.js';

const ROOT = '/repo';

function fp(overrides: Partial<DomFingerprint> = {}): DomFingerprint {
  return {
    selectorId: 'aaaaaaaaaaaa',
    capturedAt: '2026-01-01T00:00:00.000Z',
    tagName: 'input',
    attributes: { id: 'email' },
    textContent: '',
    parentChain: [],
    siblingIndex: 0,
    pageUrl: 'http://localhost/login',
    source: { file: 'tests/login.spec.ts', line: 16, column: 10 },
    ...overrides,
  };
}

function sel(overrides: Partial<SelectorUsage> = {}): SelectorUsage {
  return {
    id: 'bbbbbbbbbbbb',
    filePath: '/repo/tests/login.spec.ts',
    line: 16,
    column: 10,
    selectorType: 'label',
    rawValue: 'Nope',
    ...overrides,
  };
}

describe('toSourceFile', () => {
  it('relativises an absolute path with forward slashes', () => {
    expect(toSourceFile('/repo', '/repo/tests/login.spec.ts')).toBe('tests/login.spec.ts');
  });

  it('normalises Windows separators to posix', () => {
    // relative() on posix hosts keeps backslashes literal; the split covers both.
    expect(toSourceFile('/repo', '/repo/a\\b\\c.ts')).toBe('a/b/c.ts');
  });
});

describe('findOrphanBaseline', () => {
  it('recovers the baseline at the same file:line under a different id', () => {
    const store = new Map<string, DomFingerprint>([['aaaaaaaaaaaa', fp()]]);
    const found = findOrphanBaseline(store, sel(), ROOT);
    expect(found?.selectorId).toBe('aaaaaaaaaaaa');
    expect(found?.attributes.id).toBe('email');
  });

  it('ignores a fingerprint with the same id (that would be a direct hit)', () => {
    const store = new Map<string, DomFingerprint>([
      ['bbbbbbbbbbbb', fp({ selectorId: 'bbbbbbbbbbbb' })],
    ]);
    expect(findOrphanBaseline(store, sel(), ROOT)).toBeUndefined();
  });

  it('does not match when the line differs', () => {
    const store = new Map<string, DomFingerprint>([
      ['aaaaaaaaaaaa', fp({ source: { file: 'tests/login.spec.ts', line: 99, column: 10 } })],
    ]);
    expect(findOrphanBaseline(store, sel(), ROOT)).toBeUndefined();
  });

  it('does not match when the column differs (distinct selector on the same line)', () => {
    const store = new Map<string, DomFingerprint>([
      ['aaaaaaaaaaaa', fp({ source: { file: 'tests/login.spec.ts', line: 16, column: 42 } })],
    ]);
    expect(findOrphanBaseline(store, sel(), ROOT)).toBeUndefined();
  });

  it('does not match when the file differs', () => {
    const store = new Map<string, DomFingerprint>([
      ['aaaaaaaaaaaa', fp({ source: { file: 'tests/other.spec.ts', line: 16, column: 10 } })],
    ]);
    expect(findOrphanBaseline(store, sel(), ROOT)).toBeUndefined();
  });

  it('ignores legacy fingerprints with no source (never recoverable until re-captured)', () => {
    const legacy: DomFingerprint = {
      selectorId: 'aaaaaaaaaaaa',
      capturedAt: '2026-01-01T00:00:00.000Z',
      tagName: 'input',
      attributes: { id: 'email' },
      textContent: '',
      parentChain: [],
      siblingIndex: 0,
      pageUrl: 'http://localhost/login',
      // no `source` — a baseline captured before this feature landed
    };
    const store = new Map<string, DomFingerprint>([['aaaaaaaaaaaa', legacy]]);
    expect(findOrphanBaseline(store, sel(), ROOT)).toBeUndefined();
  });

  it('returns undefined on an empty store', () => {
    expect(findOrphanBaseline(new Map(), sel(), ROOT)).toBeUndefined();
  });
});
