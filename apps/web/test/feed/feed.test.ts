import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { addToDoNotList, blockDonor, createProject, removeFromDoNotList, unblockDonor } from '../../src/db';
import { repoFeed, type Feed, type FeedEntry } from '../../src/rooms/feed';
import { admin, DAY, db, emptyDatabase, kenji, priya, signIn, t0 } from '../db/helpers';
import { feedEvent, storedEvents, watchSocket } from './helpers';

// A feed on its own, as the queue's consumer calls it. Every person, repo,
// and line here is made up.

// Each test gets a feed of its own.
let feedNumber = 0;
let feed: DurableObjectStub<Feed>;

beforeEach(async () => {
  feedNumber += 1;
  feed = repoFeed(env.FEED, `sample-owner/feed-${String(feedNumber)}`);
  await emptyDatabase();
  await signIn(priya, kenji, admin);
});

afterEach(() => {
  vi.useRealTimers();
});

// A D1 binding that refuses every query.
const downDb = {
  prepare() {
    throw new Error('D1 is down.');
  },
} as unknown as D1Database;

function by(person: { githubId: number; login: string }, text?: string): FeedEntry {
  return { event: feedEvent({ user: person.login, ...(text && { text }) }), githubId: person.githubId };
}

async function texts(since?: string): Promise<string[]> {
  return (await feed.history(since)).map((e) => e.text);
}

describe('a feed', () => {
  test('ignores a copy of an event the queue delivers again', async () => {
    const [one, two, three] = [by(priya, 'one'), by(priya, 'two'), by(kenji, 'three')];

    expect(await feed.deliver([one, two])).toEqual({ stored: 2 });
    expect(await feed.deliver([two, three, three])).toEqual({ stored: 1 });

    expect(await texts()).toEqual(['one', 'two', 'three']);
  });

  test('ignores a copy that comes more than a week later of an event it still keeps', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    const first = by(priya, 'first');
    await feed.deliver([first]);
    vi.setSystemTime(t0 + 7 * DAY + 1);
    await feed.deliver([by(kenji, 'second')]);

    expect(await feed.deliver([first])).toEqual({ stored: 0 });

    expect(await texts()).toEqual(['first', 'second']);
    const watcher = await watchSocket(feed, first.event.id);
    expect(await watcher.received(1)).toEqual(['second']);
  });

  test('keeps its history through a restart', async () => {
    await feed.deliver([by(priya, 'one'), by(kenji, 'two')]);
    const before = await feed.history();

    await evictDurableObject(feed);

    expect(await feed.history()).toEqual(before);
    expect(await feed.deliver([{ event: before[0] as FeedEntry['event'], githubId: priya.githubId }])).toEqual({
      stored: 0,
    });
    const watcher = await watchSocket(feed);
    expect(await watcher.received(2)).toEqual(['one', 'two']);
  });

  test('keeps its newest 1,000 events, and ignores a copy of one it dropped for 7 days', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    const entries = Array.from({ length: 1001 }, (_, i) => by(priya, `line ${String(i)}`));
    for (let i = 0; i < entries.length; i += 100) await feed.deliver(entries.slice(i, i + 100));

    const kept = await texts();
    expect(kept).toHaveLength(1000);
    expect(kept[0]).toBe('line 1');
    expect(kept.at(-1)).toBe('line 1000');

    const [dropped] = entries;
    if (!dropped) throw new Error('No entries were made.');
    expect(await feed.deliver([dropped])).toEqual({ stored: 0 });
    // Nearly 7 days on, a new event has the feed let go of what it no longer
    // needs, and the copy is still ignored.
    vi.setSystemTime(t0 + 7 * DAY - 1);
    await feed.deliver([by(kenji, 'a week later')]);
    expect(await feed.deliver([dropped])).toEqual({ stored: 0 });
    kept.shift();
    kept.push('a week later');
    // A watcher who last saw the dropped event gets everything the feed keeps.
    const watcher = await watchSocket(feed, dropped.event.id);
    expect(await watcher.received(1000)).toEqual(kept);
  });
});

