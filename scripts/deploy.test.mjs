import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  applyMigrations,
  checkStaticHost,
  ensureResources,
  exportCredential,
  getCredential,
  putSecrets,
  smokeTest,
  smokeTestUrl,
  uploadStaticAssets,
  wranglerIn,
} from './deploy.mjs';

const ACCOUNT_ID = 'a1'.repeat(16);
const BROKER = 'https://broker.example/cloudflare';
const OIDC_URL = 'https://oidc.example/token?api-version=2.0';

// A fetch that answers from a list of handlers in order and records each call.
function fakeFetch(...handlers) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body,
      redirect: init.redirect,
    });
    const handler = handlers[calls.length - 1];
    if (!handler) throw new Error(`unexpected request to ${String(url)}`);
    return handler(String(url), init);
  };
  return { fetch, calls };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

// A temporary directory, deleted when the test ends.
function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'deploy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const brokerEnv = {
  CLOUDFLARE_CREDENTIAL_BROKER_URL: BROKER,
  ACTIONS_ID_TOKEN_REQUEST_URL: OIDC_URL,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
};

test('the CLOUDFLARE_API_TOKEN secret is used as it is, with no other request', async () => {
  const { fetch, calls } = fakeFetch();

  const { token } = await getCredential({ env: { CLOUDFLARE_API_TOKEN: 'long-lived' }, fetch });

  assert.equal(token, 'long-lived');
  assert.equal(calls.length, 0);
});

test('with a broker URL, the job trades its GitHub OIDC token for a short-lived one', async () => {
  const { fetch, calls } = fakeFetch(
    () => json({ value: 'github-oidc-jwt' }),
    () => json({ token: 'short-lived' }),
  );

  const { token } = await getCredential({ env: brokerEnv, fetch, log: () => {} });

  assert.equal(token, 'short-lived');
  const oidc = new URL(calls[0].url);
  assert.equal(oidc.searchParams.get('audience'), BROKER);
  assert.equal(oidc.searchParams.get('api-version'), '2.0');
  assert.equal(calls[0].headers.authorization, 'bearer request-token');
  assert.equal(calls[1].url, BROKER);
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].headers.authorization, 'Bearer github-oidc-jwt');
});

test('the OIDC token is masked as soon as the job has it', async () => {
  const lines = [];
  const { fetch } = fakeFetch(
    () => json({ value: 'github-oidc-jwt' }),
    () => json({ token: 'short-lived' }),
  );

  await getCredential({ env: brokerEnv, fetch, log: (line) => lines.push(line) });

  assert.equal(lines[0], '::add-mask::github-oidc-jwt');
});

test('the broker call never follows a redirect, so the OIDC token goes only to the broker URL', async () => {
  const { fetch, calls } = fakeFetch(
    () => json({ value: 'github-oidc-jwt' }),
    () => json({ token: 'short-lived' }),
  );

  await getCredential({ env: brokerEnv, fetch, log: () => {} });

  assert.equal(calls[1].url, BROKER);
  assert.equal(calls[1].redirect, 'error');
});

test('the broker form needs the id-token: write permission', async () => {
  const env = { CLOUDFLARE_CREDENTIAL_BROKER_URL: BROKER };

  await assert.rejects(getCredential({ env, fetch: fakeFetch().fetch }), /id-token: write/);
});

test('the OIDC token is only ever sent to an https broker', async () => {
  const env = { ...brokerEnv, CLOUDFLARE_CREDENTIAL_BROKER_URL: 'http://broker.example/' };
  const { fetch, calls } = fakeFetch();

  await assert.rejects(getCredential({ env, fetch }), /https/);
  assert.equal(calls.length, 0);
});

test('an environment needs exactly one credential form', async () => {
  const { fetch } = fakeFetch();

  await assert.rejects(getCredential({ env: {}, fetch }), /no Cloudflare credential/);
  await assert.rejects(getCredential({ env: { ...brokerEnv, CLOUDFLARE_API_TOKEN: 'long-lived' }, fetch }), /Keep only one/);
});

