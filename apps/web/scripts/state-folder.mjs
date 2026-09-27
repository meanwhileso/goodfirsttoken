// Empties the local data folder for `pnpm dev` or the end-to-end tests.
// scripts/migrate-local.mjs calls it for `--fresh`.
import { existsSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';

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
