import { feedEventSchema, githubLogin, id, issueRef, repoName, validate, type FeedEvent } from '@goodfirsttoken/core';
import { env } from 'cloudflare:workers';
import { findPersonByLogin, getBlock, getProject } from '../db';
import { findIssue } from '../issue/find';
import { homeFeed, personFeed, repoFeed } from '../rooms/feed';
import { issueRoom } from '../rooms/issue-room';
import { ndjsonLine, textLine } from './format';

// The live text streams (spec section 9, "Readable by agents"), one for each
// feed, readable with `curl -N`:
//
//   /live.txt                              everything, from the homepage's feed
//   /<owner>/<repo>/live.txt               a project, from its feed
//   /<owner>/<repo>/issues/<n>/live.txt    an issue, from its room
//   /@<user>/live.txt                      a person, from their feed
//
// Each also has a .ndjson form. The Worker connects to the feed or room over
// the same hibernating WebSocket a page uses, and writes each event it sends
// as a line. A stream closes after an hour. A reader reconnects with
// `?since=<event ID>` to get what it missed. The streams are public and set
// no cookie.
//
// A page opens that WebSocket itself, with a WebSocket upgrade on the
// .ndjson form's URL. The Worker finds the feed or room the same way and
// hands the upgrade to it, so the browser holds the feed's own hibernating
// socket, which sends each event as one JSON message.

const HOUR = 60 * 60 * 1000;

/** How long a stream stays open. */
const STREAM_LIFETIME_MS = HOUR;
/** How long a line can wait for the reader to take it before the stream ends. */
const STREAM_READER_WAIT_MS = 60 * 1000;

type Format = 'txt' | 'ndjson';

type Source =
  | { kind: 'home' }
  | { kind: 'repo'; repo: string }
  | { kind: 'issue'; issue: string }
  | { kind: 'person'; login: string };

interface StreamRoute {
  source: Source;
  format: Format;
}

const FORMATS: Record<Format, { type: string; line: typeof textLine }> = {
  txt: { type: 'text/plain; charset=utf-8', line: textLine },
  ndjson: { type: 'application/x-ndjson; charset=utf-8', line: ndjsonLine },
};

// Every answer is public, and the same for everyone. no-transform keeps
// Cloudflare from compressing a stream, which would hold its lines back.
const HEADERS = {
  'cache-control': 'no-store, no-transform',
  'access-control-allow-origin': '*',
  'x-content-type-options': 'nosniff',
};

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(`${body}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...HEADERS, ...headers },
  });
}

const HOME = /^\/live\.(txt|ndjson)$/;
const PERSON = /^\/@([^/]+)\/live\.(txt|ndjson)$/;
const REPO = /^\/([^/]+)\/([^/]+)\/live\.(txt|ndjson)$/;
const ISSUE = /^\/([^/]+)\/([^/]+)\/issues\/([^/]+)\/live\.(txt|ndjson)$/;

const valid = (schema: Parameters<typeof validate>[0], value: string) => validate(schema, value).ok;

/**
 * The stream a path names, or null when it names none. A path shaped like a
 * stream whose owner, repo, issue number, or login GitHub couldn't have is
 * no stream.
 */
function streamRoute(request: Request): StreamRoute | null {
  const { pathname } = new URL(request.url);
  let match = HOME.exec(pathname);
  if (match) return { source: { kind: 'home' }, format: match[1] as Format };
  match = PERSON.exec(pathname);
  if (match) {
    const [, login = '', format] = match;
    return valid(githubLogin, login) ? { source: { kind: 'person', login }, format: format as Format } : null;
  }
  match = ISSUE.exec(pathname);
  if (match) {
    const [, owner, repo, number, format] = match;
    const issue = `${String(owner)}/${String(repo)}#${String(number)}`;
    return valid(issueRef, issue) ? { source: { kind: 'issue', issue }, format: format as Format } : null;
  }
  match = REPO.exec(pathname);
  if (match) {
    const [, owner, name, format] = match;
    const repo = `${String(owner)}/${String(name)}`;
    return valid(repoName, repo) ? { source: { kind: 'repo', repo }, format: format as Format } : null;
  }
  return null;
}