test('a broker that refuses, or answers with something that is not a token, stops the deploy', async () => {
  const oidc = () => json({ value: 'github-oidc-jwt' });
  for (const answer of [
    () => json({ error: 'not this repo' }, 403),
    () => json({}),
    () => json({ token: 'short-lived\nNODE_OPTIONS=--require=/tmp/evil.js' }),
  ]) {
    await assert.rejects(getCredential({ env: brokerEnv, fetch: fakeFetch(oidc, answer).fetch, log: () => {} }), /credential broker/);
  }
});

test('the token is masked first, then handed to later steps through GITHUB_ENV', async (t) => {
  const envFile = path.join(tempDir(t), 'github-env');
  writeFileSync(envFile, '');
  const lines = [];
  const { fetch } = fakeFetch(
    () => json({ value: 'github-oidc-jwt' }),
    () => json({ token: 'short-lived' }),
  );

  await exportCredential({ env: brokerEnv, fetch, envFile, log: (line) => lines.push(line) });

  const shown = lines.filter((line) => line.includes('short-lived'));
  assert.deepEqual(shown, ['::add-mask::short-lived'], 'the token shows only in its mask');
  assert.equal(readFileSync(envFile, 'utf8'), 'CLOUDFLARE_API_TOKEN=short-lived\n');
});

// A Cloudflare API that keeps D1 databases and queues in memory.
function fakeCloudflare({ databases = [], queues = [] } = {}) {
  const state = { databases: new Set(databases), queues: new Set(queues), requests: [] };
  const fetch = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    const method = init.method ?? 'GET';
    assert.equal(init.headers.authorization, 'Bearer cf-token');
    const resource = pathname.replace(`/client/v4/accounts/${ACCOUNT_ID}`, '');
    state.requests.push(`${method} ${resource}`);
    const body = init.body ? JSON.parse(init.body) : {};
    if (method === 'GET' && resource.startsWith('/d1/database/')) {
      const name = decodeURIComponent(resource.slice('/d1/database/'.length));
      if (!state.databases.has(name)) return json({ success: false, errors: [{ code: 7404, message: 'not found' }] }, 404);
      return json({ success: true, result: { name } });
    }
    if (method === 'POST' && resource === '/d1/database') {
      state.databases.add(body.name);
      return json({ success: true, result: { name: body.name } });
    }
    if (method === 'GET' && resource === '/queues') {
      const name = searchParams.get('name');
      return json({ success: true, result: state.queues.has(name) ? [{ queue_name: name }] : [] });
    }
    if (method === 'POST' && resource === '/queues') {
      state.queues.add(body.queue_name);
      return json({ success: true, result: { queue_name: body.queue_name } });
    }
    return json({ success: false, errors: [{ message: 'unexpected' }] }, 400);
  };
  return { fetch, state };
}

const withQueues = {
  account_id: ACCOUNT_ID,
  d1_databases: [{ binding: 'DB', database_name: 'site-db' }],
  queues: {
    producers: [{ binding: 'FEED_QUEUE', queue: 'site-feed' }],
    consumers: [{ queue: 'site-feed', dead_letter_queue: 'site-feed-dlq' }],
  },
};

test('a missing D1 database and missing queues, the dead-letter queue included, are created', async () => {
  const cloudflare = fakeCloudflare();

  await ensureResources({ config: withQueues, token: 'cf-token', fetch: cloudflare.fetch, log: () => {} });

  assert.deepEqual([...cloudflare.state.databases], ['site-db']);
  assert.deepEqual([...cloudflare.state.queues].sort(), ['site-feed', 'site-feed-dlq']);
});

