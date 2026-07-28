import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseTestFile } from '../../src/parser/index.js';

function writeTempFile(dir: string, content: string, name = 'test.spec.ts'): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

describe('parseTestFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `sh-parse-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('CSS selectors', () => {
    it('extracts page.locator with ID selector', () => {
      const fp = writeTempFile(
        tmpDir,
        `
        import { test } from '@playwright/test';
        test('my test', async ({ page }) => {
          await page.locator('#submit').click();
        });
      `,
      );
      const usages = parseTestFile(fp)._unsafeUnwrap();
      expect(usages).toHaveLength(1);
      expect(usages[0]).toMatchObject({
        selectorType: 'css',
        rawValue: '#submit',
      });
    });

    it('extracts page.locator with class selector', () => {
      const fp = writeTempFile(
        tmpDir,
        `
        test('test', async ({ page }) => {
          await page.locator('.btn-primary').click();
        });
      `,
      );
      const usages = parseTestFile(fp)._unsafeUnwrap();
      expect(usages).toHaveLength(1);
      expect(usages[0]).toMatchObject({ selectorType: 'css', rawValue: '.btn-primary' });
    });
  });

  describe('XPath selectors', () => {
    it('detects XPath in page.locator', () => {
      const fp = writeTempFile(
        tmpDir,
        `
        test('test', async ({ page }) => {
          await page.locator('//div[@class="container"]').click();
        });
      `,
      );
      const usages = parseTestFile(fp)._unsafeUnwrap();
      expect(usages).toHaveLength(1);
      expect(usages[0]).toMatchObject({
        selectorType: 'xpath',
        rawValue: '//div[@class="container"]',
      });
    });
  });

  describe('getBy* methods', () => {
    it('extracts getByTestId', () => {
      const fp = writeTempFile(
        tmpDir,
        `
        test('test', async ({ page }) => {
          await page.getByTestId('submit-btn').click();
        });
      `,
      );
      const usages = parseTestFile(fp)._unsafeUnwrap();
      expect(usages).toHaveLength(1);
      expect(usages[0]).toMatchObject({ selectorType: 'testid', rawValue: 'submit-btn' });
    });

    it('extracts getByRole with options', () => {
      const fp = writeTempFile(
        tmpDir,
        `
        test('test', async ({ page }) => {
          await page.getByRole('button', { name: 'Submit' }).click();
        });
      `,
      );
      const usages = parseTestFile(fp)._unsafeUnwrap();
      expect(usages).toHaveLength(1);
      expect(usages[0]).toMatchObject({
        selectorType: 'role',
        rawValue: 'button',
        options: { name: 'Submit' },
      });
    });

    it('extracts getByText', () => {
      const fp = writeTempFile(
        tmpDir,
        `
        test('test', async ({ page }) => {
          await page.getByText('Welcome back').click();
        });
      `,
      );
      const usages = parseTestFile(fp)._unsafeUnwrap();
      expect(usages[0]).toMatchObject({ selectorType: 'text', rawValue: 'Welcome back' });
    });

    it('extracts getByLabel', () => {
      const fp = writeTempFile(
        tmpDir,
        `
        test('test', async ({ page }) => {
          await page.getByLabel('Email address').fill('a@b.com');
        });
      `,
      );
      const usages = parseTestFile(fp)._unsafeUnwrap();
      expect(usages[0]).toMatchObject({ selectorType: 'label', rawValue: 'Email address' });
    });

    it('extracts getByPlaceholder', () => {
      const fp = writeTempFile(
        tmpDir,
        `
        test('test', async ({ page }) => {
          await page.getByPlaceholder('Enter email').fill('a@b.com');
        });
      `,
      );
      const usages = parseTestFile(fp)._unsafeUnwrap();
      expect(usages[0]).toMatchObject({ selectorType: 'placeholder', rawValue: 'Enter email' });
    });

    it('extracts getByTitle', () => {
      const fp = writeTempFile(
        tmpDir,
        `
        test('test', async ({ page }) => {
          await page.getByTitle('Help').click();
        });
      `,
      );
      const usages = parseTestFile(fp)._unsafeUnwrap();
      expect(usages[0]).toMatchObject({ selectorType: 'title', rawValue: 'Help' });
    });

    it('extracts getByAltText', () => {
      const fp = writeTempFile(
        tmpDir,
        `
        test('test', async ({ page }) => {
          await page.getByAltText('Company Logo').click();
        });
      `,
      );
      const usages = parseTestFile(fp)._unsafeUnwrap();
      expect(usages[0]).toMatchObject({ selectorType: 'alt', rawValue: 'Company Logo' });
    });
  });

  describe('legacy selectors', () => {
    it('extracts page.$', () => {
      const fp = writeTempFile(
        tmpDir,
        `
        test('test', async ({ page }) => {
          const el = await page.$('#legacy');
        });
      `,
      );
      const usages = parseTestFile(fp)._unsafeUnwrap();
      expect(usages).toHaveLength(1);
      expect(usages[0]).toMatchObject({ selectorType: 'css', rawValue: '#legacy' });
    });

    it('extracts page.$$', () => {
      const fp = writeTempFile(
        tmpDir,
        `
        test('test', async ({ page }) => {
          const els = await page.$$('.items');
        });
      `,
      );
      const usages = parseTestFile(fp)._unsafeUnwrap();
      expect(usages).toHaveLength(1);
      expect(usages[0]).toMatchObject({ selectorType: 'css', rawValue: '.items' });
    });

    it('detects XPath in page.$', () => {
      const fp = writeTempFile(
        tmpDir,
        `
        test('test', async ({ page }) => {
          const el = await page.$('//button');
        });
      `,
      );
      const usages = parseTestFile(fp)._unsafeUnwrap();
      expect(usages[0]).toMatchObject({ selectorType: 'xpath', rawValue: '//button' });
    });
  });

  describe('chained locators', () => {
    it('extracts both selectors from a chain', () => {
      const fp = writeTempFile(
        tmpDir,
        `
        test('test', async ({ page }) => {
          await page.locator('.form').locator('#submit').click();
        });
      `,
      );
      const usages = parseTestFile(fp)._unsafeUnwrap();
      expect(usages).toHaveLength(2);
      expect(usages[0].rawValue).toBe('.form');
      expect(usages[1].rawValue).toBe('#submit');
    });
  });

  describe('expect wrappers', () => {
    it('extracts selectors inside expect()', () => {
      const fp = writeTempFile(
        tmpDir,
        `
        import { expect, test } from '@playwright/test';
        test('test', async ({ page }) => {
          await expect(page.locator('#submit')).toBeVisible();
        });
      `,
      );
      const usages = parseTestFile(fp)._unsafeUnwrap();
      expect(usages).toHaveLength(1);
      expect(usages[0].rawValue).toBe('#submit');
    });
  });

  describe('context hints', () => {
    it('captures page.goto URL as contextHint', () => {
      const fp = writeTempFile(
        tmpDir,
        `
        test('login', async ({ page }) => {
          await page.goto('https://app.com/login');
          await page.locator('#submit').click();
        });
      `,
      );
      const usages = parseTestFile(fp)._unsafeUnwrap();
      expect(usages).toHaveLength(1);
      expect(usages[0].contextHint).toBe('https://app.com/login');
    });

    it('updates contextHint on subsequent page.goto', () => {
      const fp = writeTempFile(
        tmpDir,
        `
        test('multi-page', async ({ page }) => {
          await page.goto('/login');
          await page.locator('#email').fill('a@b.com');
          await page.goto('/dashboard');
          await page.locator('#greeting').isVisible();
        });
      `,
      );
      const usages = parseTestFile(fp)._unsafeUnwrap();
      expect(usages).toHaveLength(2);
      expect(usages[0].contextHint).toBe('/login');
      expect(usages[1].contextHint).toBe('/dashboard');
    });

    it('scopes contextHint per function', () => {
      const fp = writeTempFile(
        tmpDir,
        `
        test('test one', async ({ page }) => {
          await page.goto('/login');
          await page.locator('#submit').click();
        });
        test('test two', async ({ page }) => {
          await page.locator('#other').click();
        });
      `,
      );
      const usages = parseTestFile(fp)._unsafeUnwrap();
      expect(usages).toHaveLength(2);
      expect(usages[0].contextHint).toBe('/login');
      expect(usages[1].contextHint).toBeUndefined();
    });

    it('propagates a beforeEach goto to the tests in the block', () => {
      const fp = writeTempFile(
        tmpDir,
        `
        test.describe('dashboard', () => {
          test.beforeEach(async ({ page }) => {
            await page.goto('/dashboard');
          });
          test('shows greeting', async ({ page }) => {
            await page.getByTestId('greeting').isVisible();
          });
          test('shows avatar', async ({ page }) => {
            await page.locator('.avatar').isVisible();
          });
        });
      `,
      );
      const usages = parseTestFile(fp)._unsafeUnwrap();
      expect(usages).toHaveLength(2);
      expect(usages[0].contextHint).toBe('/dashboard');
      expect(usages[1].contextHint).toBe('/dashboard');
    });

    it('lets a test-local goto override the inherited beforeEach hint', () => {
      const fp = writeTempFile(
        tmpDir,
        `
        test.beforeEach(async ({ page }) => {
          await page.goto('/dashboard');
        });
        test('navigates away', async ({ page }) => {
          await page.getByTestId('greeting').isVisible();
          await page.goto('/settings');
          await page.locator('.panel').isVisible();
        });
      `,
      );
      const usages = parseTestFile(fp)._unsafeUnwrap();
      expect(usages).toHaveLength(2);
      expect(usages[0].contextHint).toBe('/dashboard');
      expect(usages[1].contextHint).toBe('/settings');
    });
  });

  describe('template literals', () => {
    it('extracts static template literals', () => {
      const fp = writeTempFile(
        tmpDir,
        `
        test('test', async ({ page }) => {
          await page.locator(\`#submit\`).click();
        });
      `,
      );
      const usages = parseTestFile(fp)._unsafeUnwrap();
      expect(usages).toHaveLength(1);
      expect(usages[0].rawValue).toBe('#submit');
    });

    it('skips dynamic template literals', () => {
      const fp = writeTempFile(
        tmpDir,
        `
        test('test', async ({ page }) => {
          const id = 'submit';
          await page.locator(\`#\${id}\`).click();
        });
      `,
      );
      const usages = parseTestFile(fp)._unsafeUnwrap();
      expect(usages).toHaveLength(0);
    });
  });

  describe('regex selectors', () => {
    it('extracts regex from getByText', () => {
      const fp = writeTempFile(
        tmpDir,
        `
        test('test', async ({ page }) => {
          await page.getByText(/welcome/i).click();
        });
      `,
      );
      const usages = parseTestFile(fp)._unsafeUnwrap();
      expect(usages).toHaveLength(1);
      expect(usages[0]).toMatchObject({ selectorType: 'text', rawValue: '/welcome/i' });
    });
  });

  describe('metadata', () => {
    it('captures line and column', () => {
      const code = `test('t', async ({ page }) => {\n  await page.locator('#x').click();\n});`;
      const fp = writeTempFile(tmpDir, code);
      const usages = parseTestFile(fp)._unsafeUnwrap();
      expect(usages[0].line).toBe(2);
      expect(usages[0].column).toBeGreaterThan(0);
    });

    it('produces stable 12-char hex IDs', () => {
      const fp = writeTempFile(
        tmpDir,
        `
        test('t', async ({ page }) => { await page.locator('#x').click(); });
      `,
      );
      const a = parseTestFile(fp)._unsafeUnwrap();
      const b = parseTestFile(fp)._unsafeUnwrap();
      expect(a[0].id).toBe(b[0].id);
      expect(a[0].id).toMatch(/^[a-f0-9]{12}$/);
    });
  });

  describe('error handling', () => {
    it('returns error for non-existent file', () => {
      const result = parseTestFile('/nonexistent/file.spec.ts');
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe('file-not-found');
    });

    it('returns error for file with syntax errors', () => {
      const fp = writeTempFile(tmpDir, 'this is not {{{{ valid');
      const result = parseTestFile(fp);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe('parse-error');
    });
  });

  describe('JSX files', () => {
    it('parses selectors in TSX files', () => {
      const fp = writeTempFile(
        tmpDir,
        `
        import { test } from '@playwright/test';
        test('t', async ({ page }) => {
          await page.getByTestId('root').click();
        });
      `,
        'comp.spec.tsx',
      );
      const usages = parseTestFile(fp)._unsafeUnwrap();
      expect(usages).toHaveLength(1);
      expect(usages[0].selectorType).toBe('testid');
    });
  });

  describe('multi-line calls', () => {
    it('handles selectors split across lines', () => {
      const fp = writeTempFile(
        tmpDir,
        `
        test('t', async ({ page }) => {
          await page.getByRole(
            'button',
            { name: 'Submit' }
          ).click();
        });
      `,
      );
      const usages = parseTestFile(fp)._unsafeUnwrap();
      expect(usages).toHaveLength(1);
      expect(usages[0]).toMatchObject({
        selectorType: 'role',
        rawValue: 'button',
        options: { name: 'Submit' },
      });
    });
  });

  describe('comprehensive fixture', () => {
    it('extracts all selectors from a full test file', () => {
      const fp = writeTempFile(
        tmpDir,
        `
        import { test, expect } from '@playwright/test';

        test('login flow', async ({ page }) => {
          await page.goto('https://app.com/login');
          await page.getByLabel('Email').fill('user@test.com');
          await page.getByLabel('Password').fill('pw');
          await page.getByRole('button', { name: 'Log in' }).click();
          await expect(page.getByTestId('dashboard')).toBeVisible();
          await page.locator('.greeting').isVisible();
        });
      `,
      );
      const usages = parseTestFile(fp)._unsafeUnwrap();
      expect(usages).toHaveLength(5);
      expect(usages.map((u) => u.selectorType)).toEqual([
        'label',
        'label',
        'role',
        'testid',
        'css',
      ]);
      for (const u of usages) {
        expect(u.contextHint).toBe('https://app.com/login');
      }
    });
  });
});