/** True when the path is shaped like a stream's, whether or not the stream exists. */
export function isStreamPath(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return [HOME, PERSON, REPO, ISSUE].some((pattern) => pattern.test(pathname));
}

/**
 * The feed or room a source reads from, or a text answer saying why there is
 * none. A repo's stream needs the repo to be a project. An issue's needs a
 * claim on the issue, or the issue among the tagged issues of a project that
 * keeps its issues in that repo. So a request never makes a feed or room
 * that nothing could fill. A person's stream finds them by their login now,
 * and reads their feed by GitHub ID. A blocked donor has no stream.
 */
async function sourceFor(source: Source): Promise<DurableObjectStub | Response> {
  switch (source.kind) {
    case 'home':
      return homeFeed(env.FEED);
    case 'repo': {
      const project = await getProject(env.DB, source.repo);
      if (!project) return text(404, `${source.repo} is not a project on Good First Token.`);
      return repoFeed(env.FEED, project.repo);
    }
    case 'issue': {
      if (!(await findIssue(env.DB, source.issue))) {
        return text(404, `${source.issue} has no claim, and no project on Good First Token tagged it.`);
      }
      return issueRoom(env.ISSUE_ROOM, source.issue);
    }
    case 'person': {
      const person = await findPersonByLogin(env.DB, source.login);
      // A blocked donor's stream is gone, as their page is, and answers the
      // same as a login no one signed in with, so it gives away no block.
      if (person === null || (await getBlock(env.DB, person.githubId)) !== null) {
        return text(404, `@${source.login} has no stream on Good First Token.`);
      }
      return personFeed(env.FEED, person.githubId);
    }
  }
}

/** The feed event a feed or room sent, or null when the message isn't one. */
function parseEvent(data: unknown): FeedEvent | null {
  if (typeof data !== 'string') return null;
  try {
    const event = validate(feedEventSchema, JSON.parse(data), 'event');
    return event.ok ? event.value : null;
  } catch {
    return null;
  }
}

/**
 * Answers a WebSocket upgrade on a stream's .ndjson URL by handing it to the
 * feed or room, whose hibernating socket then sends the browser each event
 * as one JSON message: first every event after `since`, or the ones a
 * watcher with no `since` gets, then each new one. Blocked donors' events
 * are left out, as for every watcher. The socket is public and read-only.
 * What the browser sends is ignored, and no cookie is read or set.
 */
async function openLiveSocket(source: Source, format: Format, since: string | null): Promise<Response> {
  if (format !== 'ndjson') return text(400, 'Open a WebSocket on the .ndjson form of this stream.');
  try {
    const stub = await sourceFor(source);
    if (stub instanceof Response) return stub;
    const query = since === null ? '' : `?since=${encodeURIComponent(since)}`;
    const upgrade = await stub.fetch(`https://feed.internal/${query}`, { headers: { Upgrade: 'websocket' } });
    if (upgrade.status !== 101 || !upgrade.webSocket) throw new Error(`The feed answered ${String(upgrade.status)}.`);
    return new Response(null, { status: 101, webSocket: upgrade.webSocket });
  } catch (error) {
    console.warn('A live socket could not reach its feed.', error);
    return text(503, 'Try again in a moment.');
  }
}

/**
 * Answers a request for a stream, or a page's WebSocket upgrade on one,
 * which openLiveSocket takes. A stream is a line for each event the feed or
 * room sends, until the stream's lifetime, an hour, has passed, the feed or
 * room closes the socket, or the reader goes away. A reader that leaves a
 * line untaken for a minute is too slow, and the stream ends, so lines never
 * pile up in memory. The options are for tests.
 */
