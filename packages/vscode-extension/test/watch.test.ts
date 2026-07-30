import type { SelectorUsage } from '@selector-healer/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Debouncer,
  isTestFilePath,
  selectorSignature,
  selectorsChangedSince,
} from '../src/watch.js';

function sel(overrides: Partial<SelectorUsage> = {}): SelectorUsage {
  return {
    id: 'aaaaaaaaaaaa',
    filePath: '/app/tests/login.spec.ts',
    line: 30,
    column: 11,
    selectorType: 'role',
    rawValue: 'link',
    options: { name: 'Sign up' },
    ...overrides,
  };
}

describe('isTestFilePath', () => {
  it('accepts a TS test file inside the test dir', () => {
    expect(isTestFilePath('C:/app/tests/login.spec.ts', 'C:/app/tests')).toBe(true);
  });

  it('accepts nested files and is separator/case-insensitive', () => {
    expect(isTestFilePath('C:\\app\\Tests\\auth\\login.spec.ts', 'c:/app/tests')).toBe(true);
  });

  it('rejects files outside the test dir', () => {
    expect(isTestFilePath('C:/app/src/foo.ts', 'C:/app/tests')).toBe(false);
  });

  it('rejects non-JS/TS files', () => {
    expect(isTestFilePath('C:/app/tests/data.json', 'C:/app/tests')).toBe(false);
  });

  it('does not treat a sibling dir sharing the prefix as inside', () => {
    expect(isTestFilePath('C:/app/tests-extra/foo.ts', 'C:/app/tests')).toBe(false);
  });
});

describe('selectorSignature', () => {
  it('differs when a getByRole name option changes (same id and rawValue)', () => {
    // The bug this guards: id = hash(file:line:'link') is identical for both, so
    // comparing ids alone would miss the edit.
    const before = sel({ options: { name: 'Sign up' } });
    const after = sel({ options: { name: 'Sign down' } });
    expect(before.id).toBe(after.id); // proves the id can't tell them apart
    expect(selectorSignature(before)).not.toBe(selectorSignature(after));
  });

  it('is stable for an identical selector', () => {
    expect(selectorSignature(sel())).toBe(selectorSignature(sel()));
  });

  it('differs when the selectorType changes but rawValue does not', () => {
    const a = sel({ selectorType: 'text', options: undefined, rawValue: '.foo' });
    const b = sel({ selectorType: 'css', options: undefined, rawValue: '.foo' });
    expect(selectorSignature(a)).not.toBe(selectorSignature(b));
  });
});

describe('selectorsChangedSince', () => {
  it('flags a getByRole selector whose only edit is the name option', () => {
    const prior = [sel({ options: { name: 'Sign up' } })];
    const current = [sel({ options: { name: 'Sign down' } })];
    const changed = selectorsChangedSince(prior, current);
    expect(changed).toHaveLength(1);
    expect(changed[0]?.options).toEqual({ name: 'Sign down' });
  });

  it('returns nothing when a selector is untouched', () => {
    expect(selectorsChangedSince([sel()], [sel()])).toHaveLength(0);
  });

  it('flags a brand-new selector at a line not seen before', () => {
    const current = [sel(), sel({ id: 'bbbbbbbbbbbb', line: 42, rawValue: 'button' })];
    const changed = selectorsChangedSince([sel()], current);
    expect(changed.map((c) => c.line)).toEqual([42]);
  });

  it('flags a rawValue rename (id changes) too', () => {
    const prior = [sel({ selectorType: 'label', rawValue: 'Email', options: undefined })];
    const current = [
      sel({ id: 'cccccccccccc', selectorType: 'label', rawValue: 'Nope', options: undefined }),
    ];
    expect(selectorsChangedSince(prior, current)).toHaveLength(1);
  });

  it('only re-checks the edited selector among several on different lines', () => {
    const prior = [
      sel({ id: 's1', line: 10, options: { name: 'Sign up' } }),
      sel({ id: 's2', line: 20, options: { name: 'Log in' } }),
    ];
    const current = [
      sel({ id: 's1', line: 10, options: { name: 'Sign up' } }),
      sel({ id: 's2', line: 20, options: { name: 'Log out' } }), // edited
    ];
    const changed = selectorsChangedSince(prior, current);
    expect(changed).toHaveLength(1);
    expect(changed[0]?.line).toBe(20);
  });
});

describe('Debouncer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs once after the delay, collapsing a burst of calls', () => {
    const fn = vi.fn();
    const d = new Debouncer(700);
    d.schedule(fn);
    d.schedule(fn);
    d.schedule(fn);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(699);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('resets the delay on each call (trailing edge)', () => {
    const fn = vi.fn();
    const d = new Debouncer(700);
    d.schedule(fn);
    vi.advanceTimersByTime(500);
    d.schedule(fn); // resets the 700ms window
    vi.advanceTimersByTime(500);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('cancel prevents a pending run', () => {
    const fn = vi.fn();
    const d = new Debouncer(700);
    d.schedule(fn);
    d.cancel();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });
});
