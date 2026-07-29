import { expect, test } from '@playwright/test';

test.describe('Login page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should display login form', async ({ page }) => {
    await expect(page.locator('h1')).toHaveText('Login');
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByTestId('submit-btn')).toBeVisible();
  });

  test('should login with valid credentials', async ({ page }) => {
    await page.getByLabel('Email').fill('user@example.com');
    await page.getByLabel('Password').fill('password123');
    await page.getByTestId('submit-btn').click();

    await expect(page.getByTestId('dashboard-greeting')).toContainText('Welcome');
    await expect(page.locator('.user-avatar')).toBeVisible();
  });

  test('should show error for invalid credentials', async ({ page }) => {
    await page.getByLabel('Email').fill('wrong@example.com');
    await page.getByLabel('Password').fill('wrong');
    await page.getByTestId('submit-btn').click();

    await expect(page.getByText('Invalid email or password')).toBeVisible();
    await expect(page.locator('.error-banner')).toHaveClass(/visible/);
  });

  test('should navigate to signup', async ({ page }) => {
    await page.getByRole('link', { name: 'Sign up' }).click();
    await expect(page.locator('h1')).toHaveText('Create Account');
  });
});
