import { type Page, expect, test } from '@playwright/test';

/** Log in via stable test-ids and land on the dashboard. */
async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('email-input').fill('user@example.com');
  await page.getByTestId('password-input').fill('password123');
  await page.getByTestId('submit-btn').click();
  await page.waitForURL('**/dashboard');
}

test.describe('Settings page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/settings');
  });

  test('shows the settings sections', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
    await expect(page.getByTestId('section-security')).toBeVisible();
  });

  test('shows the toggles and actions', async ({ page }) => {
    await expect(page.getByLabel('Email notifications')).toBeVisible();
    await expect(page.getByLabel('Two-factor authentication')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save settings' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete account' })).toBeVisible();
  });
});
