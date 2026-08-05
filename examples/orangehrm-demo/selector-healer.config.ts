import type { HealerConfig } from '@selector-healer/core';

/**
 * Selector Healer demo against the public OrangeHRM demo site.
 *
 * OrangeHRM is a real app built on the OXD component library — it uses roles,
 * placeholders, visible text and CSS classes, but *no* test-ids. That makes it a
 * good real-world test: after Capture, the dashboard's robustness gauge will show
 * mostly "good/fragile" selectors and no "robust" ones, which is the honest
 * picture for an app without data-test attributes.
 */

const BASE = 'https://opensource-demo.orangehrmlive.com';

/**
 * Log in once with the public demo credentials. The session cookie then lives in
 * the browser context, so every page the verifier visits afterwards is already
 * authenticated — no per-page login needed.
 */
async function login(context: unknown): Promise<void> {
  const ctx = context as import('@playwright/test').BrowserContext;
  const page = await ctx.newPage();
  await page.goto(`${BASE}/web/index.php/auth/login`, { waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder('Username').fill('Admin');
  await page.getByPlaceholder('Password').fill('admin123');
  await page.getByRole('button', { name: 'Login' }).click();
  await page.waitForURL('**/dashboard/index', { timeout: 30_000 });
  await page.close();
}

/** Navigate an already-authenticated page to a deep link and let the SPA settle. */
async function goto(page: unknown, path: string): Promise<void> {
  const p = page as import('@playwright/test').Page;
  await p.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await p.waitForLoadState('networkidle').catch(() => {});
}

export default {
  testDir: './tests',
  baseUrl: BASE,
  headless: true,
  timeout: 30_000,
  globalSetup: (context) => login(context),
  pages: [
    {
      name: 'Dashboard',
      url: '/web/index.php/dashboard/index',
      setup: (page) => goto(page, '/web/index.php/dashboard/index'),
    },
    {
      name: 'Admin · User Management',
      url: '/web/index.php/admin/viewSystemUsers',
      setup: (page) => goto(page, '/web/index.php/admin/viewSystemUsers'),
    },
  ],
} satisfies HealerConfig;
