import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, test } from 'vitest';
import type { RecordedCall } from '../src/index.ts';
import { startGitHubFakeServer, type RunningFake } from '../src/server.ts';

const run = promisify(execFile);
const seedScript = join(import.meta.dirname, '../src/seed.ts');

const running: RunningFake[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start(statePath?: string): Promise<RunningFake> {
  const server = await startGitHubFakeServer({ port: 0, statePath });
  running.push(server);
  return server;
}

function tempState(): string {
  const dir = mkdtempSync(join(tmpdir(), 'github-fake-'));
  dirs.push(dir);
  return join(dir, 'state.json');
}

async function createLabel(server: RunningFake, name: string) {
  return fetch(`${server.apiUrl}/repos/meanwhileso/goodfirsttoken/labels`, {
    method: 'POST',
    headers: { authorization: `Bearer ${server.fake.tokenFor('jdconley')}`, 'user-agent': 'test' },
    body: JSON.stringify({ name, color: '000000' }),
  });
}

async function labelNames(server: RunningFake): Promise<string[]> {
  const response = await fetch(`${server.apiUrl}/repos/meanwhileso/goodfirsttoken/labels`, {
    headers: { 'user-agent': 'test' },
  });
  return ((await response.json()) as { name: string }[]).map((l) => l.name);
}

test('the local server answers GitHub calls and lists each one with whose token made it', async () => {
  const server = await start();
  const token = server.fake.tokenFor('ines');

  const me = await fetch(`${server.apiUrl}/user`, { headers: { authorization: `Bearer ${token}` } });
  const calls = (await (await fetch(`${server.webUrl}/_fake/calls`)).json()) as RecordedCall[];

  expect(me.status).toBe(200);
  expect(await me.json()).toMatchObject({ login: 'ines', html_url: `${server.webUrl}/ines` });
  expect(calls).toEqual([expect.objectContaining({ operation: 'GET /user', token, login: 'ines', status: 200 })]);
});

test('local state survives a restart, and pnpm seed resets it to the sample data', async () => {
  const statePath = tempState();
  const first = await start(statePath);
  expect((await createLabel(first, 'kept')).status).toBe(201);
  await first.close();
  running.splice(running.indexOf(first), 1);

  const second = await start(statePath);
  const afterRestart = await labelNames(second);
  await run(process.execPath, [seedScript, '--state', statePath, '--url', second.webUrl]);
  const afterSeed = await labelNames(second);

  expect(afterRestart).toContain('kept');
  expect(afterSeed).not.toContain('kept');
});

test('pnpm seed with no fake running removes the saved state, so the next start is sample data', async () => {
  const statePath = tempState();
  const first = await start(statePath);
  await createLabel(first, 'gone');
  const { webUrl } = first;
  await first.close();
  running.splice(running.indexOf(first), 1);

  await run(process.execPath, [seedScript, '--state', statePath, '--url', webUrl]);
  const next = await start(statePath);

  expect(await labelNames(next)).not.toContain('gone');
});
