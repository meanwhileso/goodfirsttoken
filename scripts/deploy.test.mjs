import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  applyMigrations,
  ensureResources,
  exportCredential,
  getCredential,
  putSecrets,
  smokeTest,
  smokeTestUrl,
  wranglerIn,
} from './deploy.mjs';

const ACCOUNT_ID = 'a1'.repeat(16);
const BROKER = 'https://broker.example/cloudflare';
const OIDC_URL = 'https://oidc.example/token?api-version=2.0';

// A fetch that answers from a list of handlers in order and records each call.
function fakeFetch(...handlers) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    const handler = handlers[calls.length - 1];
    if (!handler) throw new Error(`unexpected request to ${String(url)}`);
    return handler(String(url), init);
  };
  return { fetch, calls };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

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

  const { token } = await getCredential({ env: brokerEnv, fetch });

  assert.equal(token, 'short-lived');
  const oidc = new URL(calls[0].url);
  assert.equal(oidc.searchParams.get('audience'), BROKER);
  assert.equal(oidc.searchParams.get('api-version'), '2.0');
  assert.equal(calls[0].headers.authorization, 'bearer request-token');
  assert.equal(calls[1].url, BROKER);
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].headers.authorization, 'Bearer github-oidc-jwt');
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
    await assert.rejects(getCredential({ env: brokerEnv, fetch: fakeFetch(oidc, answer).fetch }), /credential broker/);
  }
});

test('the token is masked first, then handed to later steps through GITHUB_ENV', async () => {
  const envFile = path.join(mkdtempSync(path.join(tmpdir(), 'deploy-')), 'github-env');
  writeFileSync(envFile, '');
  const lines = [];
  const { fetch } = fakeFetch(
    () => json({ value: 'github-oidc-jwt' }),
    () => json({ token: 'short-lived' }),
  );

  await exportCredential({ env: brokerEnv, fetch, envFile, log: (line) => lines.push(line) });

  assert.equal(lines[0], '::add-mask::short-lived');
  assert.ok(lines.slice(1).every((line) => !line.includes('short-lived')));
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
function sampleRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'deploy-'));
  mkdirSync(path.join(root, 'apps', 'web'), { recursive: true });
  return root;
}

test('migrations are applied for each database that has a migrations folder', () => {
  const root = sampleRoot();
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

test('a database with no migrations folder yet is skipped, so deploys work before the first migration', () => {
  const runs = [];
  const lines = [];

  applyMigrations({
    config: { d1_databases: [{ binding: 'DB', database_name: 'site-db' }] },
    root: sampleRoot(),
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

test('each secret the Worker declares is put one at a time, its value only on stdin', () => {
  const root = sampleRoot();
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
