import { type Page, expect, test } from '@playwright/test';

/**
 * Log in via stable test-ids, then land on the dashboard. Kept test-id based so
 * editing any visible text on the app pages doesn't break the way we get here.
 */
async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('email-input').fill('user@example.com');
  await page.getByTestId('password-input').fill('password123');
  await page.getByTestId('submit-btn').click();
  await page.waitForURL('**/dashboard');
}

test.describe('Profile page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/profile');
  });

  test('shows the profile form', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Your Profile' })).toBeVisible();
    await expect(page.getByAltText('Profile photo')).toBeVisible();
    await expect(page.getByTestId('input-fullname')).toBeVisible();
    await expect(page.getByPlaceholder('Tell us about yourself')).toBeVisible();
    await expect(page.getByTestId('save-profile')).toBeVisible();
    await expect(page.getByText('Last updated 2 days ago')).toBeVisible();
  });

  test('shows the app navigation', async ({ page }) => {
    await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Profile' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Log out' })).toBeVisible();
  });
});
