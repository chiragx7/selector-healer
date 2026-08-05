import { expect, test } from '@playwright/test';

test.describe('OrangeHRM · Admin · User Management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/web/index.php/admin/viewSystemUsers');
  });

  test('renders the user-management page', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Add' })).toBeVisible();
    await expect(page.getByText('System Users')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Search' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reset' })).toBeVisible();
  });
});
