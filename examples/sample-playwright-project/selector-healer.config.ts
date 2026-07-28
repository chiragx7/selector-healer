import type { HealerConfig } from '@selector-healer/core';

const BASE = 'http://localhost:3456';

/**
 * Log in using the stable data-test-ids and land on the dashboard.
 *
 * The auth flow deliberately uses test-ids (not labels/role names) so that
 * changing any visible *text* in the app — headings, labels, button captions —
 * breaks only the selector under test, never the login that reaches the page.
 * That's what lets you safely "change 2-3 texts at a time" and re-verify.
 */
async function login(page: unknown): Promise<void> {
  const p = page as import('@playwright/test').Page;
  await p.goto(`${BASE}/`);
  await p.getByTestId('email-input').fill('user@example.com');
  await p.getByTestId('password-input').fill('password123');
  await p.getByTestId('submit-btn').click();
  await p.waitForURL('**/dashboard');
}

/** Log in, then navigate to a post-login page. */
async function loginAndGoto(page: unknown, path: string): Promise<void> {
  const p = page as import('@playwright/test').Page;
  await login(p);
  if (path !== '/dashboard') await p.goto(`${BASE}${path}`);
}

export default {
  testDir: './tests',
  baseUrl: BASE,
  headless: true,
  timeout: 15_000,
  pages: [
    {
      name: 'Dashboard (after login)',
      url: '/dashboard',
      setup: (page) => loginAndGoto(page, '/dashboard'),
    },
    {
      name: 'Profile (after login)',
      url: '/profile',
      setup: (page) => loginAndGoto(page, '/profile'),
    },
    {
      name: 'Settings (after login)',
      url: '/settings',
      setup: (page) => loginAndGoto(page, '/settings'),
    },
    {
      name: 'Login error state',
      url: '/',
      setup: async (page) => {
        const p = page as import('@playwright/test').Page;
        await p.goto(`${BASE}/`);
        await p.getByTestId('email-input').fill('wrong@example.com');
        await p.getByTestId('password-input').fill('wrong');
        await p.getByTestId('submit-btn').click();
        // Wait for the error banner to become visible.
        await p.locator('.error-banner.visible').waitFor({ timeout: 5_000 });
      },
    },
    {
      name: 'Signup page',
      url: '/signup',
    },
  ],
} satisfies HealerConfig;