export async function handleStream(
  request: Request,
  {
    lifetimeMs = STREAM_LIFETIME_MS,
    readerWaitMs = STREAM_READER_WAIT_MS,
  }: { lifetimeMs?: number; readerWaitMs?: number } = {},
): Promise<Response> {
  const route = streamRoute(request);
  if (!route) return text(404, 'There is no such stream.');
  const { source, format } = route;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return text(405, 'Read a stream with GET.', { allow: 'GET, HEAD' });
  }
  const since = new URL(request.url).searchParams.get('since') || null;
  if (since !== null && !validate(id, since).ok) {
    return text(400, 'since has to be the ID of an event, as a line of the stream gives it.');
  }
  if (request.method === 'GET' && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
    return openLiveSocket(source, format, since);
  }
  const { type, line } = FORMATS[format];
  const headers = { 'content-type': type, ...HEADERS };

  let socket: WebSocket;
  try {
    const stub = await sourceFor(source);
    if (stub instanceof Response) return stub;
    if (request.method === 'HEAD') return new Response(null, { headers });
    const query = since === null ? '' : `?since=${encodeURIComponent(since)}`;
    const upgrade = await stub.fetch(`https://feed.internal/${query}`, { headers: { Upgrade: 'websocket' } });
    if (upgrade.status !== 101 || !upgrade.webSocket) throw new Error(`The feed answered ${String(upgrade.status)}.`);
    socket = upgrade.webSocket;
  } catch (error) {
    console.warn('A stream could not reach its feed.', error);
    return text(503, 'Try again in a moment.');
  }
  socket.accept();

  const encoder = new TextEncoder();
  const deadline = Date.now() + lifetimeMs;
  // The lines the reader hasn't taken yet, oldest first, with when each came.
  const waiting: { bytes: Uint8Array; at: number }[] = [];
  let open = true;
  let wake: (() => void) | null = null;
  let body: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stalled = () => Date.now() - (waiting[0]?.at ?? Date.now()) > readerWaitMs;
  const cutOff = () => {
    waiting.length = 0;
    body?.error(new Error('The reader fell behind.'));
  };
  const end = () => {
    if (!open) return;
    open = false;
    clearTimeout(timer);
    try {
      socket.close(1000, 'The stream ended.');
    } catch {
      // It closed already.
    }
    // The stream closes once the reader has taken every line. A stalled
    // reader is cut off, and one that stalls before it takes them all is cut
    // off then, so nothing waits on a reader for long.
    if (stalled()) {
      cutOff();
      return;
    }
    wake?.();
    if (waiting.length > 0) {
      setTimeout(() => {
        if (waiting.length > 0) cutOff();
      }, readerWaitMs);
    }
  };
  const timer = setTimeout(end, lifetimeMs);
  socket.addEventListener('message', ({ data }) => {
    if (!open) return;
    const event = parseEvent(data);
    if (event === null) {
      console.error('A stream skipped a malformed event.');
      return;
    }
    // A line that comes after the hour, or finds the reader stalled, ends the
    // stream in its place. The timer ends a quiet stream.
    if (Date.now() >= deadline || stalled()) {
      end();
      return;
    }
    waiting.push({ bytes: encoder.encode(line(event)), at: Date.now() });
    wake?.();
  });
  socket.addEventListener('close', end);
  socket.addEventListener('error', end);
  const readable = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        body = controller;
      },
      // The reader asks for a line. Give the oldest waiting, or wait for one.
      async pull(controller) {
        while (waiting.length === 0 && open) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        wake = null;
        const next = waiting.shift();
        try {
          if (next) controller.enqueue(next.bytes);
          else controller.close();
        } catch {
          // The stream was cut off meanwhile.
        }
      },
      // The reader went away, and the runtime cancels the body.
      cancel: end,
    },
    { highWaterMark: 0 },
  );
  return new Response(readable, { headers });
}
