import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localOrigin, upstreamUrl } from './apps-host-proxy.ts';

const site = new URL('http://localhost:5173');

test('the proxy passes on only /mcp, to the site it signed in to', () => {
  assert.equal(upstreamUrl('/mcp', site)?.href, 'http://localhost:5173/mcp');
  assert.equal(upstreamUrl('/mcp?x=1', site)?.href, 'http://localhost:5173/mcp');
});

test('no request can send the token to another host or path', () => {
  for (const path of [
    '//evil.example/x',
    'http://evil.example/mcp',
    'https://evil.example/mcp',
    '/\\evil.example/mcp',
    '/mcp/../admin',
    '/admin',
    '/',
    '',
    undefined,
  ]) {
    assert.equal(upstreamUrl(path, site), null, String(path));
  }
});

test('only a page on this machine gets CORS headers', () => {
  for (const origin of ['http://localhost:8080', 'http://127.0.0.1:8080', 'http://[::1]:8080']) {
    assert.equal(localOrigin(origin), true, origin);
  }
  for (const origin of ['https://evil.example', 'http://localhost.evil.example', 'null', undefined]) {
    assert.equal(localOrigin(origin), false, String(origin));
  }
});
