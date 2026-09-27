// Applies the D1 migrations to the local database before `pnpm dev` starts
// Vite. Wrangler asks before it applies a migration when both stdin and
// stdout are a terminal. Its stdin here is empty, so it applies them without
// asking, the same in a terminal, under `pnpm --parallel`, and on any OS.
// It needs no network and no account.
//
// The local data lives in .wrangler/state, or in LOCAL_STATE_DIR when it is
// set, as vite.config.ts reads it. `--fresh` empties that folder first,
// which the end-to-end tests do with a folder of their own. It only empties
// a folder inside .wrangler, after following every symlink on the way.
//
//   node scripts/migrate-local.mjs [--fresh]
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Where `target` really is: the real path of its nearest folder that
// exists, so every symlink on the way is followed, with the rest joined on.
function realPath(target) {
  const rest = [];
  let existing = path.resolve(target);
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathSync(existing), ...rest);
}

/**
 * Empties the local data folder `dir`, relative to the app folder `app`.
 * It has to be inside the app's .wrangler folder once symlinks are
 * followed, so a link can't point the removal anywhere else. Returns the
 * folder it emptied.
 */
export function emptyStateFolder(app, dir) {
  const wrangler = realPath(path.join(app, '.wrangler'));
  const folder = realPath(path.resolve(app, dir));
  if (!folder.startsWith(wrangler + path.sep)) {
    throw new Error(`--fresh empties only a folder inside .wrangler, and ${dir} is ${folder}.`);
  }
  rmSync(folder, { recursive: true, force: true });
  return folder;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('wrangler/package.json');
  const wrangler = path.join(path.dirname(pkg), require(pkg).bin.wrangler);

  const dir = process.env.LOCAL_STATE_DIR?.trim() || '.wrangler/state';
  if (process.argv.includes('--fresh')) emptyStateFolder(app, dir);

  const result = spawnSync(
    process.execPath,
    [wrangler, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', path.resolve(app, dir)],
    { cwd: app, stdio: ['ignore', 'inherit', 'inherit'] },
  );
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
