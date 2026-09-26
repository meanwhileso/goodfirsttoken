import { expect, test } from '@playwright/test';

test('the home page loads with the product name', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle('Good First Token');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Good First Token');
});
