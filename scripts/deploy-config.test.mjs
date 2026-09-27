import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  DEPLOY_CONFIG,
  LOCAL_CONFIG,
  REPO_ROOT,
  deployConfig,
  readLocalConfig,
  settingsFor,
  writeDeployConfig,
} from './deploy-config.mjs';

// Sample IDs are built at run time, so no ID-shaped string sits in this file
// for the leak scan to flag.
const ACCOUNT_ID = 'a1'.repeat(16);
const KV_ID = 'b2'.repeat(16);
const D1_ID = [8, 4, 4, 4, 12].map((n) => 'd'.repeat(n)).join('-');

const required = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, WORKER_NAME: 'sample-site' };

// A local config with one of each kind of binding the script fills in.
const local = {
  name: 'web',
  main: 'src/server.ts',
  compatibility_date: '2026-08-15',
  vars: { ENVIRONMENT: 'development', PRIMARY_DOMAIN: '', REDIRECT_DOMAINS: '', FAKE_GITHUB_URL: 'http://localhost:9999' },
  d1_databases: [{ binding: 'DB', database_name: 'db', migrations_dir: 'migrations' }],
  kv_namespaces: [{ binding: 'OAUTH_KV' }],
  queues: {
    producers: [{ binding: 'FEED_QUEUE', queue: 'feed' }],
    consumers: [{ queue: 'feed', max_retries: 3, dead_letter_queue: 'feed-dlq' }],
  },
  ratelimits: [{ name: 'LOGIN_LIMITER', namespace_id: '1', simple: { limit: 10, period: 60 } }],
};
const withLimiter = { ...required, LOGIN_LIMITER_NAMESPACE_ID: '1001' };

const realLocal = () => readLocalConfig(readFileSync(path.join(REPO_ROOT, LOCAL_CONFIG), 'utf8'));

test('every resource is named after WORKER_NAME, with its local name after a dash', () => {
  const { config } = deployConfig(local, 'production', withLimiter);

  assert.equal(config.name, 'sample-site');
  assert.equal(config.account_id, ACCOUNT_ID);
  assert.equal(config.d1_databases[0].database_name, 'sample-site-db');
  assert.equal(config.queues.producers[0].queue, 'sample-site-feed');
  assert.equal(config.queues.consumers[0].queue, 'sample-site-feed');
  assert.equal(config.queues.consumers[0].dead_letter_queue, 'sample-site-feed-dlq');
  assert.equal(config.queues.consumers[0].max_retries, 3);
  assert.equal(config.d1_databases[0].migrations_dir, 'migrations');
});

test('an ID left empty is left out, so Wrangler can provision the resource', () => {
  const empty = deployConfig(local, 'staging', withLimiter).config;
  assert.equal('database_id' in empty.d1_databases[0], false);
  assert.equal('id' in empty.kv_namespaces[0], false);

  const set = deployConfig(local, 'staging', { ...withLimiter, DB_ID: D1_ID, OAUTH_KV_ID: KV_ID }).config;
  assert.equal(set.d1_databases[0].database_id, D1_ID);
  assert.equal(set.kv_namespaces[0].id, KV_ID);
});

test('the Worker reports the environment it was deployed as, whatever the settings say', () => {
  for (const target of ['staging', 'production']) {
    const { config } = deployConfig(local, target, { ...withLimiter, ENVIRONMENT: 'development' });
    assert.equal(config.vars.ENVIRONMENT, target);
  }
  assert.throws(() => deployConfig(local, 'development', withLimiter), /staging or production/);
});

test('no local value of a variable reaches a deployed Worker', () => {
  const unset = deployConfig(local, 'production', withLimiter).config;
  assert.equal(unset.vars.FAKE_GITHUB_URL, '');

  const set = deployConfig(local, 'production', { ...withLimiter, FAKE_GITHUB_URL: 'https://api.github.com' }).config;
  assert.equal(set.vars.FAKE_GITHUB_URL, 'https://api.github.com');
});

test('ADMIN_GITHUB_IDS takes numeric GitHub IDs separated by commas', () => {
  const withAdmins = { ...local, vars: { ...local.vars, ADMIN_GITHUB_IDS: '' } };

  const { config } = deployConfig(withAdmins, 'production', { ...withLimiter, ADMIN_GITHUB_IDS: ' 583231, 9919 ' });
  assert.equal(config.vars.ADMIN_GITHUB_IDS, '583231,9919');

  for (const bad of ['octocat', '583231,octocat', '12.5', '-1']) {
    assert.throws(
      () => deployConfig(withAdmins, 'production', { ...withLimiter, ADMIN_GITHUB_IDS: bad }),
      /ADMIN_GITHUB_IDS/,
      bad,
    );
  }
});

test('a primary domain serves the site there, turns workers.dev off, and attaches every redirect domain', () => {
  const { config } = deployConfig(local, 'production', {
    ...withLimiter,
    PRIMARY_DOMAIN: 'Primary.Example.',
    REDIRECT_DOMAINS: 'second.example, www.primary.example',
  });

  assert.equal(config.workers_dev, false);
  assert.deepEqual(config.routes, [
    { pattern: 'primary.example', custom_domain: true },
    { pattern: 'second.example', custom_domain: true },
    { pattern: 'www.primary.example', custom_domain: true },
  ]);
  assert.equal(config.vars.PRIMARY_DOMAIN, 'primary.example');
  assert.equal(config.vars.REDIRECT_DOMAINS, 'second.example,www.primary.example');
});

