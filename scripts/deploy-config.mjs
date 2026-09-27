// Writes the Wrangler config for a staging or production deploy.
//
// apps/web/wrangler.jsonc is the local development config. This script reads
// it and fills in what a deploy needs from the environment: the account, the
// Worker's name, resource names and IDs, domains, and the Worker's variables.
// It writes the result to apps/web/wrangler.deploy.json, which git ignores,
// because names of deployed resources and IDs never go in a tracked file.
// docs/self-hosting.md lists every setting it reads.
//
//   node scripts/deploy-config.mjs staging
import { spawnSync } from 'node:child_process';
import { closeSync, constants, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LOCAL_CONFIG = 'apps/web/wrangler.jsonc';
export const DEPLOY_CONFIG = 'apps/web/wrangler.deploy.json';
export const TARGETS = ['staging', 'production'];

// Keys of the local config that hold nothing deployment-specific, copied as
// they are. Keys the script fills in are handled below. Any other key stops
// the deploy, so a new kind of binding never reaches Cloudflare with its
// local name.
const COPIED = new Set([
  'main',
  'compatibility_date',
  'compatibility_flags',
  'durable_objects',
  'migrations',
  'triggers',
  'observability',
  'limits',
  'placement',
  'upload_source_maps',
  'secrets',
  'assets',
]);
const FILLED = new Set(['name', 'vars', 'd1_databases', 'kv_namespaces', 'queues', 'ratelimits']);
const LOCAL_ONLY = new Set(['$schema', 'dev']);
const DEPLOYMENT_ONLY = new Set(['account_id', 'routes', 'route', 'workers_dev', 'preview_urls', 'env']);

// Settings that are also the Worker's variables, which the script checks and
// attaches to the Worker as custom domains.
const DOMAIN_VARS = ['PRIMARY_DOMAIN', 'REDIRECT_DOMAINS'];

const ACCOUNT_ID = /^[0-9a-f]{32}$/i;
const KV_ID = /^[0-9a-f]{32}$/i;
const D1_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAMESPACE_ID = /^[1-9][0-9]*$/;
const GITHUB_ID = /^[1-9][0-9]*$/;
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SETTING_NAME = /^[A-Z_][A-Z0-9_]*$/;

export function readLocalConfig(text) {
  const { config, error } = ts.parseConfigFileTextToJson(LOCAL_CONFIG, text);
  if (error) {
    throw new Error(`${LOCAL_CONFIG} is not valid JSONC: ${ts.flattenDiagnosticMessageText(error.messageText, ' ')}`);
  }
  return config;
}

// Every setting the deploy config reads from the environment, for the given
// local config. Each is a GitHub environment variable or secret of the same
// name.
export function settingsFor(local) {
  const settings = [
    { name: 'CLOUDFLARE_ACCOUNT_ID', required: true },
    { name: 'WORKER_NAME', required: true },
    ...(local.d1_databases ?? []).map((db) => ({ name: `${db.binding}_ID`, required: false })),
    ...(local.kv_namespaces ?? []).map((kv) => ({ name: `${kv.binding}_ID`, required: false })),
    ...(local.ratelimits ?? []).map((limiter) => ({ name: `${limiter.name}_NAMESPACE_ID`, required: true })),
    ...DOMAIN_VARS.map((name) => ({ name, required: false })),
    ...Object.keys(local.vars ?? {})
      .filter((name) => name !== 'ENVIRONMENT' && !DOMAIN_VARS.includes(name))
      .map((name) => ({ name, required: false })),
  ];
  const seen = new Set();
  for (const { name } of settings) {
    if (!SETTING_NAME.test(name) || name.startsWith('GITHUB_')) {
      throw new Error(`${name} can't be a GitHub setting. Names use A to Z, digits, and _, and can't start with GITHUB_.`);
    }
    if (seen.has(name)) throw new Error(`Two parts of ${LOCAL_CONFIG} read the setting ${name}. Rename one.`);
    seen.add(name);
  }
  return settings;
}

// Returns the deploy config for the target, and every deployment-specific
// value in it (account, names, IDs, domains) so the caller can mask them in
// logs. Throws with every missing or malformed setting listed.
export function deployConfig(local, target, env) {
  if (!TARGETS.includes(target)) throw new Error(`The target has to be staging or production. It was "${target}".`);
  checkLocalConfig(local);
  settingsFor(local);

  const problems = [];
  const masked = new Set();
  const mask = (value) => {
    if (value) masked.add(value);
    return value;
  };
  const read = (name) => (env[name] ?? '').trim();
  const valid = (name, pattern, what, { required = false, normalize = (value) => value } = {}) => {
    const value = normalize(read(name));
    if (!value) {
      if (required) problems.push(`${name} is not set. It is ${what}.`);
      return '';
    }
    if (!pattern.test(value)) problems.push(`${name} is not ${what}.`);
    return mask(value);
  };

  const account = valid('CLOUDFLARE_ACCOUNT_ID', ACCOUNT_ID, 'a Cloudflare account ID, 32 hex characters', {
    required: true,
  });
  const worker = valid('WORKER_NAME', WORKER_NAME, 'a Worker name: lowercase letters, digits, and dashes', {
    required: true,
  });
  // Every other resource is named after the Worker, with its local name after
  // a dash, so one setting names them all.
  const named = (local) => mask(`${worker}-${local}`);

  const primary = valid('PRIMARY_DOMAIN', DOMAIN, 'a domain name, like example.org', { normalize: domainName });
  const redirects = [...new Set(read('REDIRECT_DOMAINS').split(/[\s,]+/).map(domainName).filter(Boolean))];
  for (const domain of redirects) {
    if (DOMAIN.test(domain)) mask(domain);
    else problems.push(`REDIRECT_DOMAINS has "${domain}", which is not a domain name.`);
  }
  if (redirects.length && !primary) problems.push('REDIRECT_DOMAINS is set, so PRIMARY_DOMAIN has to be too.');
  if (primary && redirects.includes(primary)) problems.push('REDIRECT_DOMAINS includes PRIMARY_DOMAIN.');

  const config = { name: worker, account_id: account };
  for (const [key, value] of Object.entries(local)) {
    if (COPIED.has(key)) config[key] = value;
  }
  // With a domain, the site is served there and nowhere else.
  config.workers_dev = !primary;
  config.preview_urls = false;
  if (primary) {
    config.routes = [primary, ...redirects].map((pattern) => ({ pattern, custom_domain: true }));
  }

  // ENVIRONMENT names the target. Every other variable takes its value from
  // the setting of the same name, so no local value reaches a deployed Worker.
  // Wrangler prints each value when it deploys, so each one is masked.
  config.vars = { ENVIRONMENT: target, PRIMARY_DOMAIN: primary, REDIRECT_DOMAINS: redirects.join(',') };
  for (const name of Object.keys(local.vars ?? {})) {
    if (name in config.vars) continue;
    if (name === 'ADMIN_GITHUB_IDS') {
      const ids = read(name).split(/[\s,]+/).filter(Boolean);
      for (const id of ids) {
        if (GITHUB_ID.test(id)) mask(id);
        else problems.push(`ADMIN_GITHUB_IDS has "${id}", which is not a numeric GitHub ID.`);
      }
      config.vars[name] = mask(ids.join(','));
    } else {
      config.vars[name] = mask(read(name));
    }
  }

  if (local.d1_databases) {
    config.d1_databases = local.d1_databases.map((db) => {
      const id = valid(`${db.binding}_ID`, D1_ID, 'a D1 database ID, a UUID');
      return { ...db, database_name: named(db.database_name), ...(id && { database_id: id }) };
    });
  }
  if (local.kv_namespaces) {
    config.kv_namespaces = local.kv_namespaces.map(({ binding }) => {
      const id = valid(`${binding}_ID`, KV_ID, 'a KV namespace ID, 32 hex characters');
      return { binding, ...(id && { id }) };
    });
  }
  if (local.queues) {
    config.queues = {
      ...local.queues,
      ...(local.queues.producers && {
        producers: local.queues.producers.map((producer) => ({ ...producer, queue: named(producer.queue) })),
      }),
      ...(local.queues.consumers && {
        consumers: local.queues.consumers.map((consumer) => ({
          ...consumer,
          queue: named(consumer.queue),
          ...(consumer.dead_letter_queue && { dead_letter_queue: named(consumer.dead_letter_queue) }),
        })),
      }),
    };
  }
  if (local.ratelimits) {
    config.ratelimits = local.ratelimits.map((limiter) => ({
      ...limiter,
      namespace_id: valid(`${limiter.name}_NAMESPACE_ID`, NAMESPACE_ID, 'a rate limit namespace ID, a whole number', {
        required: true,
      }),
    }));
  }

  if (problems.length) {
    throw new Error(`The ${target} settings need fixing:\n${problems.map((p) => `- ${p}`).join('\n')}`);
  }
  return { config, masked: [...masked] };
}

// Domains compare in lowercase, without the root's trailing dot.
function domainName(value) {
  return value.toLowerCase().replace(/\.$/, '');
}

// The local config holds local names and nothing that belongs to a
// deployment. Anything else is a mistake to fix before deploying.
function checkLocalConfig(local) {
  for (const key of Object.keys(local)) {
    if (DEPLOYMENT_ONLY.has(key)) {
      throw new Error(`${LOCAL_CONFIG} sets "${key}". Deployment values come from the environment.`);
    }
    if (!COPIED.has(key) && !FILLED.has(key) && !LOCAL_ONLY.has(key)) {
      throw new Error(
        `${LOCAL_CONFIG} sets "${key}", which scripts/deploy-config.mjs does not deploy yet. ` +
          'Teach it what to fill in, and list any new setting in docs/self-hosting.md.',
      );
    }
  }
  for (const db of local.d1_databases ?? []) {
    if (!db.database_name) throw new Error(`${LOCAL_CONFIG} gives the D1 binding ${db.binding} no database_name.`);
    if (db.database_id || db.preview_database_id) {
      throw new Error(`${LOCAL_CONFIG} gives the D1 binding ${db.binding} an ID. IDs come from the environment.`);
    }
  }
  for (const kv of local.kv_namespaces ?? []) {
    if (kv.id || kv.preview_id) {
      throw new Error(`${LOCAL_CONFIG} gives the KV binding ${kv.binding} an ID. IDs come from the environment.`);
    }
  }
  const queues = [...(local.queues?.producers ?? []), ...(local.queues?.consumers ?? [])];
  for (const queue of queues) {
    if (!queue.queue) throw new Error(`${LOCAL_CONFIG} has a queue binding with no queue name.`);
  }
  for (const binding of local.durable_objects?.bindings ?? []) {
    if (binding.script_name) {
      throw new Error(
        `${LOCAL_CONFIG} binds ${binding.name} to a Durable Object in another Worker, which scripts/deploy-config.mjs does not deploy yet.`,
      );
    }
  }
}

function gitIgnores(root, file) {
  return spawnSync('git', ['check-ignore', '--quiet', '--', file], { cwd: root }).status === 0;
}

export function writeDeployConfig({ target, env = process.env, root = REPO_ROOT, log = console.log }) {
  const local = readLocalConfig(readFileSync(path.join(root, LOCAL_CONFIG), 'utf8'));
  const { config, masked } = deployConfig(local, target, env);
  const out = path.join(root, DEPLOY_CONFIG);
  if (!gitIgnores(root, out)) {
    throw new Error(`git has to ignore ${DEPLOY_CONFIG}, because it holds deployed names and IDs. Add it to .gitignore.`);
  }
  // A symlink here would carry the config into whatever file it points to,
  // tracked or not.
  const notAFile = new Error(`${DEPLOY_CONFIG} is a symlink or a folder. Delete it and run the deploy again.`);
  if (lstatSync(out, { throwIfNoEntry: false })?.isFile() === false) throw notAFile;
  // Mask before anything else can print a value. Later steps' logs, including
  // Wrangler's, then show *** in its place.
  if (env.GITHUB_ACTIONS === 'true') {
    for (const value of masked) log(`::add-mask::${value}`);
  }
  // O_NOFOLLOW also refuses a symlink made after the check above.
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
  let fd;
  try {
    fd = openSync(out, flags, 0o600);
  } catch (error) {
    throw error?.code === 'ELOOP' ? notAFile : error;
  }
  try {
    writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  log(`Wrote ${DEPLOY_CONFIG} for ${target}.`);
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    writeDeployConfig({ target: process.argv[2] });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
