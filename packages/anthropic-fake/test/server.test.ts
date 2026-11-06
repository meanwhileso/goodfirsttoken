import Anthropic from '@anthropic-ai/sdk';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, test } from 'vitest';
import { startAnthropicFakeServer, type RunningFake } from '../src/server.ts';
import { docsOf, readingRequest } from './requests.ts';

const run = promisify(execFile);
const seedScript = join(import.meta.dirname, '../src/seed.ts');

const running: RunningFake[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start(statePath?: string): Promise<RunningFake> {
  const server = await startAnthropicFakeServer({ port: 0, statePath });
  running.push(server);
  return server;
}

async function stop(server: RunningFake): Promise<void> {
  await server.close();
  running.splice(running.indexOf(server), 1);
}

function tempState(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anthropic-fake-'));
  dirs.push(dir);
  return join(dir, 'state.json');
}

// The SDK over HTTP, with Node's own fetch, as the Worker in `pnpm dev`
// reaches the fake.
const sdk = (server: RunningFake) => new Anthropic({ apiKey: 'local-stand-in', baseURL: server.url, maxRetries: 0, timeout: 10_000 });

test('the local server answers the SDK over HTTP, and lists each request to the model', async () => {
  const server = await start();

  const message = await sdk(server).messages.create(readingRequest(docsOf('sample-policies/invites-agents')));
  const requests = (await (await fetch(`${server.url}/_fake/requests`)).json()) as unknown[];

  expect(message.stop_reason).toBe('end_turn');
  expect(requests).toEqual([expect.objectContaining({ via: 'messages', kind: 'reading', refused: null })]);
});

test('local batches survive a restart, and pnpm seed forgets them', async () => {
  const statePath = tempState();
  const first = await start(statePath);
  const batch = await sdk(first).messages.batches.create({
    requests: [{ custom_id: 'one', params: readingRequest(docsOf('sample-policies/bans-ai')) }],
  });
  await stop(first);

  const second = await start(statePath);
  const kept = await sdk(second).messages.batches.retrieve(batch.id);
  await run(process.execPath, [seedScript, '--state', statePath, '--url', second.url]);
  const gone = await sdk(second)
    .messages.batches.retrieve(batch.id)
    .catch((error: unknown) => error);

  expect(kept.processing_status).toBe('ended');
  expect(gone).toBeInstanceOf(Anthropic.NotFoundError);
});

test('pnpm seed with no fake running removes the saved batches', async () => {
  const statePath = tempState();
  const first = await start(statePath);
  const batch = await sdk(first).messages.batches.create({
    requests: [{ custom_id: 'one', params: readingRequest(docsOf('sample-policies/bans-ai')) }],
  });
  const { url } = first;
  await stop(first);

  await run(process.execPath, [seedScript, '--state', statePath, '--url', url]);
  const next = await start(statePath);

  await expect(sdk(next).messages.batches.retrieve(batch.id)).rejects.toBeInstanceOf(Anthropic.NotFoundError);
});
