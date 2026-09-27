// Applies the D1 migrations to the local database before `pnpm dev` starts
// Vite. Wrangler asks before it applies a migration when both stdin and
// stdout are a terminal. Its stdin here is empty, so it applies them without
// asking, the same in a terminal, under `pnpm --parallel`, and on any OS.
// It needs no network and no account.
//
// The local data lives in .wrangler/state, or in LOCAL_STATE_DIR when it is
// set, as vite.config.ts reads it. `--fresh` empties that folder first,
// which the end-to-end tests do with a folder of their own. It only empties
// a folder under .wrangler.
//
//   node scripts/migrate-local.mjs [--fresh]
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const pkg = require.resolve('wrangler/package.json');
const wrangler = path.join(path.dirname(pkg), require(pkg).bin.wrangler);

const state = path.resolve(app, process.env.LOCAL_STATE_DIR?.trim() || '.wrangler/state');
if (process.argv.includes('--fresh')) {
  if (!state.startsWith(path.join(app, '.wrangler') + path.sep)) {
    throw new Error(`--fresh empties only a folder under .wrangler, and ${state} is not one.`);
  }
  rmSync(state, { recursive: true, force: true });
}

const result = spawnSync(
  process.execPath,
  [wrangler, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state],
  { cwd: app, stdio: ['ignore', 'inherit', 'inherit'] },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
