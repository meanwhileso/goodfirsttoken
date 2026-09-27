import { describeProblems, feedMessageSchema, validate } from '@goodfirsttoken/core';
import { homeFeed, personFeed, repoFeed, type Feed, type FeedEntry } from '../rooms/feed';

// The feed queue's consumer (spec section 8). An issue room sends each event
// it stores to the queue, as a FeedMessage. The consumer delivers it to three
// feeds: the homepage's, the project's, and the claimant's. A message is
// acknowledged once all three have it. Otherwise it is tried again, later
// each time, and after the tries wrangler.jsonc allows, it goes to the
// dead-letter queue. How long that takes is in docs/how-it-works.md.

/** How long a message waits before its first retry. Each later wait is twice as long. */
const RETRY_FIRST_SECONDS = 30;
/** The longest wait between two tries of a message. */
const RETRY_MAX_SECONDS = 60 * 60;

/** The wait before the next try of a message delivered `attempts` times. */
function retryDelay(attempts: number): number {
  return Math.min(RETRY_FIRST_SECONDS * 2 ** Math.min(Math.max(attempts, 1) - 1, 20), RETRY_MAX_SECONDS);
}

interface Delivery {
  feed: DurableObjectStub<Feed>;
  entries: FeedEntry[];
  messages: Message[];
}

/**
 * Delivers a batch from the feed queue. Each feed gets its events in one
 * call, in the order of the batch. A message whose feeds all took it is
 * acknowledged, and any other is tried again. A feed that already has an
 * event ignores it, so a retry never shows an event twice.
 */
export async function deliverFeedBatch(batch: MessageBatch, env: Pick<Env, 'FEED'>): Promise<void> {
  const deliveries = new Map<string, Delivery>();
  const add = (key: string, feed: () => DurableObjectStub<Feed>, message: Message, entry: FeedEntry) => {
    const delivery = deliveries.get(key) ?? { feed: feed(), entries: [], messages: [] };
    deliveries.set(key, delivery);
    delivery.entries.push(entry);
    delivery.messages.push(message);
  };

  const failed = new Set<Message>();
  const malformed = new Set<Message>();
  for (const message of batch.messages) {
    const checked = validate(feedMessageSchema, message.body, 'message');
    if (!checked.ok) {
      console.error(`Feed message ${message.id} is malformed.\n${describeProblems(checked.problems)}`);
      malformed.add(message);
      continue;
    }
    const { event, githubId, project } = checked.value;
    const entry = { event, githubId };
    add('home', () => homeFeed(env.FEED), message, entry);
    add(`repo:${project.toLowerCase()}`, () => repoFeed(env.FEED, project), message, entry);
    add(`person:${String(githubId)}`, () => personFeed(env.FEED, githubId), message, entry);
  }

  await Promise.all(
    [...deliveries].map(async ([key, { feed, entries, messages }]) => {
      try {
        await feed.deliver(entries);
      } catch (error) {
        console.warn(`The ${key} feed did not take ${String(messages.length)} events. They will be tried again.`, error);
        for (const message of messages) failed.add(message);
      }
    }),
  );

  for (const message of batch.messages) {
    // Trying a malformed message again can't fix it. Its tries go at once, to
    // take it to the dead-letter queue, where it can be read.
    if (malformed.has(message)) message.retry({ delaySeconds: 0 });
    else if (failed.has(message)) message.retry({ delaySeconds: retryDelay(message.attempts) });
    else message.ack();
  }
}
