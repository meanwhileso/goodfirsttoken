import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import worker from '../src/server';
import { personFeed } from '../src/rooms/feed';
import { randomAddress, startGitHub } from './auth/helpers';
import { emptyDatabase, signIn } from './db/helpers';
import { feedEvent, fields, readStream } from './feed/helpers';
import { emptyKv, mcpClient, MemoryOAuthClient, startSession, tokensFor } from './mcp/helpers';
import { workerFetch } from './worker';

// These tests send requests through exports.default.fetch on purpose. That
// is the runtime's own way into the Worker, and it runs each request in an
// I/O context of its own. The runtime refuses a request that uses a stream,
// body, or socket another request made, and refuses changes to the headers
// of the request it hands over. Every other Worker test calls workerFetch,
// which runs the Worker in the test's own I/O context, because requests
// through exports.default.fetch get slower one after another in a test
// file. The first few in a file are quick, so this file sends only a few.
// It covers /mcp and the body of a text stream, which the end-to-end tests
// don't reach. docs/architecture.md, under Tests, says what they do reach
// through the runtime. It also checks that workerFetch hands the Worker a
// request like the runtime's.

beforeEach(async () => {
  await emptyDatabase();
  await emptyKv();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("workerFetch hands the Worker a request like the runtime's: its headers and its clones' refuse changes, and the caller's abort doesn't reach it", async () => {
  const original = worker.fetch;
  const attempt = (change: () => void): string => {
    try {
      change();
      return 'changed';
    } catch (error) {
      return String(error);
    }
  };
  // What the Worker saw, recorded as plain values, since the runtime's
  // request belongs to another I/O context.
  const seen: { set: string; append: string; delete: string; cloneSet: string; redirect: string; aborted: boolean }[] = [];
  worker.fetch = (request, e, ctx) => {
    const saw = {
      set: attempt(() => {
        request.headers.set('x-changed', 'yes');
      }),
      append: attempt(() => {
        request.headers.append('x-changed', 'yes');
      }),
      delete: attempt(() => {
        request.headers.delete('x-sent');
      }),
      cloneSet: attempt(() => {
        request.clone().headers.set('x-changed', 'yes');
      }),
      redirect: request.redirect,
      aborted: request.signal.aborted,
    };
    request.signal.addEventListener('abort', () => {
      saw.aborted = true;
    });
    seen.push(saw);
    return original(request, e, ctx);
  };
  try {
    for (const send of [
      (url: string, init: RequestInit) => exports.default.fetch(url, init),
      (url: string, init: RequestInit) => workerFetch(url, init),
    ]) {
      const caller = new AbortController();
      const res = await send('http://localhost/healthz', { signal: caller.signal, headers: { 'x-sent': 'yes' } });
      expect(res.status).toBe(200);
      await res.text();
      caller.abort();
    }
  } finally {
    worker.fetch = original;
  }

  const [runtime, direct] = seen;
  const refused = expect.stringContaining('TypeError') as string;
  expect(runtime).toEqual({ set: refused, append: refused, delete: refused, cloneSet: refused, redirect: 'manual', aborted: false });
  expect(direct).toEqual(runtime);
});

test("an agent's calls to /mcp each get an answer through the runtime, in requests of their own", async () => {
  // The agent signs in through workerFetch, which never calls /mcp, so every
  // request to /mcp in this file goes through the runtime.
  const { clientId, accessToken, refreshToken } = await tokensFor(startGitHub(), 'priya');
  const oauth = new MemoryOAuthClient();
  oauth.saveClientInformation({ client_id: clientId });
  oauth.saveTokens({ access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer' });
  const address = randomAddress();
  const agent = mcpClient(oauth, (input, init) => {
    const request = new Request(input, init);
    request.headers.set('cf-connecting-ip', address);
    return exports.default.fetch(request);
  });

  await agent.client.connect(agent.transport);

  for (let call = 0; call < 2; call++) {
    const result = await startSession(agent);
    expect(result.isError, JSON.stringify(result)).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ login: 'priya' });
  }
  await agent.client.close();
});

test("a text stream's lines come through the runtime to two readers, each in a request of its own", async () => {
  const reader = { githubId: 3501, login: 'sample-runtime-reader' };
  await signIn(reader);
  const url = `http://localhost/@${reader.login}/live.txt`;
  const first = await readStream(await exports.default.fetch(url));
  const second = await readStream(await exports.default.fetch(url));
  expect([first.res.status, second.res.status]).toEqual([200, 200]);

  await personFeed(env.FEED, reader.githubId).deliver([
    { event: feedEvent({ user: reader.login, text: 'read through the runtime' }), githubId: reader.githubId },
  ]);

  for (const stream of [first, second]) {
    expect(fields(await stream.line('read through the runtime'))).toMatchObject({ user: reader.login });
    // The runtime doesn't pass a cancel on to the Worker yet, as workerd
    // issue 6832 reports, so both streams keep their sockets on this feed
    // until the file ends. Count no sockets on it after this.
    await stream.cancel();
  }
});
