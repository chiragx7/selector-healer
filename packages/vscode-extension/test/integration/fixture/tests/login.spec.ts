import { expect, test } from '@playwright/test';

test('login form renders', async ({ page }) => {
  await page.goto('/login');
  await page.locator('#username').fill('admin');
  await page.locator('#password').fill('secret');
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.getByTestId('dashboard-title').isVisible();
});
