import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { FeedMessage } from '@goodfirsttoken/core';
import { describe, expect, test, vi } from 'vitest';
import { homeFeed, personFeed, repoFeed, type Feed } from '../../src/rooms/feed';
import worker from '../../src/server';
import { feedEvent } from './helpers';

// The feed queue's consumer, given batches the way Queues gives them. Every
// person, repo, and line here is made up.

let sent = 0;

function message(body: unknown) {
  sent += 1;
  return { id: `m${String(sent)}`, timestamp: new Date(), attempts: 1, body };
}

function feedMessage(changes: Partial<FeedMessage> = {}): FeedMessage {
  return { event: feedEvent(), githubId: 4001, project: 'sample-owner/queue-app', ...changes };
}

// What getQueueResult gives. The pool's types name it, and the Workers types
// no longer define it.
interface QueueResult {
  explicitAcks: string[];
  retryMessages: { msgId: string }[];
}

/** Runs the Worker's queue handler on a batch, and says what it did with each message. */
async function consume(bodies: unknown[], bindings: Env = env) {
  const batch = createMessageBatch('feed', bodies.map(message));
  const ctx = createExecutionContext();
  await worker.queue(batch, bindings);
  const result = (await getQueueResult(batch, ctx)) as QueueResult;
  return {
    acked: result.explicitAcks,
    retried: result.retryMessages.map((m) => m.msgId),
    ids: batch.messages.map((m) => m.id),
  };
}

async function inFeed(feed: DurableObjectStub<Feed>, id: string) {
  return (await feed.history()).filter((e) => e.id === id).length;
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

  test("a message whose feed doesn't take it is tried again, and the others in the batch are acknowledged", async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Person 4099's feed refuses every delivery.
    const refusing: Env = {
      ...env,
      FEED: new Proxy(env.FEED, {
        get(target, key) {
          if (key !== 'getByName') return Reflect.get(target, key) as unknown;
          return (name: string) =>
            name === 'person:4099'
              ? { deliver: () => Promise.reject(new Error('The feed is down.')) }
              : target.getByName(name);
        },
      }),
    };
    const fails = feedMessage({ githubId: 4099 });
    const lands = feedMessage({ githubId: 4004 });

    const { acked, retried, ids } = await consume([fails, lands], refusing);

    expect(retried).toEqual([ids[0]]);
    expect(acked).toEqual([ids[1]]);
    expect(warnings).toHaveBeenCalled();
    warnings.mockRestore();
    // The retry reaches the feeds that took it already, which ignore it.
    await consume([fails]);
    expect(await inFeed(homeFeed(env.FEED), fails.event.id)).toBe(1);
    expect(await inFeed(personFeed(env.FEED, 4099), fails.event.id)).toBe(1);
  });

  test('a malformed message is tried again, so its tries take it to the dead-letter queue', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const good = feedMessage();

    const { acked, retried, ids } = await consume([{ event: { text: 'no ID' } }, good]);

    expect(retried).toEqual([ids[0]]);
    expect(acked).toEqual([ids[1]]);
    expect(errors).toHaveBeenCalledOnce();
    errors.mockRestore();
  });
});
