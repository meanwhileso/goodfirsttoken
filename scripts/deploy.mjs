// The deploy steps that talk to Cloudflare or check the result. The deploy
// workflow runs them in order after scripts/deploy-config.mjs writes
// apps/web/wrangler.deploy.json, and each reads that file.
//
//   node scripts/deploy.mjs credential           # CLOUDFLARE_API_TOKEN for later steps
//   node scripts/deploy.mjs resources            # D1 database and queues, when missing
//   node scripts/deploy.mjs migrations           # D1 migrations, when there are any
//   node scripts/deploy.mjs secrets              # the Worker's secrets, one at a time
//   node scripts/deploy.mjs static-assets        # built files to the static host's bucket
//   node scripts/deploy.mjs smoke-test staging   # /healthz reports the right environment
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DEPLOY_CONFIG, REPO_ROOT, STATIC_BUCKET, STATIC_ORIGIN, TARGETS, staticBucketName } from './deploy-config.mjs';
import { ASSETS_DIR, CLIENT_DIR, staticObjects } from './static-host.mjs';

const API = 'https://api.cloudflare.com/client/v4';
// A token goes into $GITHUB_ENV, so it can't carry a line break or a space
// that would let it set other variables for later steps.
const TOKEN = /^[\w.~+/=-]+$/;

// Returns the Cloudflare API token for this job: the CLOUDFLARE_API_TOKEN
// secret, or a short-lived token from the credential broker, traded for the
// job's GitHub OIDC token.
export async function getCredential({ env, fetch, log }) {
  const secret = (env.CLOUDFLARE_API_TOKEN ?? '').trim();
  const broker = (env.CLOUDFLARE_CREDENTIAL_BROKER_URL ?? '').trim();
  if (secret && broker) {
    throw new Error(
      'This environment has both the CLOUDFLARE_API_TOKEN secret and the CLOUDFLARE_CREDENTIAL_BROKER_URL variable. Keep only one.',
    );
  }
  if (secret) {
    if (!TOKEN.test(secret)) throw new Error('The CLOUDFLARE_API_TOKEN secret is not a token.');
    return { token: secret, source: 'the CLOUDFLARE_API_TOKEN secret' };
  }
  if (!broker) {
    throw new Error(
      'This environment has no Cloudflare credential. Add a CLOUDFLARE_API_TOKEN secret, or set the CLOUDFLARE_CREDENTIAL_BROKER_URL variable.',
    );
  }
  if (!URL.canParse(broker) || new URL(broker).protocol !== 'https:') {
    throw new Error('CLOUDFLARE_CREDENTIAL_BROKER_URL has to be an https URL.');
  }
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Error('The job cannot get a GitHub OIDC token. The credential broker needs the id-token: write permission.');
  }

  const oidcUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  oidcUrl.searchParams.set('audience', broker);
  const oidc = await fetch(oidcUrl, { headers: { authorization: `bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } });
  if (!oidc.ok) throw new Error(`GitHub answered ${oidc.status} to the request for an OIDC token.`);
  const { value: idToken } = await oidc.json().catch(() => ({}));
  if (typeof idToken !== 'string' || !idToken) throw new Error('GitHub answered with no OIDC token.');
  log(`::add-mask::${idToken}`);

  // A redirect would carry the OIDC token to another URL, so it fails.
  const answer = await fetch(broker, {
    method: 'POST',
    headers: { authorization: `Bearer ${idToken}` },
    redirect: 'error',
  }).catch(() => {
    throw new Error('The credential broker could not be reached, or it answered with a redirect.');
  });
  if (!answer.ok) throw new Error(`The credential broker answered ${answer.status}.`);
  const body = await answer.json().catch(() => ({}));
  if (typeof body.token !== 'string' || !TOKEN.test(body.token)) {
    throw new Error('The credential broker did not answer with a token.');
  }
  return { token: body.token, source: 'the credential broker' };
}

// Gets the credential, masks it, and hands it to the job's later steps.
export async function exportCredential({ env, fetch, envFile, log }) {
  if (!envFile) throw new Error('GITHUB_ENV is not set, so there is nowhere to put the token.');
  const { token, source } = await getCredential({ env, fetch, log });
  log(`::add-mask::${token}`);
  appendFileSync(envFile, `CLOUDFLARE_API_TOKEN=${token}\n`);
  log(`Using a Cloudflare token from ${source}.`);
}

function cloudflare({ token, account, fetch }) {
  return async (method, resource, { query, body } = {}) => {
    const url = new URL(`${API}/accounts/${account}${resource}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body && { 'content-type': 'application/json' }) },
      ...(body && { body: JSON.stringify(body) }),
    });
    const json = await res.json().catch(() => ({}));
    if (method === 'GET' && res.status === 404) return null;
    if (!res.ok || !json.success) {
      const messages = (json.errors ?? []).map((error) => error.message).join(' ');
      throw new Error(`Cloudflare answered ${res.status} to ${method} ${resource.split('/')[1]}. ${messages}`.trim());
    }
    return json.result;
  };
}