test('resources that exist are left alone, and a database with an ID is not looked up', async () => {
  const cloudflare = fakeCloudflare({ databases: ['site-db'], queues: ['site-feed', 'site-feed-dlq'] });
  await ensureResources({ config: withQueues, token: 'cf-token', fetch: cloudflare.fetch, log: () => {} });
  assert.ok(cloudflare.state.requests.every((request) => request.startsWith('GET')));

  const withId = { ...withQueues, d1_databases: [{ binding: 'DB', database_name: 'site-db', database_id: 'x' }] };
  const second = fakeCloudflare({ queues: ['site-feed', 'site-feed-dlq'] });
  await ensureResources({ config: withId, token: 'cf-token', fetch: second.fetch, log: () => {} });
  assert.ok(second.state.requests.every((request) => !request.includes('/d1/')));
});

test('a Cloudflare error stops the deploy with its message', async () => {
  const fetch = async () => json({ success: false, errors: [{ message: 'Authentication error' }] }, 403);

  await assert.rejects(
    ensureResources({ config: withQueues, token: 'cf-token', fetch, log: () => {} }),
    /403.*Authentication error/,
  );
});

// A repo root whose apps/web can hold migrations and a fake Wrangler.
function sampleRoot(t) {
  const root = tempDir(t);
  mkdirSync(path.join(root, 'apps', 'web'), { recursive: true });
  return root;
}

test('migrations are applied for each database that has a migrations folder', (t) => {
  const root = sampleRoot(t);
  mkdirSync(path.join(root, 'apps', 'web', 'migrations'));
  mkdirSync(path.join(root, 'apps', 'web', 'db', 'crawl'), { recursive: true });
  const runs = [];
  const config = {
    d1_databases: [
      { binding: 'DB', database_name: 'site-db' },
      { binding: 'CRAWL_DB', database_name: 'site-crawl', migrations_dir: 'db/crawl' },
    ],
  };

  applyMigrations({ config, root, wrangler: (args) => runs.push(args), log: () => {} });

  assert.deepEqual(runs, [
    ['d1', 'migrations', 'apply', 'DB', '--remote', '--config', 'wrangler.deploy.json'],
    ['d1', 'migrations', 'apply', 'CRAWL_DB', '--remote', '--config', 'wrangler.deploy.json'],
  ]);
});

test('a database with no migrations folder yet is skipped, so deploys work before the first migration', (t) => {
  const runs = [];
  const lines = [];

  applyMigrations({
    config: { d1_databases: [{ binding: 'DB', database_name: 'site-db' }] },
    root: sampleRoot(t),
    wrangler: (args) => runs.push(args),
    log: (line) => lines.push(line),
  });

  assert.deepEqual(runs, []);
  assert.match(lines.join('\n'), /No migrations for DB/);
});

// Installs a Wrangler that records its arguments, stdin, and environment.
function recordingWrangler(root) {
  const bin = path.join(root, 'apps', 'web', 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  const record = path.join(root, 'runs.ndjson');
  writeFileSync(
    path.join(bin, 'wrangler'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const stdin = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), stdin, env: process.env }) + '\\n');
