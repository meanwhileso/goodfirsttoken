import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { emptyStateFolder } from './state-folder.mjs';

// `--fresh` empties the local data folder, so it must never reach past the
// app's .wrangler folder. Each test builds an app folder and a folder
// outside it, in a temporary folder.
const base = mkdtempSync(path.join(tmpdir(), 'migrate-local-'));
const app = path.join(base, 'app');
const outside = path.join(base, 'outside');

beforeEach(() => {
  rmSync(app, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  mkdirSync(path.join(app, '.wrangler', 'e2e-state', 'v3'), { recursive: true });
  writeFileSync(path.join(app, '.wrangler', 'e2e-state', 'v3', 'db.sqlite'), 'local data');
  mkdirSync(path.join(outside, 'sub'), { recursive: true });
  writeFileSync(path.join(outside, 'sub', 'keep.txt'), 'not ours');
});

after(() => rmSync(base, { recursive: true, force: true }));

test('--fresh empties a folder inside .wrangler', () => {
  emptyStateFolder(app, '.wrangler/e2e-state');

  assert.equal(existsSync(path.join(app, '.wrangler', 'e2e-state')), false);
  assert.equal(existsSync(path.join(app, '.wrangler')), true);
});

test('--fresh leaves a folder alone that a symlink inside .wrangler points to', () => {
  symlinkSync(outside, path.join(app, '.wrangler', 'link'));

  assert.throws(() => emptyStateFolder(app, '.wrangler/link/sub'), /only a folder inside \.wrangler/);
  assert.throws(() => emptyStateFolder(app, '.wrangler/link'), /only a folder inside \.wrangler/);
  assert.equal(existsSync(path.join(outside, 'sub', 'keep.txt')), true);
});

test('--fresh refuses .wrangler itself, and a folder outside it', () => {
  for (const dir of ['.wrangler', '.wrangler/..', '../outside/sub', path.join(outside, 'sub')]) {
    assert.throws(() => emptyStateFolder(app, dir), /only a folder inside \.wrangler/, dir);
  }
  assert.equal(existsSync(path.join(outside, 'sub', 'keep.txt')), true);
  assert.equal(existsSync(path.join(app, '.wrangler', 'e2e-state', 'v3', 'db.sqlite')), true);
});

test('--fresh on a folder that is not there yet does nothing', () => {
  emptyStateFolder(app, '.wrangler/not-yet/v3');

  assert.equal(existsSync(path.join(app, '.wrangler', 'e2e-state', 'v3', 'db.sqlite')), true);
});
