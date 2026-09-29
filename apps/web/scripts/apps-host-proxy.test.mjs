import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { localOrigin, proxyServer, upstreamUrl } from './apps-host-proxy.ts';

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

// The proxy's server itself, between a stand-in for the site and a sink
// that no request may reach, each on a port of its own on this machine.

const TOKEN = 'agent-token';
const ADDRESS = '2001:db8::1';
const ANSWER = '{"jsonrpc":"2.0","id":1,"result":{}}';

/** A server on a free port on this machine that records each request it gets and answers it. */
async function recorder(answer) {
  const seen = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      seen.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString() });
      answer(response);
    });
  });
  await listen(server);
  return { server, seen, port: server.address().port };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  server.closeAllConnections();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/** Sends the proxy a request with this exact request target, as a client that isn't a browser can. */
function send(port, { method = 'GET', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

let upstream;
let sink;
let proxy;
let proxyPort;

before(async () => {
  upstream = await recorder((response) => {
    response.writeHead(200, { 'content-type': 'application/json', 'mcp-protocol-version': '2025-11-25' });
    response.end(ANSWER);
  });
  sink = await recorder((response) => {
    response.writeHead(200);
    response.end('the sink');
  });
  proxy = proxyServer({ site: new URL(`http://127.0.0.1:${String(upstream.port)}`), token: TOKEN, address: ADDRESS });
  proxyPort = await listen(proxy);
});

after(async () => {
  await Promise.all([close(proxy), close(upstream.server), close(sink.server)]);
});

test("/mcp from a page on this machine reaches the site with the agent's token, and none of the page's own", async () => {
  const from = upstream.seen.length;
  const body = '{"jsonrpc":"2.0","id":1,"method":"ping"}';

  const answer = await send(proxyPort, {
    method: 'POST',
    path: '/mcp',
    headers: { origin: 'http://localhost:8080', 'content-type': 'application/json', authorization: 'Bearer the-page', cookie: 'session=the-page' },
    body,
  });

  assert.equal(answer.status, 200);
  assert.equal(answer.body, ANSWER);
  assert.equal(answer.headers['access-control-allow-origin'], 'http://localhost:8080');
  assert.equal(answer.headers['mcp-protocol-version'], '2025-11-25');
  const got = upstream.seen.slice(from);
  assert.equal(got.length, 1);
  assert.equal(got[0].method, 'POST');
  assert.equal(got[0].url, '/mcp');
  assert.equal(got[0].body, body);
  assert.equal(got[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(got[0].headers['cf-connecting-ip'], ADDRESS);
  assert.equal(got[0].headers.cookie, undefined);
  assert.equal(got[0].headers.origin, undefined);
});

test('a request that names another host, with // or in absolute form, never reaches it, and the site gets nothing', async () => {
  const from = upstream.seen.length;
  const other = `127.0.0.1:${String(sink.port)}`;

  for (const path of [`//${other}/x`, `//${other}/mcp`, `http://${other}/mcp`, `http://${other}/x`]) {
    const answer = await send(proxyPort, { method: 'POST', path, headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(answer.status, 404, path);
  }

  assert.deepEqual(sink.seen, []);
  assert.equal(upstream.seen.length, from);
});

test('a page elsewhere gets a 403, with no CORS headers, and nothing reaches the site', async () => {
  const from = upstream.seen.length;

  for (const method of ['POST', 'OPTIONS']) {
    const answer = await send(proxyPort, {
      method,
      path: '/mcp',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json', 'access-control-request-method': 'POST' },
      body: method === 'POST' ? '{}' : undefined,
    });
    assert.equal(answer.status, 403, method);
    assert.equal(answer.headers['access-control-allow-origin'], undefined, method);
  }

  assert.equal(upstream.seen.length, from);
});

test("a preflight from basic-host's page gets a 204 that names its origin, and the proxy answers it itself", async () => {
  const from = upstream.seen.length;

  const answer = await send(proxyPort, {
    method: 'OPTIONS',
    path: '/mcp',
    headers: { origin: 'http://localhost:8080', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, mcp-protocol-version' },
  });

  assert.equal(answer.status, 204);
  assert.equal(answer.headers['access-control-allow-origin'], 'http://localhost:8080');
  assert.equal(answer.headers.vary, 'origin');
  assert.match(answer.headers['access-control-allow-headers'] ?? '', /mcp-protocol-version/);
  assert.equal(upstream.seen.length, from);
});

test('a request that comes while the agent signs in waits for its token', async () => {
  const from = upstream.seen.length;
  let signedIn = () => undefined;
  const token = new Promise((resolve) => {
    signedIn = resolve;
  });
  const early = proxyServer({ site: new URL(`http://127.0.0.1:${String(upstream.port)}`), token, address: ADDRESS });
  const port = await listen(early);

  const answer = send(port, { method: 'POST', path: '/mcp', headers: { 'content-type': 'application/json' }, body: '{}' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(upstream.seen.length, from);
  signedIn('later-token');

  assert.equal((await answer).status, 200);
  assert.equal(upstream.seen.at(-1)?.headers.authorization, 'Bearer later-token');
  await close(early);
});

test('on a port that is taken, the proxy stops before any agent signs in', async () => {
  const from = upstream.seen.length;
  const taken = http.createServer();
  const port = await listen(taken);
  const script = fileURLToPath(new URL('./apps-host-proxy.ts', import.meta.url));

  const run = spawn(process.execPath, [script, '--site', `http://127.0.0.1:${String(upstream.port)}`, '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  run.stderr.on('data', (chunk) => {
    said += String(chunk);
  });
  const code = await new Promise((resolve) => run.on('close', resolve));
  await close(taken);

  assert.equal(code, 1);
  assert.match(said, new RegExp(`can't listen on port ${String(port)}`));
  // Signing in starts with a request to the site's /mcp, and none came.
  assert.equal(upstream.seen.length, from);
});
