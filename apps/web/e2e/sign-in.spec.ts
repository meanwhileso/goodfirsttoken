import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

// Sign-in against the GitHub fake that runs beside the app. wrangler.jsonc
// runs the app as development, with the fake's OAuth app.

function nav(page: Page) {
  return page.getByRole('navigation', { name: 'Primary' });
}

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
  await page.getByRole('button', { name: '@priya' }).click();

  await page.waitForURL((url) => url.pathname === '/me');
  await expect(nav(page).getByRole('link', { name: '@priya' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('@priya');

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
  await expect(nav(page).getByRole('link', { name: '@priya' })).toHaveCount(0);
  expect(await context.cookies(baseURL)).toEqual([]);
});

test('in development, the dev sign-in signs in as a sample person in one request', async ({ page, baseURL }) => {
  const answer = await page.request.post('/auth/dev/sign-in', {
    form: { login: 'kenji' },
    headers: { origin: new URL(baseURL ?? '').origin },
  });

  expect(new URL(answer.url()).pathname).toBe('/me');
  await page.goto('/');
  await expect(nav(page).getByRole('link', { name: '@kenji' })).toBeVisible();
});
