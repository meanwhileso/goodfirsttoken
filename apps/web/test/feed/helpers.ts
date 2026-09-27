import type { FeedEvent } from '@goodfirsttoken/core';
import { exports } from 'cloudflare:workers';
import { expect, vi } from 'vitest';

// Shared setup for the feed tests. Every person, repo, and line here is made
// up.

let made = 0;

/** A feed event with a fresh ID, the next second after the last one made. */
export function feedEvent(changes: Partial<FeedEvent> = {}): FeedEvent {
  made += 1;
  return {
    id: `e_test${String(made).padStart(16, '0')}`,
    time: new Date(Date.UTC(2100, 0, 4, 12, 0, made)).toISOString(),
    user: 'priya',
    agent: 'claude-code',
    issue: 'sample-owner/sample-app#1',
    claim: 'c_test00000000000000001',
    kind: 'update',
    job: null,
    text: `line ${String(made)}`,
    ...changes,
  };
}

/** Collects every event a WebSocket watcher is sent. */
export async function watchSocket(stub: { fetch: (url: string, init: RequestInit) => Promise<Response> }, since?: string) {
  const res = await stub.fetch(`https://feed.test/${since ? `?since=${since}` : ''}`, {
    headers: { Upgrade: 'websocket' },
  });
  const socket = res.webSocket;
  if (!socket) throw new Error(`No WebSocket came back, status ${String(res.status)}.`);
  const events: FeedEvent[] = [];
  socket.addEventListener('message', (message) => {
    events.push(JSON.parse(String(message.data)) as FeedEvent);
  });
  socket.accept();
  return {
    events,
    socket,
    /** Waits until the watcher has `n` events, and gives their texts. */
    async received(n: number): Promise<string[]> {
      await vi.waitFor(() => {
        expect(events).toHaveLength(n);
      });
      return events.map((e) => e.text);
    },
  };
}

/**
 * Reads a stream from the Worker line by line, as `curl -N` would. Takes a
 * path, or a response already made.
 */
export async function readStream(path: string | Response, init?: RequestInit) {
  const res = typeof path === 'string' ? await exports.default.fetch(`http://localhost${path}`, init) : path;
  const lines: string[] = [];
  let ended = false;
  let reader: ReadableStreamDefaultReader<string> | null = null;
  if (res.body && res.status === 200) {
    const body = res.body.pipeThrough(new TextDecoderStream());
    reader = body.getReader();
    const open = reader;
    void (async () => {
      let buffer = '';
      for (;;) {
        const { done, value } = await open.read().catch(() => ({ done: true, value: undefined }));
        if (done || value === undefined) break;
        buffer += value;
        for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
          lines.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
        }
      }
      ended = true;
    })();
  }
  return {
    res,
    lines,
    ended: () => ended,
    /** Waits for a line that includes `text`, and gives it. */
    async line(text: string, timeout = 5000): Promise<string> {
      return vi.waitFor(
        () => {
          const found = lines.find((line) => line.includes(text));
          expect(found, `a line with "${text}" in ${JSON.stringify(lines)}`).toBeDefined();
          return found ?? '';
        },
        { timeout, interval: 20 },
      );
    },
    /** Stops reading, the way a reader who hangs up does. */
    async cancel(): Promise<void> {
      await reader?.cancel();
    },
  };
}
