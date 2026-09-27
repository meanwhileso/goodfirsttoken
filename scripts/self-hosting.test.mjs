// Keeps the deploy scripts, the deploy workflows, and docs/self-hosting.md in
// agreement, so a self-hoster who follows the guide sets every setting the
// deploy reads.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { LOCAL_CONFIG, REPO_ROOT, readLocalConfig, settingsFor } from './deploy-config.mjs';

const read = (file) => readFileSync(path.join(REPO_ROOT, file), 'utf8');
const WORKFLOWS = ['.github/workflows/deploy.yml', '.github/workflows/deploy-environment.yml'];

// The workflow text without its YAML comments.
const workflow = WORKFLOWS.map((file) =>
  read(file)
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .join('\n'),
).join('\n');
const local = readLocalConfig(read(LOCAL_CONFIG));

test('the deploy workflow passes every setting and secret the deploy reads, under its own name', () => {
  for (const { name } of settingsFor(local)) {
    const line = `${name}: \${{ secrets.${name} || vars.${name} }}`;
    assert.ok(workflow.includes(line), `the config step passes ${name} as a variable or a secret`);
  }
  for (const name of local.secrets?.required ?? []) {
    const line = `${name}: \${{ secrets.${name} }}`;
    assert.ok(workflow.includes(line), `the secrets step passes ${name}`);
  }
});

test('docs/self-hosting.md lists every setting the deploy workflows read, and no others', () => {
  const readByWorkflows = new Set([...workflow.matchAll(/\b(?:secrets|vars)\.([A-Za-z_]\w*)/g)].map((m) => m[1]));
  const inGuide = new Set(
    [...read('docs/self-hosting.md').matchAll(/^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/gm)].map((m) => m[1]),
  );

  assert.deepEqual([...inGuide].sort(), [...readByWorkflows].sort());
});

test('staging and production deploys each stay off until their repository variable is true', () => {
  // deploy.yml split at each name indented two spaces, which includes every
  // job.
  const jobs = Object.fromEntries(
    read('.github/workflows/deploy.yml')
      .split(/\n(?= {2}\w[\w-]*:\n)/)
      .slice(1)
      .map((block) => [block.match(/^ {2}([\w-]+):/)[1], block]),
  );
  const condition = (job) => jobs[job]?.match(/^ {4}if: (.*)$/m)?.[1] ?? '';

  assert.match(condition('staging'), /vars\.DEPLOY_STAGING == 'true'/);
  assert.match(condition('production'), /vars\.DEPLOY_PRODUCTION == 'true'/);
  assert.match(jobs.production, /^ {4}needs: staging$/m);
});

test('the build and the upload read the same STATIC_ORIGIN, and a static host that fails its check stops the deploy before anything else changes', () => {
  // The deploy job's steps, in order, without YAML comments.
  const steps = read('.github/workflows/deploy-environment.yml')
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .join('\n')
    .split(/\n(?= {6}- )/)
    .slice(1);
  const step = (run) => steps.findIndex((text) => text.includes(`run: ${run}`));
  const build = step('pnpm --filter @goodfirsttoken/web build');
  const credential = step('node scripts/deploy.mjs credential');
  const upload = step('node scripts/deploy.mjs static-assets');
  // Each step that changes the environment: resources, migrations, the
  // Worker's secrets, which go live as a new version, and the Worker.
  const changes = [
    step('node scripts/deploy.mjs resources'),
    step('node scripts/deploy.mjs migrations'),
    step('node scripts/deploy.mjs secrets'),
    step('pnpm exec wrangler deploy'),
  ];
  const setting = 'STATIC_ORIGIN: ${{ secrets.STATIC_ORIGIN || vars.STATIC_ORIGIN }}';

  assert.ok([build, credential, upload, ...changes].every((index) => index >= 0), 'the job has every step');
  assert.ok(steps[build]?.includes(setting), 'the build step gets STATIC_ORIGIN');
  assert.ok(steps[upload]?.includes(setting), 'the upload step gets STATIC_ORIGIN');
  assert.ok(build < upload && credential < upload, 'the upload runs after the build and the credential');
  assert.ok(
    changes.every((change) => upload < change),
    'the upload and its check run before resources, migrations, secrets, and the Worker change',
  );
});

test('the deploy workflows never run on pull_request_target', () => {
  assert.equal(workflow.includes('pull_request_target'), false);
});