`,
  );
  chmodSync(path.join(bin, 'wrangler'), 0o755);
  return () =>
    readFileSync(record, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
}

test('each secret the Worker declares is put one at a time, its value only on stdin', (t) => {
  const root = sampleRoot(t);
  const runs = recordingWrangler(root);
  const lines = [];
  const env = { SESSION_KEY: 'value-one', OAUTH_CLIENT_SECRET: 'value-two' };

  putSecrets({
    config: { secrets: { required: ['SESSION_KEY', 'OAUTH_CLIENT_SECRET'] } },
    env,
    wrangler: wranglerIn(root, { ...process.env, ...env }),
    log: (line) => lines.push(line),
  });

  const recorded = runs();
  assert.deepEqual(
    recorded.map((run) => run.args),
    [
      ['secret', 'put', 'SESSION_KEY', '--config', 'wrangler.deploy.json'],
      ['secret', 'put', 'OAUTH_CLIENT_SECRET', '--config', 'wrangler.deploy.json'],
    ],
  );
  assert.deepEqual(
    recorded.map((run) => run.stdin),
    ['value-one', 'value-two'],
  );
  for (const run of recorded) {
    assert.equal(JSON.stringify(run.env).includes('value-'), false, 'no secret value in the environment Wrangler gets');
  }
  assert.equal(lines.join('\n').includes('value-'), false, 'no secret value in the log');
});

test('a missing secret stops the deploy before any secret is put', () => {
  const runs = [];

  assert.throws(
    () =>
      putSecrets({
        config: { secrets: { required: ['SESSION_KEY', 'OAUTH_CLIENT_SECRET'] } },
        env: { SESSION_KEY: 'value-one' },
        wrangler: (args) => runs.push(args),
        log: () => {},
      }),
    /Missing secrets: OAUTH_CLIENT_SECRET/,
  );
  assert.deepEqual(runs, []);
});

// A build's client folder: files named after their content under assets/,
// and files outside it, which are not.
function sampleBuild(t) {
  const dir = path.join(tempDir(t), 'client');
  mkdirSync(path.join(dir, 'assets', 'nested'), { recursive: true });
  writeFileSync(path.join(dir, 'assets', 'app-Ab12Cd34.css'), 'body{}');
  writeFileSync(path.join(dir, 'assets', 'nested', 'chunk-Ef56Gh78.js'), 'export {}');
  writeFileSync(path.join(dir, 'assets', 'good-first-token-launch-Ij90Kl12.mp4'), Buffer.from([0, 0, 0, 24, 102, 116]));
  writeFileSync(path.join(dir, '.assetsignore'), 'wrangler.json\n');
  writeFileSync(path.join(dir, 'robots.txt'), 'User-agent: *\n');
  return dir;
}

// Cloudflare's R2 API for one bucket, keeping its objects in memory.
function fakeR2({ bucket = 'site-static', exists = true, objects = {} } = {}) {
  const state = { objects: new Map(Object.entries(objects)), puts: [] };
  const prefix = `/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${bucket}`;
  const fetch = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const method = init.method ?? 'GET';
    assert.equal(init.headers.authorization, 'Bearer cf-token');
    if (!exists || !pathname.startsWith(prefix)) {
      return json({ success: false, errors: [{ code: 10006, message: 'The specified bucket does not exist.' }] }, 404);
    }
    if (pathname === prefix && method === 'GET') return json({ success: true, result: { name: bucket } });
    const key = decodeURIComponent(pathname.slice(`${prefix}/objects/`.length));
    if (method === 'GET') {
      if (!state.objects.has(key)) return json({ success: false, errors: [{ code: 10007, message: 'not found' }] }, 404);
      return new Response(state.objects.get(key).body);
    }
    if (method === 'PUT') {
      const headers = Object.fromEntries(Object.entries(init.headers).filter(([name]) => name !== 'authorization'));
      state.objects.set(key, { headers, body: Buffer.from(init.body) });
      state.puts.push(key);
      return json({ success: true, result: { key } });
    }
    return json({ success: false, errors: [{ message: 'unexpected' }] }, 400);
  };
  return { fetch, state };
}

const siteConfig = { name: 'site', account_id: ACCOUNT_ID };
const upload = (t, fetch, options = {}) =>
  uploadStaticAssets({
    config: siteConfig,
    staticOrigin: 'https://static.example',
    clientDir: sampleBuild(t),
    token: 'cf-token',
    fetch,
    log: () => {},
    ...options,
  });

test('each built file goes to <WORKER_NAME>-static with its type and a year of immutable caching, and nothing outside assets/ does', async (t) => {
  const r2 = fakeR2();

  await upload(t, r2.fetch);

  assert.deepEqual(r2.state.puts.sort(), [
    'assets/app-Ab12Cd34.css',
    'assets/good-first-token-launch-Ij90Kl12.mp4',
    'assets/nested/chunk-Ef56Gh78.js',
  ]);
  const css = r2.state.objects.get('assets/app-Ab12Cd34.css');
  assert.deepEqual(css.headers, {
    'content-type': 'text/css; charset=utf-8',
    'cache-control': 'public, max-age=31536000, immutable',
  });
  assert.equal(css.body.toString(), 'body{}');
  const video = r2.state.objects.get('assets/good-first-token-launch-Ij90Kl12.mp4');
  assert.equal(video.headers['content-type'], 'video/mp4');
  assert.deepEqual([...video.body], [0, 0, 0, 24, 102, 116]);
});

test('a file the bucket already has is not uploaded again, since a changed file gets a new name', async (t) => {
  const r2 = fakeR2({ objects: { 'assets/app-Ab12Cd34.css': { body: 'body{}' } } });

  await upload(t, r2.fetch);

  assert.deepEqual(r2.state.puts.sort(), ['assets/good-first-token-launch-Ij90Kl12.mp4', 'assets/nested/chunk-Ef56Gh78.js']);
});

test('with STATIC_ORIGIN empty, the Worker serves the files, so nothing is uploaded', async (t) => {
  const { fetch, calls } = fakeFetch();
  const lines = [];

  await upload(t, fetch, { staticOrigin: '', log: (line) => lines.push(line) });

  assert.equal(calls.length, 0);
  assert.match(lines.join('\n'), /STATIC_ORIGIN is not set/);
});

test('a missing bucket stops the deploy before anything is uploaded, and says how to make it', async (t) => {
  const r2 = fakeR2({ exists: false });

  await assert.rejects(upload(t, r2.fetch), /<WORKER_NAME>-static, does not exist\. Create it as docs\/self-hosting\.md describes/);
  assert.deepEqual(r2.state.puts, []);
});

test('a built file of a type the static host has no content type for stops the upload before anything goes up', async (t) => {
  const r2 = fakeR2();
  const clientDir = sampleBuild(t);
  writeFileSync(path.join(clientDir, 'assets', 'engine-Mn34Op56.wasm'), Buffer.from([0, 97, 115, 109]));

  await assert.rejects(upload(t, r2.fetch, { clientDir }), /assets\/engine-Mn34Op56\.wasm.*scripts\/serve\.mjs/);
  assert.deepEqual(r2.state.puts, []);
});

test('an upload with no built files stops the deploy', async (t) => {
  const r2 = fakeR2();

  await assert.rejects(upload(t, r2.fetch, { clientDir: tempDir(t) }), /has no files\. Build the Worker first/);
  assert.deepEqual(r2.state.puts, []);
});

// The static host as a browser sees it, serving the fake bucket's objects.
// `change` edits each answer's headers.
function fakeStaticHost(r2, change = () => {}) {
  const requests = [];
  const fetch = async (url, init = {}) => {
    const { origin, pathname } = new URL(url);
    if (origin !== 'https://static.example') return r2.fetch(url, init);
    requests.push(pathname);
    const object = r2.state.objects.get(pathname.slice(1));
    if (!object) return new Response('Not found', { status: 404 });
    const headers = new Headers({ ...object.headers, 'access-control-allow-origin': '*' });
    change(headers, pathname);
    return new Response(object.body, { headers });
  };
  return { fetch, requests };
}
const check = (t, fetch, options = {}) =>
  checkStaticHost({ staticOrigin: 'https://static.example', clientDir: sampleBuild(t), fetch, log: () => {}, ...options });

test('before the Worker goes live, the static host answers one file of each kind with its type, a year of caching, and no cookie', async (t) => {
  const r2 = fakeR2();
  await upload(t, r2.fetch);
  const host = fakeStaticHost(r2);

  await check(t, host.fetch);

  assert.deepEqual(host.requests.sort(), [
    '/assets/app-Ab12Cd34.css',
    '/assets/good-first-token-launch-Ij90Kl12.mp4',
    '/assets/nested/chunk-Ef56Gh78.js',
  ]);
});

test('a cookie from the static host stops the deploy before the Worker goes live', async (t) => {
  const r2 = fakeR2();
  await upload(t, r2.fetch);
  const host = fakeStaticHost(r2, (headers) => headers.append('set-cookie', '__cf_bm=abc; Path=/; Secure; HttpOnly'));

  await assert.rejects(check(t, host.fetch), /the Worker was not deployed[\s\S]*assets\/app-Ab12Cd34\.css set a cookie/);
});

test('a static host that lacks a file, the caching, the type, or Access-Control-Allow-Origin stops the deploy', async (t) => {
  const r2 = fakeR2();
  await upload(t, r2.fetch);
  const cases = [
    [(headers) => headers.set('cache-control', 'public, max-age=14400'), /cache-control/],
    [(headers) => headers.set('content-type', 'application/octet-stream'), /content-type/],
    [(headers) => headers.delete('access-control-allow-origin'), /access-control-allow-origin/],
  ];
  for (const [change, problem] of cases) {
    await assert.rejects(check(t, fakeStaticHost(r2, change).fetch), problem);
  }

  const empty = fakeR2();
  await assert.rejects(check(t, fakeStaticHost(empty).fetch), /answered 404/);
});

test('with STATIC_ORIGIN empty, the static host is not checked', async (t) => {
  const { fetch, calls } = fakeFetch();

  await check(t, fetch, { staticOrigin: '' });

  assert.equal(calls.length, 0);
});

test('the smoke test reads /healthz on the primary domain, or else on the workers.dev URL Wrangler reported', () => {
  assert.equal(
    smokeTestUrl({ config: { vars: { PRIMARY_DOMAIN: 'primary.example' } }, wranglerOutput: '' }),
    'https://primary.example/healthz',
  );

  const wranglerOutput = [
    JSON.stringify({ type: 'wrangler-session', version: 1 }),
    JSON.stringify({ type: 'deploy', targets: ['https://site.sample.workers.dev', 'schedule: 0 * * * *'] }),
  ].join('\n');
  assert.equal(
    smokeTestUrl({ config: { vars: { PRIMARY_DOMAIN: '' } }, wranglerOutput }),
    'https://site.sample.workers.dev/healthz',
  );

  assert.throws(() => smokeTestUrl({ config: { vars: { PRIMARY_DOMAIN: '' } }, wranglerOutput: '' }), /no URL/);
});

const healthz = (environment) => () => json({ ok: true, environment });
const noWait = async () => {};

test('the smoke test passes when /healthz reports the environment it deployed', async () => {
  const { fetch, calls } = fakeFetch(healthz('staging'));

  await smokeTest({ url: 'https://primary.example/healthz', target: 'staging', fetch, log: () => {}, wait: noWait });

  assert.equal(calls.length, 1);
});

test('the smoke test fails at once when another environment answers', async () => {
  const { fetch, calls } = fakeFetch(healthz('production'), healthz('staging'));

  await assert.rejects(
    smokeTest({ url: 'https://primary.example/healthz', target: 'staging', fetch, log: () => {}, wait: noWait }),
    /from production\. This deploy was to staging/,
  );
  assert.equal(calls.length, 1);
});

test('the smoke test retries while the Worker and its domain come up', async () => {
  const { fetch, calls } = fakeFetch(
    () => new Response('', { status: 522 }),
    () => {
      throw new TypeError('fetch failed');
    },
    healthz('production'),
  );

  await smokeTest({ url: 'https://primary.example/healthz', target: 'production', fetch, log: () => {}, wait: noWait });

  assert.equal(calls.length, 3);
});

test('the smoke test gives up when /healthz never answers ok', async () => {
  const fetch = async () => new Response('', { status: 503 });

  await assert.rejects(
    smokeTest({ url: 'https://primary.example/healthz', target: 'staging', fetch, log: () => {}, timeoutMs: 0, wait: noWait }),
    /503/,
  );
});
