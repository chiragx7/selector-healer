import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDirectory } from '../../src/parser/index.js';

describe('parseDirectory', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `sh-dir-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(join(tmpDir, 'tests'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('scans matching test files and extracts selectors', () => {
    writeFileSync(
      join(tmpDir, 'tests', 'login.spec.ts'),
      `test('login', async ({ page }) => { await page.locator('#submit').click(); });`,
    );
    writeFileSync(
      join(tmpDir, 'tests', 'signup.test.ts'),
      `test('signup', async ({ page }) => { await page.getByTestId('register').click(); });`,
    );

    const result = parseDirectory(tmpDir, 'tests/**/*.{spec,test}.ts');
    expect(result.isOk()).toBe(true);
    const { selectors, errors } = result._unsafeUnwrap();
    expect(selectors).toHaveLength(2);
    expect(errors).toHaveLength(0);
  });

  it('ignores files that do not match the glob', () => {
    writeFileSync(
      join(tmpDir, 'tests', 'login.spec.ts'),
      `test('t', async ({ page }) => { await page.locator('#a').click(); });`,
    );
    writeFileSync(
      join(tmpDir, 'tests', 'helpers.ts'),
      `export function helper() { return page.locator('#never'); }`,
    );

    const result = parseDirectory(tmpDir, 'tests/**/*.spec.ts');
    const { selectors } = result._unsafeUnwrap();
    expect(selectors).toHaveLength(1);
  });

  it('collects per-file errors alongside successes', () => {
    writeFileSync(
      join(tmpDir, 'tests', 'good.spec.ts'),
      `test('ok', async ({ page }) => { await page.locator('#ok').click(); });`,
    );
    writeFileSync(join(tmpDir, 'tests', 'bad.spec.ts'), 'this is {{{{ invalid');

    const result = parseDirectory(tmpDir, 'tests/**/*.spec.ts');
    const { selectors, errors } = result._unsafeUnwrap();
    expect(selectors).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe('parse-error');
  });

  it('returns empty when no files match', () => {
    const result = parseDirectory(tmpDir, 'tests/**/*.spec.ts');
    const { selectors, errors } = result._unsafeUnwrap();
    expect(selectors).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it('uses the default glob when none is provided', () => {
    writeFileSync(
      join(tmpDir, 'tests', 'login.spec.ts'),
      `test('t', async ({ page }) => { await page.locator('#a').click(); });`,
    );
    writeFileSync(
      join(tmpDir, 'tests', 'signup.test.ts'),
      `test('t', async ({ page }) => { await page.locator('#b').click(); });`,
    );

    const result = parseDirectory(tmpDir);
    const { selectors } = result._unsafeUnwrap();
    expect(selectors).toHaveLength(2);
  });
});