test('without a primary domain, the site is served on workers.dev', () => {
  const { config } = deployConfig(local, 'staging', withLimiter);

  assert.equal(config.workers_dev, true);
  assert.equal('routes' in config, false);
  assert.equal(config.vars.PRIMARY_DOMAIN, '');
});

test('missing and malformed settings stop the deploy, with every one listed', () => {
  assert.throws(
    () => deployConfig(local, 'staging', {}),
    (error) =>
      /CLOUDFLARE_ACCOUNT_ID is not set/.test(error.message) &&
      /WORKER_NAME is not set/.test(error.message) &&
      /LOGIN_LIMITER_NAMESPACE_ID is not set/.test(error.message),
  );
  assert.throws(
    () =>
      deployConfig(local, 'staging', {
        CLOUDFLARE_ACCOUNT_ID: 'my-account',
        WORKER_NAME: 'Sample Site',
        DB_ID: 'db',
        OAUTH_KV_ID: D1_ID,
        LOGIN_LIMITER_NAMESPACE_ID: 'ten',
        PRIMARY_DOMAIN: 'https://primary.example/',
      }),
    (error) =>
      ['CLOUDFLARE_ACCOUNT_ID', 'WORKER_NAME', 'DB_ID', 'OAUTH_KV_ID', 'LOGIN_LIMITER_NAMESPACE_ID', 'PRIMARY_DOMAIN'].every(
        (name) => error.message.includes(`${name} is not`),
      ),
  );
});

test('redirect domains need a primary domain, and cannot include it', () => {
  assert.throws(
    () => deployConfig(local, 'production', { ...withLimiter, REDIRECT_DOMAINS: 'second.example' }),
    /PRIMARY_DOMAIN has to be/,
  );
  assert.throws(
    () =>
      deployConfig(local, 'production', {
        ...withLimiter,
        PRIMARY_DOMAIN: 'primary.example',
        REDIRECT_DOMAINS: 'second.example,primary.example',
      }),
    /includes PRIMARY_DOMAIN/,
  );
});

test('a binding the script does not know stops the deploy, so no local name reaches Cloudflare', () => {
  const withBucket = { ...local, r2_buckets: [{ binding: 'STATIC', bucket_name: 'static' }] };
  assert.throws(() => deployConfig(withBucket, 'staging', withLimiter), /"r2_buckets", which scripts\/deploy-config.mjs does not deploy yet/);

  const withOtherWorker = {
    ...local,
    durable_objects: { bindings: [{ name: 'ROOM', class_name: 'Room', script_name: 'rooms' }] },
  };
  assert.throws(() => deployConfig(withOtherWorker, 'staging', withLimiter), /another Worker/);
});

test('the local config may not carry an account, a route, or a resource ID', () => {
  for (const bad of [
    { ...local, account_id: 'x' },
    { ...local, routes: [{ pattern: 'primary.example', custom_domain: true }] },
    { ...local, d1_databases: [{ binding: 'DB', database_name: 'db', database_id: 'x' }] },
    { ...local, kv_namespaces: [{ binding: 'OAUTH_KV', id: 'x' }] },
  ]) {
    assert.throws(() => deployConfig(bad, 'staging', withLimiter), /wrangler\.jsonc/);
  }
});

test('a variable whose name GitHub reserves is refused, since no setting could hold it', () => {
  const reserved = { ...local, vars: { ...local.vars, GITHUB_CLIENT_ID: '' } };

  assert.throws(() => settingsFor(reserved), /can't start with GITHUB_/);
});

test('the config script reads no setting beyond the ones it lists', () => {
  for (const config of [local, realLocal()]) {
    const read = new Set();
    const env = new Proxy(
      { ...withLimiter, PRIMARY_DOMAIN: 'primary.example', REDIRECT_DOMAINS: 'second.example' },
      {
        get(target, name) {
          read.add(name);
          return Reflect.get(target, name);
        },
      },
    );
    deployConfig(config, 'staging', env);
    assert.deepEqual([...read].sort(), settingsFor(config).map((s) => s.name).sort());
  }
});

// A throwaway git repo with this repo's .gitignore, local config, and a
// tracked README. It is deleted when the test ends.
function sampleRepo(t, { gitignore = readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8') } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'deploy-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'apps', 'web'), { recursive: true });
  copyFileSync(path.join(REPO_ROOT, LOCAL_CONFIG), path.join(root, LOCAL_CONFIG));
  writeFileSync(path.join(root, '.gitignore'), gitignore);
  writeFileSync(path.join(root, 'README.md'), '# sample\n');
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', '--all'], { cwd: root });
  return root;
}

