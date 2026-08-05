import { expect, test } from '@playwright/test';

// The goto in beforeEach tags every selector below with this page, so Selector
// Healer verifies them on the Dashboard (reached via the config's login hook).
test.describe('OrangeHRM · Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/web/index.php/dashboard/index');
  });

  test('renders the dashboard shell', async ({ page }) => {
    await expect(page.getByPlaceholder('Search')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Admin' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'PIM' })).toBeVisible();
    await expect(page.getByText('Time at Work')).toBeVisible();
    await expect(page.getByText('Quick Launch')).toBeVisible();
  });
});
