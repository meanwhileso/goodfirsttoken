import { expect, test } from 'vitest';
import { redirectToPrimaryDomain } from '../src/redirect';
import { workerFetch } from './worker';

// vitest.config.ts sets PRIMARY_DOMAIN to primary.example and REDIRECT_DOMAINS
// to second.example and www.primary.example.

test('a request to a redirect domain answers 301 with the same path and query on the primary domain', async () => {
  const res = await workerFetch('https://second.example/meanwhileso/goodfirsttoken?tab=issues');

  expect(res.status).toBe(301);
  expect(res.headers.get('location')).toBe('https://primary.example/meanwhileso/goodfirsttoken?tab=issues');
});

test('every redirect domain in the list redirects, and so does every path, /healthz included', async () => {
  const res = await workerFetch('http://www.primary.example/healthz');

  expect(res.status).toBe(301);
  expect(res.headers.get('location')).toBe('https://primary.example/healthz');
});

test('a redirect domain written with the trailing dot of a fully qualified name still redirects', async () => {
  const res = await workerFetch('https://second.example./healthz');

  expect(res.status).toBe(301);
  expect(res.headers.get('location')).toBe('https://primary.example/healthz');
});

test('the primary domain, workers.dev, and localhost are served without a redirect', async () => {
  for (const origin of ['https://primary.example', 'https://web.example.workers.dev', 'http://localhost']) {
    const res = await workerFetch(`${origin}/healthz`);

    expect(res.status, origin).toBe(200);
  }
});

test('with no primary domain, as in local development, nothing redirects', () => {
  const env = { PRIMARY_DOMAIN: '', REDIRECT_DOMAINS: 'second.example' };

  expect(redirectToPrimaryDomain(new Request('https://second.example/'), env)).toBeUndefined();
});
