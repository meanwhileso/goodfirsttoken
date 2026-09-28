import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

// Sign-in against the GitHub fake that runs beside the app. wrangler.jsonc
// runs the app as development, with the fake's OAuth app.

function nav(page: Page) {
  return page.getByRole('navigation', { name: 'Primary' });
}

// Signing out ends every session the person has, so this test signs in as
// @lena, whom no other e2e test signs in as. mcp.spec.ts runs beside it as @priya.
test('signing in with GitHub through the fake shows your login in the nav, and signing out takes it away', async ({
  page,
  context,
  baseURL,
}) => {
  await page.goto('/sign-in');
  await expect(nav(page).getByRole('link', { name: 'Good First Token on GitHub' })).toBeVisible();

  await page.getByRole('button', { name: 'Sign in with GitHub' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in to the GitHub fake');
  await expect(page.getByText('asks for: public_repo.')).toBeVisible();
  await page.getByRole('button', { name: '@lena' }).click();

  await page.waitForURL((url) => url.pathname === '/me');
  await expect(nav(page).getByRole('link', { name: '@lena' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('@lena');

  // Every cookie the site set is host-only, named with the __Host- prefix.
  const cookies = await context.cookies(baseURL);
  expect(cookies.map((cookie) => cookie.name)).toContain('__Host-gft.session_token');
  for (const cookie of cookies) {
    expect(cookie.name).toMatch(/^__Host-/);
    expect(cookie).toMatchObject({ domain: new URL(baseURL ?? '').hostname, path: '/', secure: true, httpOnly: true });
  }

  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL((url) => url.pathname === '/');
  await expect(nav(page).getByRole('link', { name: 'Good First Token on GitHub' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: '@lena' })).toHaveCount(0);
  expect(await context.cookies(baseURL)).toEqual([]);
});

// The page posts the form itself, so the browser sends its own Origin, and
// the fixtures' cookie check sees every response on the way to /me.
test('in development, the dev sign-in signs in as a sample person in one request', async ({ page }) => {
  await page.goto('/');

  await page.evaluate(() => {
    const form = document.createElement('form');
    form.method = 'post';
    form.action = '/auth/dev/sign-in';
    const login = document.createElement('input');
    login.name = 'login';
    login.value = 'kenji';
    form.append(login);
    document.body.append(form);
    form.submit();
  });

  await page.waitForURL((url) => url.pathname === '/me');
  await expect(nav(page).getByRole('link', { name: '@kenji' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('@kenji');
});
