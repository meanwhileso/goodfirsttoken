// Resets local development's GitHub to the sample data. `pnpm seed` runs
// this. It removes the saved state, so the next start is sample data, and
// resets a fake that is running now.
//
//   node src/seed.ts --state <file> [--url http://127.0.0.1:8944]

import { rmSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { LOCAL_WEB_URL } from './local.ts';

const { values } = parseArgs({ options: { state: { type: 'string' }, url: { type: 'string' } } });
const url = values.url ?? LOCAL_WEB_URL;

if (values.state) {
  rmSync(values.state, { force: true });
  console.log(`Removed ${values.state}. The GitHub fake starts from the sample data.`);
}

try {
  if ((await fetch(`${url}/_fake/reset`, { method: 'POST' })).ok) {
    console.log(`Reset the running GitHub fake at ${url} to the sample data.`);
  }
} catch {
  // No fake is running, so the next start picks up the sample data.
}
