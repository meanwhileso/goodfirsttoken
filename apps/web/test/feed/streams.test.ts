import { listDurableObjectIds, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { ClaimRecord, FeedEvent } from '@goodfirsttoken/core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { blockDonor, saveIssues, savePerson } from '../../src/db';
import { handleStream } from '../../src/feed/streams';
import { homeFeed, personFeed, type Feed } from '../../src/rooms/feed';
import { issueRoom } from '../../src/rooms/issue-room';
import { admin, db, emptyDatabase, kenji, maintainer, priya, registeredProject, repo, sha, signIn, t0 } from '../db/helpers';
import { feedEvent, readStream } from './helpers';

// The live text streams, read through the Worker the way `curl -N` reads
// them, while the issue room, the feed queue, and the feeds run as they do in
// production. Every person, repo, and line here is made up.

// Each test works on its own issue.
let issueNumber = 400;
let issue = '';

beforeEach(async () => {
  issueNumber += 1;
  issue = `${repo}#${String(issueNumber)}`;
  await emptyDatabase();
  await signIn(priya, kenji, admin, maintainer);
  await registeredProject();
});

afterEach(() => {
  vi.useRealTimers();
});

async function claim(person: { githubId: number; login: string }, agent = 'claude-code'): Promise<ClaimRecord> {
  const result = await issueRoom(env.ISSUE_ROOM, issue).claim({
    issue,
    project: repo,
    githubId: person.githubId,
    login: person.login,
    agent,
    ownProject: false,
    startCommit: sha,
    slots: 3,
  });
  if (!result.ok) throw new Error(result.refusal.message);
  return result.claim;
}

async function post(claimed: ClaimRecord, text: string): Promise<void> {
  const result = await issueRoom(env.ISSUE_ROOM, issue).postUpdate({
    claimId: claimed.id,
    githubId: claimed.githubId,
    text,
  });
  if (!result.ok || !result.posted) throw new Error(`The post was not stored: ${JSON.stringify(result)}`);
}

/** Moves the clock past the 10 seconds a claim waits between two posts. */
function nextPostTime(): void {
  const now = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now + 11_000);
}

/** Waits until an event with this text is in a feed, so the queue has delivered it. */
async function delivered(feed: DurableObjectStub<Feed>, text: string) {
  return vi.waitFor(
    async () => {
      const found = (await feed.history()).find((e) => e.text === text);
      expect(found, `"${text}" in the feed`).toBeDefined();
      return found as FeedEvent;
    },
    { timeout: 5000, interval: 50 },
  );
}

/** How many watchers a feed has. */
async function sockets(feed: DurableObjectStub): Promise<number> {
  return runInDurableObject(feed, (_, state) => state.getWebSockets().length);
}

const paths = () => ({
  home: '/live.txt',
  project: `/${repo}/live.txt`,
  issue: `/${repo}/issues/${String(issueNumber)}/live.txt`,
  person: `/@${priya.login}/live.txt`,
});

