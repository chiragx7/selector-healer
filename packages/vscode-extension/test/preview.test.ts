import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./__mocks__/vscode.js'));

const { spliceText } = await import('../src/preview.js');

describe('spliceText', () => {
  it('replaces the [start, end) slice with the replacement', () => {
    expect(spliceText('a(x)b', 1, 4, 'y')).toBe('ayb');
  });

  it('swaps a selector call within a line of source', () => {
    const line = "  await page.getByRole('button').click();";
    const call = "getByRole('button')";
    const start = line.indexOf(call);
    const out = spliceText(line, start, start + call.length, "getByTestId('save')");
    expect(out).toBe("  await page.getByTestId('save').click();");
  });

  it('inserts at a zero-width range', () => {
    expect(spliceText('abc', 3, 3, 'd')).toBe('abcd');
  });

  it('replaces the entire string', () => {
    expect(spliceText('old', 0, 3, 'new')).toBe('new');
  });
});
