// Starts the GitHub fake for local development and the Playwright tests.
//
//   node src/serve.ts                      fresh sample data on every start
//   node src/serve.ts --state <file>       keeps its state in the file
//   node src/serve.ts --port 0             picks a free port

import { parseArgs } from 'node:util';
import { LOCAL_PORT } from './local.ts';
import { startGitHubFakeServer } from './server.ts';

const { values } = parseArgs({ options: { port: { type: 'string' }, state: { type: 'string' } } });
const running = await startGitHubFakeServer({ port: Number(values.port ?? LOCAL_PORT), statePath: values.state });
console.log(`GitHub fake at ${running.webUrl}, with its API at ${running.apiUrl}`);
if (values.state) console.log(`Keeping its state in ${values.state}. Run pnpm seed to start over.`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void running.close().then(() => process.exit(0));
  });
}
