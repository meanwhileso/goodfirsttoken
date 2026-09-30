// Serves the GitHub fake over HTTP for `pnpm dev` and the Playwright tests.
// Node only. The API is under /api on the same port, so one server stands
// in for both github.com and api.github.com.
//
// Three routes exist only on the fake, for tests and `pnpm seed`:
//   GET  /_fake/health   the fake's base URLs
//   GET  /_fake/calls    every call so far, with whose token made it
//   POST /_fake/reset    back to the sample data

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import { createGitHubFake, type FakeState, type GitHubFake } from './index.ts';
import { LOCAL_PORT } from './local.ts';

export interface ServerOptions {
  // 0 picks a free port.
  port?: number;
  // A file that keeps the fake's state across restarts, like Miniflare's
  // D1 and KV files. Without one, every start is fresh sample data.
  statePath?: string;
  now?: () => Date;
}

export interface RunningFake {
  webUrl: string;
  apiUrl: string;
  fake: GitHubFake;
  close: () => Promise<void>;
}

function loadState(path: string | undefined): FakeState | undefined {
  if (!path || !existsSync(path)) return undefined;
  const saved = JSON.parse(readFileSync(path, 'utf8')) as Partial<FakeState>;
  return saved.version === 1 ? (saved as FakeState) : undefined;
}

async function toRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    for (const one of [value ?? []].flat()) headers.append(name, one);
  }
  const method = req.method ?? 'GET';
  return new Request(new URL(req.url ?? '/', origin), {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks),
    // A redirect goes back to the client, which follows it itself.
    redirect: 'manual',
  });
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

export async function startGitHubFakeServer(options: ServerOptions = {}): Promise<RunningFake> {
  let fake: GitHubFake | null = null;
  const save = () => {
    if (!options.statePath || !fake) return;
    mkdirSync(dirname(options.statePath), { recursive: true });
    writeFileSync(options.statePath, JSON.stringify(fake.state));
  };

  const server = createServer((req, res) => {
    void (async () => {
      if (!fake) return;
      const request = await toRequest(req, fake.webUrl);
      const path = new URL(request.url).pathname;
      if (path === '/_fake/health') {
        await send(res, Response.json({ ok: true, webUrl: fake.webUrl, apiUrl: fake.apiUrl }));
      } else if (path === '/_fake/calls') {
        await send(res, Response.json(fake.calls));
      } else if (path === '/_fake/reset' && request.method === 'POST') {
        fake.reset();
        save();
        await send(res, Response.json({ ok: true }));
      } else {
        await send(res, await fake.fetch(request));
        if (request.method !== 'GET' && request.method !== 'HEAD') save();
      }
    })().catch((error: unknown) => {
      console.error(error);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('The GitHub fake failed. See its log.\n');
    });
  });

  // Loopback only, so nothing off the machine can reach the fake.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? LOCAL_PORT, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  const webUrl = `http://127.0.0.1:${String(port)}`;
  fake = createGitHubFake({
    webUrl,
    apiUrl: `${webUrl}/api`,
    now: options.now,
    state: loadState(options.statePath),
  });
  save();
  const running = fake;
  return {
    webUrl: running.webUrl,
    apiUrl: running.apiUrl,
    fake: running,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections();
      }),
  };
}
