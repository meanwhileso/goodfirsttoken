import { exports } from 'cloudflare:workers';
import { expect, test } from 'vitest';

test('healthz names the environment it runs in and is never cached', async () => {
  const res = await exports.default.fetch('http://localhost/healthz');

  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/json');
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(await res.json()).toEqual({ ok: true, environment: 'development' });
});
