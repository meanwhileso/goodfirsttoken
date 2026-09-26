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

test('the deploy workflows never run on pull_request_target', () => {
  assert.equal(workflow.includes('pull_request_target'), false);
});
