import type { RecordedCall } from '@goodfirsttoken/github-fake';
import { LOCAL_API_URL, LOCAL_WEB_URL } from '@goodfirsttoken/github-fake/local';
import { localOAuthApp } from '@goodfirsttoken/github-fake/sample-data';
import { expect, test } from '@playwright/test';

// The GitHub fake that `pnpm dev` and these tests run beside the app. Its
// sign-in page is how local development signs in as a sample person. The
// app's own sign-in sends people through it (sign-in.spec.ts).
test('signing in on the GitHub fake as a sample person returns to the app with a code for their token', async ({
  page,
  request,
  baseURL,
}) => {
  const back = new URL('/', baseURL).toString();
  const state = `e2e-${String(Date.now())}`;
  const params = new URLSearchParams({ client_id: localOAuthApp.clientId, redirect_uri: back, scope: 'public_repo', state });

  await page.goto(`${LOCAL_WEB_URL}/login/oauth/authorize?${params.toString()}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in to the GitHub fake');
  await page.getByRole('button', { name: '@priya' }).click();

  await page.waitForURL((url) => url.href.startsWith(back));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Good First Token');
  const returned = new URL(page.url());
  expect(returned.searchParams.get('state')).toBe(state);

  const exchange = await request.post(`${LOCAL_WEB_URL}/login/oauth/access_token`, {
    headers: { accept: 'application/json' },
    form: {
      client_id: localOAuthApp.clientId,
      client_secret: localOAuthApp.clientSecret,
      code: returned.searchParams.get('code') ?? '',
    },
  });
  const { access_token: token } = (await exchange.json()) as { access_token: string };
  const me = await request.get(`${LOCAL_API_URL}/user`, { headers: { authorization: `Bearer ${token}` } });
  const calls = (await (await request.get(`${LOCAL_WEB_URL}/_fake/calls`)).json()) as RecordedCall[];

  expect(await me.json()).toMatchObject({ login: 'priya' });
  expect(calls.filter((call) => call.token === token)).toMatchObject([{ operation: 'GET /user', login: 'priya' }]);
});
