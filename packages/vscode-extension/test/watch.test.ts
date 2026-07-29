import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Debouncer, isTestFilePath } from '../src/watch.js';

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
