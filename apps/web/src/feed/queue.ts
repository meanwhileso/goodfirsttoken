import { describeProblems, feedMessageSchema, validate } from '@goodfirsttoken/core';
import { homeFeed, personFeed, repoFeed, type Feed, type FeedEntry } from '../rooms/feed';

// The feed queue's consumer (spec section 8). An issue room sends each event
// it stores to the queue, as a FeedMessage. The consumer delivers it to three
// feeds: the homepage's, the project's, and the claimant's. A message is
// acknowledged once all three have it. Otherwise it is tried again, and after
// the tries wrangler.jsonc allows, it goes to the dead-letter queue.

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
  for (const message of batch.messages) {
    const checked = validate(feedMessageSchema, message.body, 'message');
    if (!checked.ok) {
      // Trying again can't fix it, but the tries take it to the dead-letter
      // queue, where it can be read.
      console.error(`Feed message ${message.id} is malformed.\n${describeProblems(checked.problems)}`);
      failed.add(message);
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
    if (failed.has(message)) message.retry();
    else message.ack();
  }
}