describe("a feed's watchers", () => {
  test('get each new event as it arrives, one JSON feed event per message', async () => {
    const watcher = await watchSocket(feed);

    const entry = by(priya, 'wrote failing test: parseRange drops the last byte');
    await feed.deliver([entry]);

    await watcher.received(1);
    expect(watcher.events).toEqual([entry.event]);
  });

  test('a watcher that reconnects with the last event ID it saw gets only what it missed', async () => {
    const entries = ['one', 'two', 'three'].map((text) => by(priya, text));
    await feed.deliver(entries);

    const watcher = await watchSocket(feed, entries[0]?.event.id);

    expect(await watcher.received(2)).toEqual(['two', 'three']);
    await feed.deliver([by(kenji, 'four')]);
    expect(await watcher.received(3)).toEqual(['two', 'three', 'four']);
  });

  test('a watcher with no last event ID, or one the feed never had, gets the newest 100 first', async () => {
    const entries = Array.from({ length: 120 }, (_, i) => by(priya, `line ${String(i)}`));
    await feed.deliver(entries);
    const newest = entries.slice(-100).map((e) => e.event.text);

    for (const since of [undefined, 'e_never_sent_here']) {
      const watcher = await watchSocket(feed, since);
      expect(await watcher.received(100)).toEqual(newest);
    }
  });

  test('get what D1 kept from going out a minute later, from the alarm', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const watcher = await watchSocket(feed);
    // The running feed's D1 refuses every query from here.
    await runInDurableObject(feed, (instance) => {
      const live = instance as unknown as { env: Env };
      live.env = { ...live.env, DB: downDb };
    });
    // Far ahead of the real clock, so the alarm doesn't run on its own.
    const later = Date.UTC(2100, 0, 4, 12, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(later);

    await feed.deliver([by(priya, 'while D1 was down')]);

    expect(await runInDurableObject(feed, (_, state) => state.storage.getAlarm())).toBe(later + 60_000);
    expect(watcher.events).toEqual([]);
    await runInDurableObject(feed, (instance) => {
      (instance as unknown as { env: Env }).env = env;
    });
    await runDurableObjectAlarm(feed);
    expect(await watcher.received(1)).toEqual(['while D1 was down']);
    warnings.mockRestore();
  });

  test('get what an earlier delivery could not send them when the queue delivers a copy', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const watcher = await watchSocket(feed);
    await runInDurableObject(feed, (instance) => {
      const live = instance as unknown as { env: Env };
      live.env = { ...live.env, DB: downDb };
    });
    const entry = by(priya, 'stored, then D1 went down');
    await feed.deliver([entry]);
    await runInDurableObject(feed, (instance) => {
      (instance as unknown as { env: Env }).env = env;
    });

    expect(await feed.deliver([entry])).toEqual({ stored: 0 });

    expect(await watcher.received(1)).toEqual(['stored, then D1 went down']);
    warnings.mockRestore();
  });

  test('stay connected while the feed hibernates, and get the next event', async () => {
    await feed.deliver([by(priya, 'before the nap')]);
    const watcher = await watchSocket(feed);
    await watcher.received(1);

    await evictDurableObject(feed);
    await feed.deliver([by(priya, 'after the nap')]);

    expect(await watcher.received(2)).toEqual(['before the nap', 'after the nap']);
  });
});

describe('a blocked donor', () => {
  test("has their events hidden from the feed's watchers, the history stored before the block included", async () => {
    await feed.deliver([by(priya, 'priya before'), by(kenji, 'kenji before')]);

    await blockDonor(db, { githubId: priya.githubId, reason: null, blockedBy: admin.githubId }, Date.now());

    const watcher = await watchSocket(feed);
    expect(await watcher.received(1)).toEqual(['kenji before']);
    await feed.deliver([by(priya, 'priya during'), by(kenji, 'kenji during')]);
    expect(await watcher.received(2)).toEqual(['kenji before', 'kenji during']);
    // The feed still stores them, so lifting the block shows them again. Its
    // history leaves them out too.
    expect((await storedEvents(feed)).map((e) => e.text)).toEqual([
      'priya before',
      'kenji before',
      'priya during',
      'kenji during',
    ]);
    expect(await texts()).toEqual(['kenji before', 'kenji during']);

    await unblockDonor(db, priya.githubId);
    await feed.deliver([by(priya, 'priya after')]);
    expect(await watcher.received(3)).toEqual(['kenji before', 'kenji during', 'priya after']);
    const later = await watchSocket(feed);
    expect(await later.received(5)).toEqual(['priya before', 'kenji before', 'priya during', 'kenji during', 'priya after']);
  });

  test('a watcher who gives no last event ID still gets the newest events it may see', async () => {
    const kenjis = Array.from({ length: 100 }, (_, i) => by(kenji, `kenji ${String(i)}`));
    await feed.deliver([...kenjis, ...Array.from({ length: 30 }, (_, i) => by(priya, `priya ${String(i)}`))]);
    await blockDonor(db, { githubId: priya.githubId, reason: null, blockedBy: admin.githubId }, Date.now());

    const watcher = await watchSocket(feed);

    expect(await watcher.received(100)).toEqual(kenjis.map((e) => e.event.text));
  });
});