const sentinels = {
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
  WORKER_NAME: 'sentinel-worker',
  DB_ID: D1_ID,
  OAUTH_KV_ID: KV_ID,
  PRIMARY_DOMAIN: 'sentinel-primary.example',
  REDIRECT_DOMAINS: 'sentinel-second.example',
  OAUTH_CLIENT_ID: 'Ov23sentinelclient',
  ADMIN_GITHUB_IDS: '5550001,5550002',
  GH_API_URL: 'https://sentinel-api.example/api',
  GH_WEB_URL: 'https://sentinel-web.example',
};

test('no ID or deployed name is written to a file git tracks or would add', (t) => {
  const root = sampleRepo(t);
  writeDeployConfig({ root, target: 'production', env: sentinels, log: () => {} });

  const written = readFileSync(path.join(root, DEPLOY_CONFIG), 'utf8');
  const values = [...Object.values(sentinels), 'sentinel-worker-db', 'sentinel-worker-feed'];
  for (const value of values) assert.ok(written.includes(value), `${value} is in the deploy config`);

  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root })
    .toString()
    .split('\0')
    .filter(Boolean);
  assert.ok(files.includes(LOCAL_CONFIG));
  for (const file of files) {
    const text = readFileSync(path.join(root, file), 'utf8');
    for (const value of values) assert.ok(!text.includes(value), `${file} holds ${value}`);
  }
});

test("a deploy's GitHub URLs come from the settings or are empty, and never from the local GitHub fake", (t) => {
  const root = sampleRepo(t);
  const written = (env) => {
    writeDeployConfig({ root, target: 'production', env, log: () => {} });
    return readFileSync(path.join(root, DEPLOY_CONFIG), 'utf8');
  };
  // The local config points both at the GitHub fake on this machine.
  assert.match(realLocal().vars.GH_API_URL, /127\.0\.0\.1/);
  assert.match(realLocal().vars.GH_WEB_URL, /127\.0\.0\.1/);

  const unset = written({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, WORKER_NAME: 'sentinel-worker' });
  const set = written(sentinels);

  assert.equal(JSON.parse(unset).vars.GH_API_URL, '');
  assert.equal(JSON.parse(unset).vars.GH_WEB_URL, '');
  assert.equal(JSON.parse(set).vars.GH_API_URL, sentinels.GH_API_URL);
  assert.equal(JSON.parse(set).vars.GH_WEB_URL, sentinels.GH_WEB_URL);
  for (const text of [unset, set]) assert.ok(!text.includes('127.0.0.1'), 'the deploy config names the local fake');
});

test('a GitHub URL setting has to be an https URL, so a deploy never points at a machine of its own', () => {
  const withGitHub = { ...local, vars: { ...local.vars, GH_API_URL: '', GH_WEB_URL: '' } };

  const { config } = deployConfig(withGitHub, 'production', { ...withLimiter, GH_API_URL: 'https://api.github.com/' });
  assert.equal(config.vars.GH_API_URL, 'https://api.github.com');

  for (const name of ['GH_API_URL', 'GH_WEB_URL']) {
    for (const bad of ['http://127.0.0.1:8944/api', 'api.github.com', 'https://', 'https://api.github.com?x=1']) {
      assert.throws(() => deployConfig(withGitHub, 'production', { ...withLimiter, [name]: bad }), new RegExp(name), bad);
    }
  }
});

test('the deploy config is not written where git would track it', (t) => {
  const root = sampleRepo(t, { gitignore: 'node_modules/\n' });

  assert.throws(
    () => writeDeployConfig({ root, target: 'production', env: sentinels, log: () => {} }),
    /git has to ignore/,
  );
  assert.equal(existsSync(path.join(root, DEPLOY_CONFIG)), false);
});

test('a symlink in place of the deploy config is refused, so nothing is written through it to a tracked file', (t) => {
  const root = sampleRepo(t);
  symlinkSync('../../README.md', path.join(root, DEPLOY_CONFIG));

  assert.throws(
    () => writeDeployConfig({ root, target: 'production', env: sentinels, log: () => {} }),
    /symlink/,
  );
  assert.equal(readFileSync(path.join(root, 'README.md'), 'utf8'), '# sample\n');
});

test('in GitHub Actions, every setting the Worker gets is masked before any line could print it', (t) => {
  const root = sampleRepo(t);
  const lines = [];
  writeDeployConfig({ root, target: 'staging', env: { ...sentinels, GITHUB_ACTIONS: 'true' }, log: (line) => lines.push(line) });

  const masks = lines.filter((line) => line.startsWith('::add-mask::')).map((line) => line.slice('::add-mask::'.length));
  const values = [
    ...Object.values(sentinels),
    '5550001',
    '5550002',
    'sentinel-worker-db',
    'sentinel-worker-feed',
    'sentinel-worker-crawl',
  ];
  for (const value of values) assert.ok(masks.includes(value), `${value} is masked`);
  const firstOther = lines.findIndex((line) => !line.startsWith('::add-mask::'));
  assert.equal(firstOther, masks.length, 'the masks come first');
  for (const line of lines.slice(firstOther)) {
    for (const value of values) assert.ok(!line.includes(value), `"${line}" shows ${value}`);
  }
});
