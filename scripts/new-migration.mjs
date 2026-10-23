#!/usr/bin/env node
// Create a D1 migration named for the UTC time it was created:
// <migrations dir>/YYYYMMDDHHMMSS_<name>.sql
//
// Two branches that each add a migration get different filenames, so they
// never collide the way the old 0001, 0002, ... numbering did. Wrangler applies
// every unapplied .sql file in order of its name (newer versions: its numeric
// prefix), and 14-digit timestamps come after the legacy 4-digit files either
// way, so old and new names live in one directory.
// Do not use `wrangler d1 migrations create`: it numbers from the highest
// existing prefix, which brings the collisions back.
//
// Usage: node scripts/new-migration.mjs <name> [--dir <migrations dir>]
// --dir defaults to ./migrations in the current directory.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function migrationTimestamp(date) {
  return date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

export function migrationSlug(name) {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!slug) throw new Error(`migration name "${name}" has no letters or digits`);
  return slug;
}

export function createMigration({ dir, name, now = new Date() }) {
  fs.mkdirSync(dir, { recursive: true });
  const slug = migrationSlug(name);
  const taken = new Set(fs.readdirSync(dir).map((file) => file.slice(0, 14)));
  // Two migrations made in the same second would share a prefix; move on a second.
  const at = new Date(now.getTime());
  while (taken.has(migrationTimestamp(at))) at.setUTCSeconds(at.getUTCSeconds() + 1);
  const file = path.join(dir, `${migrationTimestamp(at)}_${slug}.sql`);
  fs.writeFileSync(file, `-- ${slug.replaceAll('_', ' ')}\n-- Created ${at.toISOString()}\n\n`, { flag: 'wx' });
  return file;
}

function main(argv) {
  let dir = 'migrations';
  const names = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') dir = argv[++i];
    else if (argv[i].startsWith('--dir=')) dir = argv[i].slice('--dir='.length);
    else names.push(argv[i]);
  }
  if (names.length === 0 || !dir) {
    console.error('Usage: node scripts/new-migration.mjs <name> [--dir <migrations dir>]');
    process.exit(2);
  }
  const file = createMigration({ dir: path.resolve(dir), name: names.join(' ') });
  console.log(path.relative(process.cwd(), file));
}

// Compare real paths: through a symlinked path the URLs differ and nothing would run.
const realPath = (file) => { try { return fs.realpathSync(file); } catch { return file; } };
if (process.argv[1] && realPath(fileURLToPath(import.meta.url)) === realPath(process.argv[1])) main(process.argv.slice(2));
