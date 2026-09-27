import type { Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from './fixtures';

// An agent connecting to the MCP server, with the person's side in the
// browser: the page where they approve the agent, the GitHub fake's sign-in,
// and back to the agent. Then /me lists the agent, and Disconnect removes it.
// The fixtures check every cookie the site sets on the way.

// The agent's own listener for its code, on this machine, the way a harness
// like Claude Code waits for one.
let agent: Server;
let agentOrigin = '';

test.beforeAll(async () => {
  agent = createServer((_request, response) => response.end('The agent got its code.'));
  await new Promise<void>((resolve) => agent.listen(0, '127.0.0.1', resolve));
  agentOrigin = `http://127.0.0.1:${String((agent.address() as AddressInfo).port)}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => agent.close(resolve));
});

async function devSignIn(page: Page, login: string) {
  await page.goto('/');
  await page.evaluate((person) => {
    const form = document.createElement('form');
    form.method = 'post';
    form.action = '/auth/dev/sign-in';
    const field = document.createElement('input');
    field.name = 'login';
    field.value = person;
    form.append(field);
    document.body.append(form);
    form.submit();
  }, login);
  await page.waitForURL((url) => url.pathname === '/me');
}

test('an agent connects through the page where the person approves it and GitHub, then /me lists it until Disconnect', async ({
  page,
  request,
}) => {
  const name = `Playwright agent ${randomBytes(4).toString('hex')}`;
  const redirectUri = `${agentOrigin}/callback`;
  const registered = await request.post('/oauth/register', {
    data: { client_name: name, redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' },
  });
  expect(registered.status()).toBe(201);
  const { client_id: clientId } = (await registered.json()) as { client_id: string };
  const verifier = randomBytes(32).toString('base64url');
  const authorize = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state: 'e2e-state',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  });
  await page.goto(`/oauth/authorize?${authorize.toString()}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Connect an agent');
  await expect(page.getByText(name)).toBeVisible();
  await expect(page.getByText('That is an app on your computer.')).toBeVisible();
  await page.getByRole('button', { name: 'Continue with GitHub' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in to the GitHub fake');
  await page.getByRole('button', { name: '@priya' }).click();
  await page.waitForURL((url) => url.origin === agentOrigin);

  const back = new URL(page.url());
  expect(back.searchParams.get('state')).toBe('e2e-state');
  const token = await request.post('/oauth/token', {
    form: {
      grant_type: 'authorization_code',
      code: back.searchParams.get('code') ?? '',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    },
  });
  expect(token.status()).toBe(200);

  await devSignIn(page, 'priya');
  const disconnect = page.getByRole('button', { name: `Disconnect ${name}` });
  await expect(disconnect).toBeVisible();
  await disconnect.click();
  await page.waitForURL((url) => url.pathname === '/me');
  await expect(page.getByRole('button', { name: `Disconnect ${name}` })).toHaveCount(0);
});
