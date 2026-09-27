import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./new-advisories.mjs', import.meta.url));
let dir;
let files = 0;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'new-advisories-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Builds an OSV-Scanner JSON report in the shape `osv-scanner --format json`
// writes for a pnpm lockfile.
function report(...packages) {
  return { results: [{ source: { path: '/repo/pnpm-lock.yaml', type: 'lockfile' }, packages }] };
}

function vulnerable(name, version, ...advisories) {
  return {
    package: { name, version, ecosystem: 'npm' },
    vulnerabilities: advisories.map(({ id, label }) => ({ id, database_specific: { severity: label } })),
    groups: advisories.map(({ id, score = '' }) => ({ ids: [id], aliases: [id], max_severity: score })),
  };
}

function write(contents) {
  const file = path.join(dir, `report-${++files}.json`);
  writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return file;
}

// Runs the script the way CI does. A report object is written to a file first.
// A string is a path, so a test can pass a missing or broken file.
function check(before, after) {
  const beforeFile = typeof before === 'string' ? before : write(before);
  const afterFile = typeof after === 'string' ? after : write(after);
  const { status, stdout, stderr } = spawnSync(process.execPath, [script, beforeFile, afterFile], {
    encoding: 'utf8',
  });
  return { status, output: stdout + stderr };
}

// A made-up package that stands for one already on main.
const onMain = vulnerable('old-dep', '1.0.0', { id: 'GHSA-oooo-oooo-oooo', score: '8.9', label: 'HIGH' });

test('a pull request that adds a package version with a high advisory fails and names it', () => {
  const lodash = vulnerable('lodash', '4.17.20', { id: 'GHSA-35jh-r3h4-6jhm', score: '7.2', label: 'HIGH' });
  const { status, output } = check(report(), report(lodash));
  assert.equal(status, 1);
  assert.match(output, /lodash@4\.17\.20: GHSA-35jh-r3h4-6jhm/);
});

test('a vulnerable version already on main passes and is never named in the log', () => {
  const { status, output } = check(report(onMain), report(onMain));
  assert.equal(status, 0);
  assert.doesNotMatch(output, /old-dep|GHSA-oooo-oooo-oooo/);
});

test('a pull request that adds a high advisory names only the package version it adds', () => {
  const lodash = vulnerable('lodash', '4.17.20', { id: 'GHSA-35jh-r3h4-6jhm', score: '7.2' });
  const { status, output } = check(report(onMain), report(onMain, lodash));
  assert.equal(status, 1);
  assert.match(output, /lodash@4\.17\.20/);
  assert.doesNotMatch(output, /old-dep|GHSA-oooo-oooo-oooo/);
});

test('adding another vulnerable version of a package already on main fails', () => {
  const newer = vulnerable('old-dep', '1.0.1', { id: 'GHSA-oooo-oooo-oooo', score: '8.9' });
  const { status, output } = check(report(onMain), report(onMain, newer));
  assert.equal(status, 1);
  assert.match(output, /old-dep@1\.0\.1/);
  assert.doesNotMatch(output, /old-dep@1\.0\.0/);
});

test('a score of exactly 7.0 counts as high', () => {
  const pkg = vulnerable('edge', '1.0.0', { id: 'GHSA-aaaa-bbbb-cccc', score: '7.0' });
  assert.equal(check(report(), report(pkg)).status, 1);
});

test('medium and low advisories do not fail the check', () => {
  const pkg = vulnerable(
    'mild',
    '1.0.0',
    { id: 'GHSA-mmmm-mmmm-mmmm', score: '6.9', label: 'MODERATE' },
    { id: 'GHSA-llll-llll-llll', score: '3.1', label: 'LOW' },
  );
  const { status, output } = check(report(), report(pkg));
  assert.equal(status, 0);
  assert.doesNotMatch(output, /mild/);
});

test('a known-malicious package fails even with no severity score', () => {
  const pkg = vulnerable('evil-helper', '1.0.0', { id: 'MAL-2026-1234' });
  const { status, output } = check(report(), report(pkg));
  assert.equal(status, 1);
  assert.match(output, /evil-helper@1\.0\.0: MAL-2026-1234/);
});

test('an advisory GitHub rates high fails even with no CVSS score', () => {
  const pkg = vulnerable('unscored', '2.0.0', { id: 'GHSA-uuuu-uuuu-uuuu', label: 'HIGH' });
  assert.equal(check(report(), report(pkg)).status, 1);
});

test('a missing or unreadable report fails the check', () => {
  assert.equal(check(report(), path.join(dir, 'never-written.json')).status, 2);
  assert.equal(check(report(), write('{"not": "a report"}')).status, 2);
  assert.equal(check(report(), write('not json')).status, 2);
});
