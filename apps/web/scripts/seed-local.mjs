// Gives the local site its sample projects and work, through the dev-only
// POST /dev/seed (src/dev/seed.ts). `pnpm seed` runs this after it resets
// the GitHub fake. The site has to be running, with `pnpm dev`.
//
//   node scripts/seed-local.mjs [--url http://localhost:5173]
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { url: { type: 'string', default: 'http://localhost:5173' } } });
const url = new URL('/dev/seed', values.url);

let res;
try {
  res = await fetch(url, { method: 'POST' });
} catch {
  console.log(`The site isn't running at ${values.url}. Start it with pnpm dev, then run pnpm seed again for sample projects and work.`);
  process.exit(0);
}
if (!res.ok) {
  console.error(`POST ${url.href} answered ${String(res.status)}: ${(await res.text()).trim()}`);
  process.exit(1);
}
const made = await res.json();
console.log(
  `Seeded the local site: ${String(made.projects)} new projects, ${String(made.claims)} new claims, ` +
    `${String(made.lines)} new lines, and ${String(made.merged)} merged PRs.`,
);
