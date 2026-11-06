// Serves the Anthropic fake over HTTP for `pnpm dev`. Node only.
//
// Three routes exist only on the fake, for `pnpm seed` and anyone checking
// what the Worker sent:
//   GET  /_fake/health    the fake's URL
//   GET  /_fake/requests  every request to the model so far, with why the
//                         API would refuse it
//   POST /_fake/reset     no batches, calls, or scripts

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import { createAnthropicFake, type AnthropicFake, type FakeState } from './index.ts';
import { LOCAL_PORT } from './local.ts';

export interface ServerOptions {
  // 0 picks a free port.
  port?: number;
  // A file that keeps the fake's batches across restarts, as the GitHub fake
  // keeps its state. Without one, every start has no batches.
  statePath?: string;
  now?: () => Date;
}

export interface RunningFake {
  url: string;
  fake: AnthropicFake;
  close: () => Promise<void>;
}

function loadState(path: string | undefined): FakeState | undefined {
  if (!path || !existsSync(path)) return undefined;
  const saved = JSON.parse(readFileSync(path, 'utf8')) as Partial<FakeState>;
  return saved.version === 1 ? (saved as FakeState) : undefined;
}

async function toRequest(req: IncomingMessage, origin: string, signal: AbortSignal): Promise<Request> {
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
    signal,
  });
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

export async function startAnthropicFakeServer(options: ServerOptions = {}): Promise<RunningFake> {
  let fake: AnthropicFake | null = null;
  const save = () => {
    if (!options.statePath || !fake) return;
    mkdirSync(dirname(options.statePath), { recursive: true });
    writeFileSync(options.statePath, JSON.stringify(fake.state));
  };

  const server = createServer((req, res) => {
    void (async () => {
      if (!fake) return;
      // A call that never answers ends when its client goes away.
      const gone = new AbortController();
      res.once('close', () => {
        gone.abort();
      });
      const request = await toRequest(req, fake.url, gone.signal);
      const path = new URL(request.url).pathname;
      if (path === '/_fake/health') {
        await send(res, Response.json({ ok: true, url: fake.url }));
      } else if (path === '/_fake/requests') {
        await send(res, Response.json(fake.requests));
      } else if (path === '/_fake/reset' && request.method === 'POST') {
        fake.reset();
        save();
        await send(res, Response.json({ ok: true }));
      } else {
        const response = await fake.fetch(request).catch((error: unknown) => {
          if (gone.signal.aborted) return null;
          throw error;
        });
        if (response) await send(res, response);
        if (request.method !== 'GET' && request.method !== 'HEAD') save();
      }
    })().catch((error: unknown) => {
      console.error(error);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('The Anthropic fake failed. See its log.\n');
    });
  });

  // Loopback only, so nothing off the machine can reach the fake.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? LOCAL_PORT, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  fake = createAnthropicFake({ url: `http://127.0.0.1:${String(port)}`, now: options.now, state: loadState(options.statePath) });
  save();
  const running = fake;
  return {
    url: running.url,
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