// Every queue the config names: producers, consumers, and dead-letter queues.
function queueNames(config) {
  const { producers = [], consumers = [] } = config.queues ?? {};
  return [
    ...new Set([
      ...producers.map((producer) => producer.queue),
      ...consumers.flatMap((consumer) => [consumer.queue, consumer.dead_letter_queue]),
    ]),
  ].filter(Boolean);
}

// Creates the D1 databases that have no ID and the queues, when missing.
// Wrangler creates a missing producer queue on its own, but not a dead-letter
// queue. And migrations run before the deploy, so the database has to exist
// first.
export async function ensureResources({ config, token, fetch, log }) {
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is not set. Run the credential step first.');
  const api = cloudflare({ token, account: config.account_id, fetch });
  for (const db of config.d1_databases ?? []) {
    if (db.database_id) continue;
    if (await api('GET', `/d1/database/${encodeURIComponent(db.database_name)}`)) {
      log(`The D1 database for ${db.binding} exists.`);
    } else {
      await api('POST', '/d1/database', { body: { name: db.database_name } });
      log(`Created the D1 database for ${db.binding}.`);
    }
  }
  for (const queue of queueNames(config)) {
    const found = (await api('GET', '/queues', { query: { name: queue } })) ?? [];
    if (found.some((existing) => existing.queue_name === queue)) {
      log(`The queue ${queue} exists.`);
    } else {
      await api('POST', '/queues', { body: { queue_name: queue } });
      log(`Created the queue ${queue}.`);
    }
  }
}

// Applies each D1 database's migrations, from migrations_dir or Wrangler's
// default, migrations/, next to the config. A database with no migrations
// folder yet is skipped.
export function applyMigrations({ config, root, wrangler, log }) {
  for (const db of config.d1_databases ?? []) {
    const dir = path.resolve(root, path.dirname(DEPLOY_CONFIG), db.migrations_dir ?? 'migrations');
    if (!existsSync(dir)) {
      log(`No migrations for ${db.binding} yet, so there is nothing to apply.`);
      continue;
    }
    wrangler(['d1', 'migrations', 'apply', db.binding, '--remote', '--config', path.basename(DEPLOY_CONFIG)]);
  }
}

// Puts every secret the Worker declares in secrets.required, one at a time,
// each from the environment variable of the same name. Nothing is put unless
// all of them are set. A value goes to Wrangler on stdin and is never logged.
export function putSecrets({ config, env, wrangler, log }) {
  const names = config.secrets?.required ?? [];
  const missing = names.filter((name) => !env[name]);
  if (missing.length) {
    throw new Error(
      `Missing secrets: ${missing.join(', ')}. Add each to the GitHub environment, and pass it to the step that puts secrets in the deploy workflow.`,
    );
  }
  if (!names.length) log('The Worker reads no secrets yet.');
  for (const name of names) {
    wrangler(['secret', 'put', name, '--config', path.basename(DEPLOY_CONFIG)], { input: env[name], hide: names });
    log(`Put ${name}.`);
  }
}

// Uploads the files the build named after their content to the static host's
// R2 bucket, <WORKER_NAME>-static, with the headers the static host sends:
// their type, and a year of immutable caching. It runs before the Worker
// deploys, so no page links to a file the bucket doesn't have yet. A file the
// bucket already has is left alone, since a changed file gets a new name.
// With STATIC_ORIGIN empty, the Worker serves the files itself, so nothing is
// uploaded.
export async function uploadStaticAssets({ config, staticOrigin, clientDir, token, fetch, log }) {
  if (!staticOrigin) {
    log(`${STATIC_ORIGIN} is not set, so the Worker serves the built files itself.`);
    return;
  }
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is not set. Run the credential step first.');
  const objects = staticObjects(clientDir);
  if (!objects.length) throw new Error(`${CLIENT_DIR}/${ASSETS_DIR} has no files. Build the Worker first.`);

  const bucket = `/r2/buckets/${encodeURIComponent(staticBucketName(config.name))}`;
  if (!(await cloudflare({ token, account: config.account_id, fetch })('GET', bucket))) {
    throw new Error(
      `The static host's R2 bucket, <WORKER_NAME>-${STATIC_BUCKET}, does not exist. Create it as docs/self-hosting.md describes, or leave ${STATIC_ORIGIN} empty.`,
    );
  }
  const authorization = `Bearer ${token}`;
  let uploaded = 0;
  for (const object of objects) {
    const url = `${API}/accounts/${config.account_id}${bucket}/objects/${object.key.split('/').map(encodeURIComponent).join('/')}`;
    const found = await fetch(url, { headers: { authorization } });
    // Only the answer's status matters, so the file itself is not downloaded.
    await found.body?.cancel();
    if (found.ok) continue;
    if (found.status !== 404) throw new Error(`Cloudflare answered ${found.status} when asked for ${object.key}.`);
    const put = await fetch(url, {
      method: 'PUT',
      headers: { authorization, ...object.headers },
      body: readFileSync(object.file),
    });
    await put.body?.cancel();
    if (!put.ok) throw new Error(`Cloudflare answered ${put.status} to the upload of ${object.key}.`);
    uploaded += 1;
  }
  log(`Uploaded ${uploaded} new files to the static host. ${objects.length - uploaded} were there already.`);
}