describe('a text stream', () => {
  test('shows a line on the homepage, project, issue, and person streams as it is posted', async () => {
    const priyas = await claim(priya);
    const streams = await Promise.all(Object.values(paths()).map((path) => readStream(path)));
    for (const stream of streams) expect(stream.res.status).toBe(200);

    const text = `wrote failing test for #${String(issueNumber)}: parseRange drops the last byte`;
    await post(priyas, text);

    for (const stream of streams) {
      const line = await stream.line(text);
      expect(line.split('\t')).toEqual([expect.any(String), 'priya', 'claude-code', issue, text]);
      await stream.cancel();
    }
  });

  test('is one line per event: time, user, agent, issue, and text, separated by tabs', async () => {
    const kenjis = await claim(kenji, 'codex');
    const stream = await readStream(paths().issue);

    const line = await stream.line('claimed the issue');

    const [time, ...rest] = line.split('\t');
    expect(rest).toEqual(['kenji', 'codex', issue, 'claimed the issue']);
    expect(new Date(time ?? '').getTime()).toBe(kenjis.claimedAt);
    expect(stream.res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    await stream.cancel();
  });

  test('keeps a text with tabs, line breaks, carriage returns, and terminal controls on one line', async () => {
    const priyas = await claim(priya);
    const reason = `tabs\there,\nnew\r\n   lines\rand \u001b[2Jcontrols\u2028too`;
    await issueRoom(env.ISSUE_ROOM, issue).release({ claimId: priyas.id, githubId: priya.githubId, reason });
    await delivered(homeFeed(env.FEED), `released: ${reason}`);

    for (const path of [paths().issue, paths().home]) {
      const stream = await readStream(path);
      const line = await stream.line('released: tabs');
      expect(line.split('\t')).toEqual([
        expect.any(String),
        'priya',
        'claude-code',
        issue,
        'released: tabs here, new lines and [2Jcontrols too',
      ]);
      await stream.cancel();
    }

    // The .ndjson form keeps the text as it was, escaped.
    const ndjson = await readStream(paths().issue.replace('.txt', '.ndjson'));
    const json = await ndjson.line('released: tabs');
    for (const raw of ['\u001b', '\u2028']) expect(json).not.toContain(raw);
    expect((JSON.parse(json) as FeedEvent).text).toBe(`released: ${reason}`);
    await ndjson.cancel();
  });

  test('shows a key or token in a post only as [redacted], in the streams and in what the feeds store', async () => {
    // Built at run time, so no token-shaped string sits in this file.
    const token = `ghp_${'aB3dE5gH7jK9'.repeat(3)}`;
    const priyas = await claim(priya);
    const streams = await Promise.all(Object.values(paths()).map((path) => readStream(path)));

    await post(priyas, `ran the smoke test for #${String(issueNumber)} with ${token}`);

    for (const stream of streams) {
      expect(await stream.line(`smoke test for #${String(issueNumber)}`)).toContain('with [redacted]');
      await stream.cancel();
    }
    for (const feed of [homeFeed(env.FEED), personFeed(env.FEED, priya.githubId)]) {
      expect(JSON.stringify(await feed.history())).not.toContain(token.slice(4));
    }
  });

  test('backfills from an event ID with ?since=', async () => {
    const priyas = await claim(priya);
    for (const text of ['one', 'two', 'three']) {
      nextPostTime();
      await post(priyas, `${text} of #${String(issueNumber)}`);
    }
    const two = await delivered(personFeed(env.FEED, priya.githubId), `two of #${String(issueNumber)}`);
    await delivered(personFeed(env.FEED, priya.githubId), `three of #${String(issueNumber)}`);

    for (const path of Object.values(paths())) {
      const stream = await readStream(`${path}?since=${two.id}`);
      await stream.line(`three of #${String(issueNumber)}`);
      expect(stream.lines.map((line) => line.split('\t')[4])).toEqual([`three of #${String(issueNumber)}`]);
      await stream.cancel();
    }
  });

  test('has an .ndjson form, with each event as one JSON object on its own line', async () => {
    const priyas = await claim(priya);
    const text = `added the NDJSON formatter for #${String(issueNumber)} (apps/web/src/feed/format.ts)`;
    await post(priyas, text);
    const event = await delivered(homeFeed(env.FEED), text);

    for (const path of Object.values(paths())) {
      const stream = await readStream(path.replace(/\.txt$/, '.ndjson'));
      expect(stream.res.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8');
      expect(JSON.parse(await stream.line(text))).toEqual(event);
      await stream.cancel();
    }
  });

  test('closes when its lifetime ends, and not before', async () => {
    // A stream lasts an hour. This one is given a second, which a timer in
    // the Worker's own request can count. A fake timer would run in the
    // test's, where the stream can't be closed.
    const reader = { githubId: 3301, login: 'sample-reader' };
    await signIn(reader);
    const feed = personFeed(env.FEED, reader.githubId);
    const request = new Request(`http://localhost/@${reader.login}/live.txt`);
    const stream = await readStream(await handleStream(request, { lifetimeMs: 1000 }));
    expect(stream.res.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(stream.ended()).toBe(false);
    expect(await sockets(feed)).toBe(1);

    await vi.waitFor(() => {
      expect(stream.ended()).toBe(true);
    }, { timeout: 3000 });
    // The feed answered the close, so no socket stays open.
    await vi.waitFor(async () => {
      expect(await sockets(feed)).toBe(0);
    });
  });

  test('ends when a line waits too long for the reader, so a stalled reader holds nothing up', async () => {
    // A stream gives a reader a minute. This one gives a tenth of a second,
    // and nothing reads it.
    const slow = { githubId: 3302, login: 'sample-slow-reader' };
    await signIn(slow);
    const feed = personFeed(env.FEED, slow.githubId);
    const request = new Request(`http://localhost/@${slow.login}/live.txt`);
    const res = await handleStream(request, { readerWaitMs: 100 });
    expect(res.status).toBe(200);
    const entry = () => ({ event: feedEvent({ user: slow.login }), githubId: slow.githubId });

    await feed.deliver([entry()]);
    expect(await sockets(feed)).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await feed.deliver([entry()]);

    await vi.waitFor(async () => {
      expect(await sockets(feed)).toBe(0);
    });
  });

  test('lets go of its socket on the feed when the reader goes away', async () => {
    const feed = personFeed(env.FEED, kenji.githubId);
    const stream = await readStream(`/@${kenji.login}/live.txt`);
    expect(await sockets(feed)).toBe(1);

    await stream.cancel();

    await vi.waitFor(async () => {
      expect(await sockets(feed)).toBe(0);
    });
  });
});

describe('who a stream is for', () => {
  test("follows a person by GitHub ID, so a login that changed hands shows its new owner's lines", async () => {
    const nadia = { githubId: 3201, login: 'nadia' };
    const newNadia = { githubId: 3202, login: 'nadia' };
    await signIn(nadia);
    const hers = await claim(nadia);
    const text = `first line of #${String(issueNumber)}`;
    await post(hers, text);
    await delivered(personFeed(env.FEED, nadia.githubId), text);

    // She renames her account, and someone else takes her old login.
    await savePerson(db, { githubId: nadia.githubId, login: 'nadia-renamed' }, t0 + 1);
    await savePerson(db, newNadia, t0 + 2);

    const renamed = await readStream('/@nadia-renamed/live.txt');
    expect(await renamed.line(text)).toContain('\tnadia\t');
    const taken = await readStream('/@NADIA/live.txt');
    expect(taken.res.status).toBe(200);
    await taken.line(text, 300).then(
      () => expect.fail('the new owner of the login got her line'),
      () => undefined,
    );
    await Promise.all([renamed.cancel(), taken.cancel()]);
  });

  test("a blocked donor's lines are hidden from every stream, those posted before the block included", async () => {
    const priyas = await claim(priya);
    const kenjis = await claim(kenji);
    const tag = `#${String(issueNumber)}`;
    await post(priyas, `priya before ${tag}`);
    await post(kenjis, `kenji before ${tag}`);
    await delivered(homeFeed(env.FEED), `priya before ${tag}`);
    await delivered(homeFeed(env.FEED), `kenji before ${tag}`);

    await blockDonor(db, { githubId: priya.githubId, reason: null, blockedBy: admin.githubId }, Date.now());

    const streams = await Promise.all(Object.values(paths()).map((path) => readStream(path)));
    nextPostTime();
    await post(priyas, `priya after ${tag}`);
    await post(kenjis, `kenji after ${tag}`);
    const [home, project, room, person] = streams;
    for (const stream of [home, project, room]) await stream?.line(`kenji after ${tag}`);
    // Priya's own stream has no line of hers to show.
    expect(person?.res.status).toBe(200);
    await delivered(personFeed(env.FEED, priya.githubId), `priya after ${tag}`);
    for (const stream of streams) {
      expect(stream.lines.filter((line) => line.includes('priya'))).toEqual([]);
      await stream.cancel();
    }
  });
});

describe('asking for a stream', () => {
  test('a repo that is not a project, an issue with no claim that no project tagged, or a login no one signed in with is not found', async () => {
    for (const path of [
      '/sample-owner/not-listed/live.txt',
      '/sample-owner/not-listed/issues/3/live.ndjson',
      `/${repo}/issues/${String(issueNumber)}/live.txt`,
      '/@nobody-signed-in/live.txt',
      '/@not_a_login/live.txt',
      '/sample-owner/sample-app/issues/0/live.txt',
    ]) {
      const res = await readStream(path);
      expect(res.res.status, path).toBe(404);
    }
    // Nothing made a room for the issue.
    const rooms = (await listDurableObjectIds(env.ISSUE_ROOM)).map(String);
    expect(rooms).not.toContain(String(env.ISSUE_ROOM.idFromName(issue.toLowerCase())));
  });

  test("an issue a project tagged has a stream before anyone claims it", async () => {
    await saveIssues(db, [
      { issue, project: repo, title: 'Sample issue', labels: ['help wanted'], linkedPr: null, syncedAt: t0 },
    ]);

    const stream = await readStream(paths().issue);

    expect(stream.res.status).toBe(200);
    await stream.cancel();
  });

  test('since has to be an event ID', async () => {
    const res = await readStream('/live.txt?since=not%20an%20id');

    expect(res.res.status).toBe(400);
  });

  test('a stream is read with GET', async () => {
    const res = await readStream('/live.txt', { method: 'POST' });

    expect(res.res.status).toBe(405);
    expect(res.res.headers.get('allow')).toBe('GET, HEAD');
  });

  test('a stream is public: it sets no cookie, is never cached, and any site may read it', async () => {
    await claim(priya);
    for (const path of Object.values(paths())) {
      const stream = await readStream(path);
      expect(stream.res.status, path).toBe(200);
      expect(stream.res.headers.get('set-cookie'), path).toBeNull();
      expect(stream.res.headers.get('cache-control'), path).toBe('no-store, no-transform');
      expect(stream.res.headers.get('access-control-allow-origin'), path).toBe('*');
      await stream.cancel();
    }
  });
});
