// Resets local development's Anthropic fake. `pnpm seed` runs this. It
// removes the saved state, so the next start has no batches, and resets a
// fake that is running now.
//
//   node src/seed.ts --state <file> [--url http://127.0.0.1:8945]

import { rmSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { LOCAL_URL } from './local.ts';

const { values } = parseArgs({ options: { state: { type: 'string' }, url: { type: 'string' } } });
const url = values.url ?? LOCAL_URL;

if (values.state) {
  rmSync(values.state, { force: true });
  console.log(`Removed ${values.state}. The Anthropic fake starts with no batches.`);
}

try {
  if ((await fetch(`${url}/_fake/reset`, { method: 'POST' })).ok) {
    console.log(`Reset the running Anthropic fake at ${url}.`);
  }
} catch {
  // No fake is running, so the next start has no batches.
}
