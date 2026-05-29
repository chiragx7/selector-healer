import type { HealerConfig } from '@selector-healer/core';

export default {
  testDir: './tests',
  baseUrl: 'http://localhost:3456',
  headless: true,
  timeout: 15_000,
  pages: [
    {
      name: 'Dashboard (after login)',
      url: '/dashboard',
      setup: async (page) => {
        // Type narrowed at runtime — PageConfig.setup receives a Playwright Page
        const p = page as import('playwright').Page;
        await p.goto('http://localhost:3456/');
        await p.getByLabel('Email').fill('user@example.com');
        await p.getByLabel('Password').fill('password123');
        await p.getByRole('button', { name: 'Log in' }).click();
        await p.waitForURL('**/dashboard');
      },
    },
    {
      name: 'Login error state',
      url: '/',
      setup: async (page) => {
        const p = page as import('playwright').Page;
        await p.goto('http://localhost:3456/');
        await p.getByLabel('Email').fill('wrong@example.com');
        await p.getByLabel('Password').fill('wrong');
        await p.getByRole('button', { name: 'Log in' }).click();
        // Wait for error banner to become visible
        await p.locator('.error-banner.visible').waitFor({ timeout: 5_000 });
      },
    },
    {
      name: 'Signup page',
      url: '/signup',
    },
  ],
} satisfies HealerConfig;