describe('a repo on the do-not-list', () => {
  function on(issue: string, text: string): FeedEntry {
    return { event: feedEvent({ issue, text }), githubId: kenji.githubId };
  }

  test("has the events on its issues hidden from the feed's watchers, the history stored before included, and they stay stored", async () => {
    await feed.deliver([on('sample-owner/sample-app#1', 'app before'), on('sample-owner/sample-tools#2', 'tools before')]);

    await addToDoNotList(db, { repo: 'Sample-Owner/Sample-App', reason: null, addedBy: admin.githubId }, Date.now());

    const watcher = await watchSocket(feed);
    expect(await watcher.received(1)).toEqual(['tools before']);
    await feed.deliver([on('sample-owner/sample-app#3', 'app during'), on('sample-owner/sample-tools#4', 'tools during')]);
    expect(await watcher.received(2)).toEqual(['tools before', 'tools during']);
    expect(await texts()).toEqual(['tools before', 'tools during']);
    expect((await storedEvents(feed)).map((e) => e.text)).toEqual(['app before', 'tools before', 'app during', 'tools during']);

    // Taking the repo off the list, as approving its maintainer's
    // registration does, shows them to a new watcher again.
    await removeFromDoNotList(db, 'sample-owner/sample-app');
    const later = await watchSocket(feed);
    expect(await later.received(4)).toEqual(['app before', 'tools before', 'app during', 'tools during']);
  });

  test('covers the issues of a project whose code repo is on it, where the project keeps them in another repo', async () => {
    await createProject(
      db,
      {
        repo: 'sample-owner/sample-code',
        status: 'approved',
        source: 'registered',
        policy: null,
        settings: { tags: ['help wanted'], issueRepo: 'sample-owner/sample-issues' },
        addedBy: kenji.githubId,
      },
      Date.now(),
    );
    await addToDoNotList(db, { repo: 'sample-owner/sample-code', reason: null, addedBy: admin.githubId }, Date.now());
    await feed.deliver([on('sample-owner/sample-issues#5', 'elsewhere'), on('sample-owner/sample-tools#6', 'tools')]);

    const watcher = await watchSocket(feed);

    expect(await watcher.received(1)).toEqual(['tools']);
  });

  test('a watcher who gives no last event ID still gets the newest events it may see, and a glance leaves them out', async () => {
    const tools = Array.from({ length: 100 }, (_, i) => on('sample-owner/sample-tools#1', `tools ${String(i)}`));
    const app = Array.from({ length: 30 }, (_, i) => on('sample-owner/sample-app#1', `app ${String(i)}`));
    await feed.deliver([...tools, ...app]);
    await addToDoNotList(db, { repo: 'sample-owner/sample-app', reason: null, addedBy: admin.githubId }, Date.now());

    const watcher = await watchSocket(feed);
    const glance = await feed.glance({ count: 5, day: '2100-01-04' });

    expect(await watcher.received(100)).toEqual(tools.map((e) => e.event.text));
    expect(glance?.events.map((e) => e.text)).toEqual(tools.slice(-5).map((e) => e.event.text));
  });
});

describe('a glance at a feed, which a page shows first', () => {
  // The day feedEvent's times fall on.
  const day = '2100-01-04';

  async function glanceAt(count: number, on = day) {
    const glance = await feed.glance({ count, day: on });
    if (glance === null) throw new Error('The feed could not say who is blocked.');
    return glance;
  }

  test('gives the newest events a watcher may see, oldest first, and how many happened on a UTC day', async () => {
    const entries = ['one', 'two', 'three', 'four'].map((text) => by(priya, text));
    const late = { event: feedEvent({ time: '2100-01-03T23:59:59.999Z', text: 'late' }), githubId: kenji.githubId };
    await feed.deliver([...entries, late]);

    const glance = await glanceAt(3);

    expect(glance.events.map((e) => e.text)).toEqual(['three', 'four', 'late']);
    expect(glance.dayCount).toBe(4);
    expect((await glanceAt(3, '2100-01-03')).dayCount).toBe(1);
  });

  test('counts every event of the day, the ones the feed has dropped since included, and a copy once', async () => {
    const entries = Array.from({ length: 1001 }, (_, i) => by(priya, `line ${String(i)}`));
    for (let i = 0; i < entries.length; i += 100) await feed.deliver(entries.slice(i, i + 100));
    await feed.deliver(entries.slice(999));

    expect(await storedEvents(feed)).toHaveLength(1000);
    expect((await glanceAt(1)).dayCount).toBe(1001);
  });

  test("keeps a day's count for a week after the day, then drops it", async () => {
    const now = Date.UTC(2100, 0, 20, 12);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const at = (time: string, person = priya) => ({ event: feedEvent({ time }), githubId: person.githubId });
    await feed.deliver([at('2100-01-12T23:59:59.999Z'), at('2100-01-13T00:00:00.000Z')]);

    await feed.deliver([at(new Date(now).toISOString(), kenji)]);

    // The week before 2100-01-20 12:00 starts on 2100-01-13.
    expect((await glanceAt(1, '2100-01-12')).dayCount).toBe(0);
    expect((await glanceAt(1, '2100-01-13')).dayCount).toBe(1);
    expect((await glanceAt(1, '2100-01-20')).dayCount).toBe(1);
  });

  test("leaves a blocked donor's events out of both", async () => {
    await feed.deliver([by(priya, 'priya'), by(kenji, 'kenji'), by(priya, 'priya again')]);
    await blockDonor(db, { githubId: priya.githubId, reason: null, blockedBy: admin.githubId }, Date.now());

    const glance = await glanceAt(100);

    expect(glance.events.map((e) => e.text)).toEqual(['kenji']);
    expect(glance.dayCount).toBe(1);
  });

  test('is null when D1 cannot say who is blocked, so nothing that should be hidden shows', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await feed.deliver([by(priya, 'one')]);
    await runInDurableObject(feed, (instance) => {
      const live = instance as unknown as { env: Env };
      live.env = { ...live.env, DB: downDb };
    });

    expect(await feed.glance({ count: 5, day })).toBeNull();
    warnings.mockRestore();
  });
});
