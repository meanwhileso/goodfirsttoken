// Starts the Anthropic fake for local development.
//
//   node src/serve.ts                      no batches on every start
//   node src/serve.ts --state <file>       keeps its batches in the file
//   node src/serve.ts --port 0             picks a free port

import { parseArgs } from 'node:util';
import { LOCAL_PORT } from './local.ts';
import { startAnthropicFakeServer } from './server.ts';

const { values } = parseArgs({ options: { port: { type: 'string' }, state: { type: 'string' } } });
const running = await startAnthropicFakeServer({ port: Number(values.port ?? LOCAL_PORT), statePath: values.state });
console.log(`Anthropic fake at ${running.url}`);
if (values.state) console.log(`Keeping its batches in ${values.state}. Run pnpm seed to start over.`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void running.close().then(() => process.exit(0));
  });
}
