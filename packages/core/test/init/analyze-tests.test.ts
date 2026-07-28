import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeTestSuite } from '../../src/init/analyze-tests.js';

const created: string[] = [];

/** Build a throwaway project with the given files under `tests/`. */
function suite(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sh-analyze-'));
  created.push(root);
  const dir = join(root, 'tests');
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return root;
}

afterEach(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
  created.length = 0;
});

describe('analyzeTestSuite — pages', () => {
  it('collects distinct page.goto paths as named pages', () => {
    const root = suite({
      'a.spec.ts':
        "test('x', async ({ page }) => { await page.goto('/dashboard'); await page.goto('/profile'); });",
      'b.spec.ts':
        "test('y', async ({ page }) => { await page.goto('/profile'); await page.goto('/settings/billing'); });",
    });
    const { pages } = analyzeTestSuite(root, './tests', '**/*.spec.ts');
    expect(pages.map((p) => p.url)).toEqual(['/dashboard', '/profile', '/settings/billing']);
    expect(pages.find((p) => p.url === '/settings/billing')?.name).toBe('Settings Billing');
  });

  it('ignores the root path and full URLs', () => {
    const root = suite({
      'a.spec.ts':
        "test('x', async ({ page }) => { await page.goto('/'); await page.goto('https://other.com/x'); await page.goto('/ok'); });",
    });
    const { pages } = analyzeTestSuite(root, './tests', '**/*.spec.ts');
    expect(pages.map((p) => p.url)).toEqual(['/ok']);
  });

  it('returns nothing for a suite with no gotos or login', () => {
    const root = suite({
      'a.spec.ts': "test('x', async ({ page }) => { await page.getByText('hi').click(); });",
    });
    const r = analyzeTestSuite(root, './tests', '**/*.spec.ts');
    expect(r.pages).toEqual([]);
    expect(r.login).toBeUndefined();
  });
});

describe('analyzeTestSuite — login', () => {
  it('lifts an inline login() helper', () => {
    const root = suite({
      'login.spec.ts': `
        async function login(page) {
          await page.goto('/');
          await page.getByLabel('Email').fill('a@b.com');
          await page.getByLabel('Password').fill('secret');
          await page.getByRole('button', { name: 'Log in' }).click();
          await page.waitForURL('**/dashboard');
        }
        test('x', async ({ page }) => { await page.goto('/dashboard'); });
      `,
    });
    const { login } = analyzeTestSuite(root, './tests', '**/*.spec.ts');
    expect(login).toBeDefined();
    expect(login?.gotoUrl).toBe('/');
    expect(login?.fills.map((f) => f.selector)).toEqual([
      "getByLabel('Email')",
      "getByLabel('Password')",
    ]);
    expect(login?.fills[0]?.kind).toBe('user');
    expect(login?.fills[1]?.kind).toBe('password');
    expect(login?.click).toBe("getByRole('button', { name: 'Log in' })");
    expect(login?.waitUrl).toBe('**/dashboard');
  });

  it('detects a login inside beforeEach', () => {
    const root = suite({
      'a.spec.ts': `
        test.beforeEach(async ({ page }) => {
          await page.goto('/');
          await page.getByTestId('email').fill('u');
          await page.getByTestId('submit').click();
        });
        test('x', async ({ page }) => {});
      `,
    });
    const { login } = analyzeTestSuite(root, './tests', '**/*.spec.ts');
    expect(login?.fills[0]?.selector).toBe("getByTestId('email')");
    expect(login?.click).toBe("getByTestId('submit')");
  });

  it('does not lift a variable-based (page-object) login', () => {
    const root = suite({
      'a.spec.ts': `
        async function login(page) {
          const email = page.getByLabel('Email');
          await email.fill('x');
          await loginButton.click();
        }
      `,
    });
    const { login } = analyzeTestSuite(root, './tests', '**/*.spec.ts');
    expect(login).toBeUndefined();
  });
});

describe('analyzeTestSuite — advanced detection', () => {
  it('collects pages from waitForURL and toHaveURL (globs/queries normalized)', () => {
    const root = suite({
      'a.spec.ts': `
        test('x', async ({ page }) => {
          await page.waitForURL('**/dashboard');
          await expect(page).toHaveURL('/reports?tab=1');
        });
      `,
    });
    const { pages } = analyzeTestSuite(root, './tests', '**/*.spec.ts');
    expect(pages.map((p) => p.url).sort()).toEqual(['/dashboard', '/reports']);
  });

  it('ignores a negated URL assertion', () => {
    const root = suite({
      'a.spec.ts': `
        test('x', async ({ page }) => {
          await expect(page).not.toHaveURL('/forbidden');
          await page.goto('/ok');
        });
      `,
    });
    const { pages } = analyzeTestSuite(root, './tests', '**/*.spec.ts');
    expect(pages.map((p) => p.url)).toEqual(['/ok']);
  });

  it('resolves base-constant gotos and drops external origins', () => {
    const root = suite({
      'base.spec.ts': `
        const BASE = 'http://localhost:3456';
        test('x', async ({ page }) => {
          await page.goto(\`\${BASE}/profile\`);
          await page.goto(BASE + '/settings');
          await page.goto('https://external.example.com/evil');
        });
      `,
    });
    const { pages } = analyzeTestSuite(root, './tests', '**/*.spec.ts', 'http://localhost:3456');
    expect(pages.map((p) => p.url).sort()).toEqual(['/profile', '/settings']);
  });

  it('classifies pages as auth-gated only when reached from a file that logs in', () => {
    const root = suite({
      'auth.spec.ts': `
        async function login(page) {
          await page.goto('/');
          await page.getByTestId('email').fill('u');
          await page.getByTestId('submit').click();
          await page.waitForURL('**/dashboard');
        }
        test.beforeEach(async ({ page }) => { await login(page); await page.goto('/profile'); });
        test('x', async ({ page }) => {});
      `,
      'public.spec.ts': `
        test('docs', async ({ page }) => { await page.goto('/docs'); });
      `,
    });
    const { pages, login } = analyzeTestSuite(root, './tests', '**/*.spec.ts');
    const auth = Object.fromEntries(pages.map((p) => [p.url, p.requiresAuth]));
    expect(auth['/dashboard']).toBe(true);
    expect(auth['/profile']).toBe(true);
    expect(auth['/docs']).toBe(false);
    expect(login?.landingPath).toBe('/dashboard');
  });
});
