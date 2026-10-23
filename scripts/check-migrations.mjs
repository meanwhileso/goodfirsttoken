#!/usr/bin/env node
// Check D1 migration filenames so parallel branches cannot collide.
//
// New migrations are named YYYYMMDDHHMMSS_<name>.sql (UTC, see
// scripts/new-migration.mjs). Files named with the old 4-digit numbers are
// allowed only up to the last number a directory used before the switch, and
// each number only once, unless it is a duplicate that already shipped. Never
// rename a migration that has shipped: Wrangler tracks applied migrations by
// filename and would run a renamed one again.
//
// Usage: node scripts/check-migrations.mjs [<dir>=<last number>[:<shipped duplicate>,...] ...]
//   e.g. apps/web/migrations=161:0067,0068
// Checks every directory named `migrations` under the current directory
// (vendored copies excluded). A directory not given a cutoff here may hold
// timestamped migrations only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LEGACY = /^(\d{4})[-_].+\.sql$/;
const TIMESTAMPED = /^(\d{14})_[a-z0-9_]+\.sql$/;
// Timestamped naming started in 2026. An earlier year can only be hand-typed.
const FIRST_YEAR = 2026;
// Allow a day of clock skew; a later timestamp is a hand-typed attempt to sort last.
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;
const HOW = 'Name new ones YYYYMMDDHHMMSS_<name>.sql (node scripts/new-migration.mjs <name>).';

function parseTimestamp(prefix) {
  const [y, mo, d, h, mi, s] = [0, 4, 6, 8, 10, 12].map((at, i) => Number(prefix.slice(at, i === 0 ? 4 : at + 2)));
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  const roundTrips = date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
    && date.getUTCHours() === h && date.getUTCMinutes() === mi && date.getUTCSeconds() === s;
  return roundTrips ? date : null;
}

export function checkMigrationFiles(files, { legacyCutoff = 0, allowedDuplicates = [], now = new Date() } = {}) {
  const problems = [];
  const timestamps = new Map();
  const numbered = new Map();
  const lateNumbered = [];
  for (const file of files.filter((name) => name.endsWith('.sql')).sort()) {
    const legacy = LEGACY.exec(file);
    if (legacy) {
      if (Number(legacy[1]) > legacyCutoff) lateNumbered.push(file);
      numbered.set(legacy[1], [...(numbered.get(legacy[1]) ?? []), file]);
      continue;
    }
    const stamped = TIMESTAMPED.exec(file);
    if (!stamped) {
      problems.push(`${file}: expected YYYYMMDDHHMMSS_<lowercase_name>.sql (node scripts/new-migration.mjs <name>).`);
      continue;
    }
    const date = parseTimestamp(stamped[1]);
    if (!date || date.getUTCFullYear() < FIRST_YEAR) problems.push(`${file}: ${stamped[1]} is not a real UTC date and time since ${FIRST_YEAR}.`);
    else if (date.getTime() - now.getTime() > MAX_FUTURE_MS) problems.push(`${file}: ${stamped[1]} is in the future. Use the time the migration was created.`);
    if (timestamps.has(stamped[1])) problems.push(`${file}: shares timestamp ${stamped[1]} with ${timestamps.get(stamped[1])}.`);
    timestamps.set(stamped[1], file);
  }
  for (const [prefix, sameNumber] of numbered) {
    if (sameNumber.length > 1 && !allowedDuplicates.includes(prefix)) {
      problems.push(`${sameNumber.join(', ')}: share number ${prefix}. Numbered migrations are frozen; rename the one that has not shipped. ${HOW}`);
    }
  }
  if (lateNumbered.length > 0) {
    const after = legacyCutoff ? ` after ${String(legacyCutoff).padStart(4, '0')}` : '';
    const shown = lateNumbered.length > 3 ? `${lateNumbered[0]} ... ${lateNumbered.at(-1)} (${lateNumbered.length} files)` : lateNumbered.join(', ');
    problems.unshift(`${shown}: numbered migrations are frozen${after}. ${HOW}`);
  }
  return problems;
}

export function checkMigrationDir(dir, options) {
  return checkMigrationFiles(fs.readdirSync(dir), options).map((problem) => `${dir}/${problem}`);
}

// vendor/ holds copies of other repos' migrations that Wrangler never reads from there.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '__fixtures__', 'vendor']);

export function findMigrationDirs(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const child = path.join(dir, entry.name);
      if (entry.name === 'migrations' && fs.readdirSync(child).some((file) => file.endsWith('.sql'))) {
        found.push(path.relative(root, child));
      }
      walk(child);
    }
  };
  walk(root);
  return found;
}

function main(argv) {
  const frozen = new Map();
  for (const arg of argv) {
    const match = /^(.+)=(\d+)(?::(\d{4}(?:,\d{4})*))?$/.exec(arg);
    if (!match) {
      console.error('Usage: node scripts/check-migrations.mjs [<dir>=<last number>[:<shipped duplicate>,...] ...]');
      process.exit(2);
    }
    const dir = path.relative(process.cwd(), path.resolve(match[1]));
    frozen.set(dir, { legacyCutoff: Number(match[2]), allowedDuplicates: match[3]?.split(',') ?? [] });
  }
  const dirs = new Set([...findMigrationDirs(process.cwd()), ...frozen.keys()]);
  const problems = [...dirs].sort().flatMap((dir) => {
    if (!fs.existsSync(dir)) return [`${dir}: no such migrations directory.`];
    return checkMigrationDir(dir, frozen.get(dir));
  });
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(`migration filenames OK (${dirs.size} director${dirs.size === 1 ? 'y' : 'ies'})`);
}

// Compare real paths: through a symlinked path the URLs differ and the check would silently not run.
const realPath = (file) => { try { return fs.realpathSync(file); } catch { return file; } };
if (process.argv[1] && realPath(fileURLToPath(import.meta.url)) === realPath(process.argv[1])) main(process.argv.slice(2));
