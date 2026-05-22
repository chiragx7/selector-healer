import { describe, expect, it } from 'vitest';
import { applyFixesToSource } from '../src/fix.js';
import type { FixEntry } from '../src/fix.js';

describe('applyFixesToSource', () => {
  it('replaces a CSS locator with getByTestId', () => {
    const source = `import { test } from '@playwright/test';

test('login', async ({ page }) => {
  await page.locator('#submit').click();
});
`;
    const fixes: FixEntry[] = [
      { line: 4, column: 24, rawValue: '#submit', replacementCode: "getByTestId('submit-btn')" },
    ];

    const result = applyFixesToSource(source, fixes);
    expect(result).toContain("getByTestId('submit-btn')");
    expect(result).not.toContain('#submit');
  });

  it('replaces a locator with getByRole', () => {
    const source = `test('nav', async ({ page }) => {
  await page.locator('button.primary').click();
});
`;
    const fixes: FixEntry[] = [
      {
        line: 2,
        column: 24,
        rawValue: 'button.primary',
        replacementCode: "getByRole('button', { name: 'Submit' })",
      },
    ];

    const result = applyFixesToSource(source, fixes);
    expect(result).toContain("getByRole('button', { name: 'Submit' })");
    expect(result).not.toContain('button.primary');
  });

  it('replaces a locator with getByText', () => {
    const source = `test('text', async ({ page }) => {
  await page.locator('.msg').textContent();
});
`;
    const fixes: FixEntry[] = [
      { line: 2, column: 24, rawValue: '.msg', replacementCode: "getByText('Hello')" },
    ];

    const result = applyFixesToSource(source, fixes);
    expect(result).toContain("getByText('Hello')");
  });

  it('handles multiple fixes in one file', () => {
    const source = `test('multi', async ({ page }) => {
  await page.locator('#email').fill('a@b.com');
  await page.locator('#submit').click();
});
`;
    const fixes: FixEntry[] = [
      { line: 2, column: 24, rawValue: '#email', replacementCode: "getByTestId('email-input')" },
      { line: 3, column: 24, rawValue: '#submit', replacementCode: "getByTestId('submit-btn')" },
    ];

    const result = applyFixesToSource(source, fixes);
    expect(result).toContain("getByTestId('email-input')");
    expect(result).toContain("getByTestId('submit-btn')");
    expect(result).not.toContain('#email');
    expect(result).not.toContain('#submit');
  });

  it('preserves formatting of untouched lines', () => {
    const source = `// Important comment
test('keep format', async ({ page }) => {
  const x = 42;
  await page.locator('#old').click();
  const y = 99;
});
`;
    const fixes: FixEntry[] = [
      { line: 4, column: 24, rawValue: '#old', replacementCode: "locator('#new')" },
    ];

    const result = applyFixesToSource(source, fixes);
    expect(result).toContain('// Important comment');
    expect(result).toContain('const x = 42');
    expect(result).toContain('const y = 99');
    expect(result).toContain("locator('#new')");
  });

  it('returns source unchanged when no fixes match', () => {
    const source = `test('noop', async ({ page }) => {
  await page.locator('#exists').click();
});
`;
    const fixes: FixEntry[] = [
      { line: 99, column: 1, rawValue: '#nonexistent', replacementCode: "locator('#x')" },
    ];

    const result = applyFixesToSource(source, fixes);
    expect(result).toContain('#exists');
  });

  it('returns source unchanged for empty fixes', () => {
    const source = 'const x = 1;\n';
    const result = applyFixesToSource(source, []);
    expect(result).toBe(source);
  });

  it('handles chained locator replacement', () => {
    const source = `test('chain', async ({ page }) => {
  await page.locator('.form').locator('#btn').click();
});
`;
    const fixes: FixEntry[] = [
      { line: 2, column: 38, rawValue: '#btn', replacementCode: "getByTestId('submit-btn')" },
    ];

    const result = applyFixesToSource(source, fixes);
    expect(result).toContain("getByTestId('submit-btn')");
    expect(result).toContain("locator('.form')");
  });
});
