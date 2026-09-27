import { env } from 'cloudflare:workers';
import type { FeedMessage } from '@goodfirsttoken/core';
import { describe, expect, test, vi } from 'vitest';
import { homeFeed, personFeed, repoFeed, type Feed } from '../../src/rooms/feed';
import worker from '../../src/server';
import { feedEvent } from './helpers';

// The feed queue's consumer, given batches the way Queues gives them. Every
// person, repo, and line here is made up.

const HOUR_IN_SECONDS = 60 * 60;

let sent = 0;

function feedMessage(changes: Partial<FeedMessage> = {}): FeedMessage {
  return { event: feedEvent(), githubId: 4001, project: 'sample-owner/queue-app', ...changes };
}

/**
 * Runs the Worker's queue handler on a batch, and says what it did with each
 * message: acknowledged it, or asked for it again after how many seconds.
 * Each message is on its first delivery unless it says otherwise.
 */
async function consume(messages: unknown[], bindings: Env = env) {
  const acked: string[] = [];
  const retried: { id: string; delaySeconds: number | undefined }[] = [];
  const batch = {
    queue: 'feed',
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    messages: messages.map((given) => {
      sent += 1;
      const id = `m${String(sent)}`;
      const { body, attempts } =
        typeof given === 'object' && given !== null && 'attempts' in given
          ? (given as { body: unknown; attempts: number })
          : { body: given, attempts: 1 };
      return {
        id,
        timestamp: new Date(),
        attempts,
        body,
        ack: () => acked.push(id),
        retry: (options?: QueueRetryOptions) => retried.push({ id, delaySeconds: options?.delaySeconds }),
      };
    }),
    ackAll: () => undefined,
    retryAll: () => undefined,
  };
  await worker.queue(batch, bindings);
  return { acked, retried, ids: batch.messages.map((m) => m.id) };
}

async function inFeed(feed: DurableObjectStub<Feed>, id: string) {
  return (await feed.history()).filter((e) => e.id === id).length;
}

/** The Worker's bindings with the feed of this name refusing every delivery. */
function refusing(name: string): Env {
  return {
    ...env,
    FEED: new Proxy(env.FEED, {
      get(target, key) {
        if (key !== 'getByName') return Reflect.get(target, key) as unknown;
        return (asked: string) =>
          asked === name ? { deliver: () => Promise.reject(new Error('The feed is down.')) } : target.getByName(asked);
      },
    }),
  };
}

describe('the feed queue', () => {
  test("delivers each event to the homepage's feed, the project's, and the claimant's, and acknowledges it", async () => {
    const first = feedMessage({ githubId: 4001, project: 'sample-owner/queue-app' });
    const second = feedMessage({ githubId: 4002, project: 'Sample-Owner/Other-App' });

    const { acked, ids } = await consume([first, second]);

    expect(acked).toEqual(ids);
    for (const { event, githubId, project } of [first, second]) {
      expect(await inFeed(homeFeed(env.FEED), event.id)).toBe(1);
      expect(await inFeed(repoFeed(env.FEED, project), event.id)).toBe(1);
      expect(await inFeed(personFeed(env.FEED, githubId), event.id)).toBe(1);
    }
    // Each event is in its own project's and person's feed only.
    expect(await inFeed(repoFeed(env.FEED, 'sample-owner/other-app'), first.event.id)).toBe(0);
    expect(await inFeed(personFeed(env.FEED, 4002), first.event.id)).toBe(0);
  });

  test('a message the queue delivers twice shows its event once in every feed', async () => {
    const twice = feedMessage({ githubId: 4003 });

    await consume([twice]);
    await consume([twice, twice]);

    expect(await inFeed(homeFeed(env.FEED), twice.event.id)).toBe(1);
    expect(await inFeed(repoFeed(env.FEED, twice.project), twice.event.id)).toBe(1);
    expect(await inFeed(personFeed(env.FEED, 4003), twice.event.id)).toBe(1);
  });

  test.each([
    ['homepage', 'home', { githubId: 4005, project: 'sample-owner/refusing-home' }],
    ['project', 'repo:sample-owner/refusing-repo', { githubId: 4006, project: 'Sample-Owner/Refusing-Repo' }],
    ['person', 'person:4099', { githubId: 4099, project: 'sample-owner/refusing-person' }],
  ] as const)(
    "a message the %s feed doesn't take is tried again, and one that feed isn't in is acknowledged",
    async (_, name, facts) => {
      const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const fails = feedMessage(facts);
      // Every message is in the homepage's feed, so none gets past it.
      const lands = feedMessage({ githubId: 4004, project: 'sample-owner/queue-app' });

      const { acked, retried, ids } = await consume(name === 'home' ? [fails] : [fails, lands], refusing(name));

      expect(retried.map((r) => r.id)).toEqual([ids[0]]);
      expect(acked).toEqual(name === 'home' ? [] : [ids[1]]);
      expect(warnings).toHaveBeenCalled();
      warnings.mockRestore();
      // The retry reaches the feeds that took it already, which ignore it.
      await consume([fails]);
      expect(await inFeed(homeFeed(env.FEED), fails.event.id)).toBe(1);
      expect(await inFeed(repoFeed(env.FEED, fails.project), fails.event.id)).toBe(1);
      expect(await inFeed(personFeed(env.FEED, fails.githubId), fails.event.id)).toBe(1);
    },
  );

  test("a message a feed doesn't take comes again after 30 seconds, then twice as long each time, up to an hour", async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // A message is delivered at most 91 times: once, and 90 retries.
    const tries = [1, 2, 3, 7, 8, 50, 91];

    const { retried } = await consume(
      tries.map((attempts) => ({ body: feedMessage({ githubId: 4099 }), attempts })),
      refusing('person:4099'),
    );

    expect(retried.map((r) => r.delaySeconds)).toEqual([30, 60, 120, 1920, HOUR_IN_SECONDS, HOUR_IN_SECONDS, HOUR_IN_SECONDS]);
    warnings.mockRestore();
  });

  test('a malformed message is tried again at once, so its tries take it to the dead-letter queue', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const good = feedMessage();

    const { acked, retried, ids } = await consume([{ event: { text: 'no ID' } }, good]);

    expect(retried).toEqual([{ id: ids[0], delaySeconds: 0 }]);
    expect(acked).toEqual([ids[1]]);
    expect(errors).toHaveBeenCalledOnce();
    errors.mockRestore();
  });
});