// The Worker's /healthz URL: on the primary domain, or else the workers.dev
// URL Wrangler reported when it deployed.
export function smokeTestUrl({ config, wranglerOutput }) {
  const domain = config.vars?.PRIMARY_DOMAIN;
  if (domain) return `https://${domain}/healthz`;
  const deploy = (wranglerOutput ?? '')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .findLast((entry) => entry.type === 'deploy');
  const url = deploy?.targets?.find((target) => /^https:\/\/\S+$/.test(target));
  if (!url) throw new Error('PRIMARY_DOMAIN is not set, and Wrangler reported no URL for the Worker.');
  return new URL('/healthz', url).href;
}

// Checks that /healthz answers ok and names the environment the deploy meant
// to reach. It retries while the Worker or its domain comes up, and fails at
// once if another environment answers.
export async function smokeTest({ url, target, fetch, log, timeoutMs = 180_000, intervalMs = 5_000, wait = sleep }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let status;
    try {
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
      const body = res.status === 200 ? await res.json().catch(() => null) : null;
      if (body?.ok === true && body.environment === target) {
        log(`/healthz answered ok from ${target}.`);
        return;
      }
      if (body?.ok === true) {
        throw new WrongEnvironment(`/healthz answered from ${String(body.environment)}. This deploy was to ${target}.`);
      }
      status = `answered ${res.status}`;
    } catch (error) {
      if (error instanceof WrongEnvironment) throw error;
      status = `failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (Date.now() + intervalMs > deadline) {
      throw new Error(`/healthz ${status}, and did not answer ok within ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    log(`/healthz ${status}. Trying again in ${Math.round(intervalMs / 1000)} seconds.`);
    await wait(intervalMs);
  }
}

class WrongEnvironment extends Error {}

function readDeployConfig(root) {
  const file = path.join(root, DEPLOY_CONFIG);
  if (!existsSync(file)) throw new Error(`${DEPLOY_CONFIG} is missing. Run scripts/deploy-config.mjs first.`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

// Runs Wrangler from apps/web. The variables named in `hide` are left out of
// its environment, so a secret's value reaches Wrangler only on stdin.
export function wranglerIn(root, baseEnv = process.env) {
  const cwd = path.join(root, path.dirname(DEPLOY_CONFIG));
  return (args, { input, hide = [] } = {}) => {
    const env = Object.fromEntries(Object.entries(baseEnv).filter(([name]) => !hide.includes(name)));
    const result = spawnSync(path.join(cwd, 'node_modules', '.bin', 'wrangler'), args, {
      cwd,
      env,
      input,
      stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`wrangler ${args.slice(0, 2).join(' ')} failed.`);
  };
}

async function main([step, target]) {
  const root = REPO_ROOT;
  const log = console.log;
  const env = process.env;
  switch (step) {
    case 'credential':
      return exportCredential({ env, fetch, envFile: env.GITHUB_ENV, log });
    case 'resources':
      return ensureResources({ config: readDeployConfig(root), token: env.CLOUDFLARE_API_TOKEN, fetch, log });
    case 'migrations':
      return applyMigrations({ config: readDeployConfig(root), root, wrangler: wranglerIn(root), log });
    case 'secrets':
      return putSecrets({ config: readDeployConfig(root), env, wrangler: wranglerIn(root), log });
    case 'static-assets':
      return uploadStaticAssets({
        config: readDeployConfig(root),
        staticOrigin: (env[STATIC_ORIGIN] ?? '').trim(),
        clientDir: path.join(root, CLIENT_DIR),
        token: env.CLOUDFLARE_API_TOKEN,
        fetch,
        log,
      });
    case 'smoke-test': {
      if (!TARGETS.includes(target)) throw new Error('Name the environment to check: staging or production.');
      const output = env.WRANGLER_OUTPUT_FILE_PATH;
      const wranglerOutput = output && existsSync(output) ? readFileSync(output, 'utf8') : '';
      const url = smokeTestUrl({ config: readDeployConfig(root), wranglerOutput });
      return smokeTest({ url, target, fetch, log });
    }
    default:
      throw new Error('Name a step: credential, resources, migrations, secrets, static-assets, or smoke-test.');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
