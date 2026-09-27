import { DurableObject } from 'cloudflare:workers';
import { feedEventSchema, githubId, mustParse, repoName, utcDay, wholeNumber, type FeedEvent } from '@goodfirsttoken/core';
import { blockedAmong } from '../db/blocks';
import { answerClose, openWatcher, sendToWatchers, type StoredEvent } from './watchers';

// A live feed (spec section 8). One class serves three kinds of feed: the
// homepage's, each repo's, and each person's. The feed queue's consumer
// delivers every event to the three feeds it belongs in. A feed stores the
// newest events and streams them to the people watching over WebSockets, the
// way an issue room does.
//
// Queues can deliver a message twice, so a feed remembers the ID of every
// event it got in the last week, and of every event it keeps, and ignores an
// ID it has already had.
//
// A feed also counts its events by the UTC day they happened and by
// claimant, so a page can say how many there were today with blocked
// donors' left out, however many the feed has dropped since.

const DAY = 24 * 60 * 60 * 1000;

/** How many events a feed keeps. Older ones are dropped as new ones arrive. */
const FEED_KEEPS = 1000;
/** How many of its newest events a feed sends a watcher who gives no `since`. */
const FEED_TAIL = 100;
/** How long a feed remembers the ID of an event it no longer keeps, to ignore a second copy. */
const FEED_REMEMBERS_MS = 7 * DAY;
/** How long a feed keeps a day's count after the day. */
const DAY_COUNTS_KEPT_MS = 7 * DAY;
// How soon a send to the watchers that D1 kept from going out is tried again.
const WATCHERS_RETRY_MS = 60 * 1000;

/** An event for a feed, with the GitHub ID of the claimant it is about. */
export interface FeedEntry {
  event: FeedEvent;
  githubId: number;
}

/** The homepage's feed: every event from everyone. */
export function homeFeed(namespace: DurableObjectNamespace<Feed>): DurableObjectStub<Feed> {
  return namespace.getByName('home');
}

/** A project's feed, by its code repo. Repo names compare without case. */
export function repoFeed(namespace: DurableObjectNamespace<Feed>, repo: string): DurableObjectStub<Feed> {
  return namespace.getByName(`repo:${mustParse(repoName, repo, 'repo').toLowerCase()}`);
}

/** A person's feed, by their numeric GitHub ID, since a login can change hands. */
export function personFeed(namespace: DurableObjectNamespace<Feed>, id: number): DurableObjectStub<Feed> {
  return namespace.getByName(`person:${String(mustParse(githubId, id, 'githubId'))}`);
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    github_id INTEGER NOT NULL,
    event TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, at INTEGER NOT NULL) STRICT;
  CREATE INDEX IF NOT EXISTS seen_by_time ON seen (at);
  CREATE TABLE IF NOT EXISTS day_counts (
    day TEXT NOT NULL,
    github_id INTEGER NOT NULL,
    events INTEGER NOT NULL,
    PRIMARY KEY (day, github_id)
  ) STRICT;
`;

const UTC_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** What a page shows first from a feed: its newest events, and how many there were on one day. */
export interface FeedGlance {
  /** The newest events a watcher may see, oldest first. */
  events: FeedEvent[];
  /** How many events happened on the day asked about, blocked donors' left out. */
  dayCount: number;
}

type EventRow = { seq: number; github_id: number; event: string };

function toStored(row: EventRow): StoredEvent {
  return { seq: row.seq, githubId: row.github_id, json: row.event };
}

export class Feed extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  /**
   * Stores each event the feed hasn't had, in the order given, and sends the
   * new ones to the watchers. An event the feed keeps, or got in the last
   * week, is ignored. Returns how many were new.
   */
  async deliver(entries: FeedEntry[]): Promise<{ stored: number }> {
    const now = Date.now();
    // Every entry is checked before any is stored.
    const checked = entries.map((entry) => ({
      event: mustParse(feedEventSchema, entry.event, 'event'),
      githubId: mustParse(githubId, entry.githubId, 'githubId'),
    }));
    let stored = 0;
    for (const { event, githubId: claimant } of checked) {
      const fresh = this.sql.exec('INSERT OR IGNORE INTO seen (id, at) VALUES (?, ?)', event.id, now).rowsWritten > 0;
      if (!fresh) continue;
      this.sql.exec(
        'INSERT INTO events (id, github_id, event) VALUES (?, ?, ?)',
        event.id,
        claimant,
        JSON.stringify(event),
      );
      this.sql.exec(
        `INSERT INTO day_counts (day, github_id, events) VALUES (?, ?, 1)
         ON CONFLICT (day, github_id) DO UPDATE SET events = events + 1`,
        utcDay(event.time),
        claimant,
      );
      stored += 1;
    }
    if (stored > 0) {
      // Keep the newest events, the IDs of the last week and of every event
      // kept, and the counts of the last week.
      this.sql.exec(
        'DELETE FROM events WHERE seq < (SELECT seq FROM events ORDER BY seq DESC LIMIT 1 OFFSET ?)',
        FEED_KEEPS - 1,
      );
      this.sql.exec('DELETE FROM seen WHERE at < ? AND id NOT IN (SELECT id FROM events)', now - FEED_REMEMBERS_MS);
      this.sql.exec('DELETE FROM day_counts WHERE day < ?', utcDay(now - DAY_COUNTS_KEPT_MS));
    }
    // Also when every event was a copy: the queue may be trying again
    // because an earlier call stored the events and then failed.
    await this.sendToWatchers();
    return { stored };
  }

  /** Tries again to send the watchers what D1 kept from going out. */
  override async alarm(): Promise<void> {
    await this.sendToWatchers();
  }

  /**
   * The events the feed keeps after the one with ID `since`, oldest first,
   * without blocked donors' events. With no `since`, or one the feed doesn't
   * keep, every event it keeps. Throws when D1 can't say who is blocked.
   */
  async history(since?: string | null): Promise<FeedEvent[]> {
    const at = typeof since === 'string' ? this.placeOf(since) : null;
    const events = this.after(at ?? 0);
    const blocked = await blockedAmong(
      this.env.DB,
      events.map((event) => event.githubId),
    );
    return events
      .filter((event) => !blocked.has(event.githubId))
      .map((event) => mustParse(feedEventSchema, JSON.parse(event.json), 'event'));
  }

  /**
   * The newest `count` events a watcher may see, up to 100, oldest first,
   * and how many events happened on `day`, a UTC day like 2026-09-27. Blocked
   * donors' events are left out of both. A page shows these first, then
   * opens a watcher's socket with the newest event's ID as `since`. Null
   * when D1 can't say who is blocked, so nothing that should be hidden
   * shows. The runtime reports an error thrown in a Durable Object as
   * uncaught, so this answers null in its place.
   */
  async glance({ count, day }: { count: number; day: string }): Promise<FeedGlance | null> {
    const size = mustParse(wholeNumber(1, FEED_TAIL), count, 'count');
    if (!UTC_DAY.test(day)) throw new TypeError('day must be a UTC day, like 2026-09-27.');
    // As for a new watcher: D1 is asked about each donor not asked about
    // yet, and the feed is read again, until no donor in it is new.
    const known = new Set<number>();
    const blocked = new Set<number>();
    for (;;) {
      const events = this.newest(size, blocked);
      const counts = this.sql
        .exec<{ github_id: number; events: number }>('SELECT github_id, events FROM day_counts WHERE day = ?', day)
        .toArray();
      const ids = [...events.map((event) => event.githubId), ...counts.map((row) => row.github_id)];
      const unknown = [...new Set(ids)].filter((id) => !known.has(id));
      if (unknown.length === 0) {
        return {
          events: events.map((event) => mustParse(feedEventSchema, JSON.parse(event.json), 'event')),
          dayCount: counts.reduce((sum, row) => (blocked.has(row.github_id) ? sum : sum + row.events), 0),
        };
      }
      try {
        for (const id of await blockedAmong(this.env.DB, unknown)) blocked.add(id);
      } catch (error) {
        console.warn('A glance at a feed was turned away, because D1 could not say which donors are blocked.', error);
        return null;
      }
      for (const id of unknown) known.add(id);
    }
  }

  /**
   * Opens a WebSocket for a watcher, with each event as JSON in its own
   * message. `?since=<event ID>` of an event the feed keeps, or got in the
   * last week, sends every event it keeps after that one first. Without it,
   * or with any other ID, the newest 100 come first. Then every new event, as
   * it arrives. A blocked donor's events are left out.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Connect with a WebSocket.\n', { status: 426, headers: { Upgrade: 'websocket' } });
    }
    const since = new URL(request.url).searchParams.get('since');
    const resumes = since !== null && this.remembers(since);
    return openWatcher(this.ctx, this.env.DB, {
      // Only the events it sends are read: every one after `since`, or the
      // newest 100 of donors not known to be blocked.
      history: (blocked) => (resumes ? this.after(this.placeOf(since) ?? 0) : this.newest(FEED_TAIL, blocked)),
      last: () => this.last(),
    });
  }

  // Watchers only listen. What they send is ignored.
  override webSocketMessage(): void {
    // Nothing to do.
  }

  override webSocketClose(socket: WebSocket, code: number, reason: string): void {
    answerClose(socket, code, reason);
  }

  /**
   * Sends new events to the watchers. When D1 can't say who is blocked, the
   * alarm tries again a minute later.
   */
  private async sendToWatchers(): Promise<void> {
    if ((await sendToWatchers(this.ctx, this.env.DB, (seq) => this.after(seq))) !== null) return;
    await this.ctx.storage.setAlarm(Date.now() + WATCHERS_RETRY_MS);
  }

  /**
   * Where an event the feed got sits in its order. For an event it has
   * dropped but remembers, the place before every event it keeps.
   */
  private placeOf(id: string): number | null {
    const [kept] = this.sql.exec<{ seq: number }>('SELECT seq FROM events WHERE id = ?', id).toArray();
    if (kept) return kept.seq;
    return this.remembers(id) ? 0 : null;
  }

  private remembers(id: string): boolean {
    return this.sql.exec('SELECT 1 FROM seen WHERE id = ?', id).toArray().length > 0;
  }

  private after(seq: number): StoredEvent[] {
    return this.sql
      .exec<EventRow>('SELECT seq, github_id, event FROM events WHERE seq > ? ORDER BY seq', seq)
      .toArray()
      .map(toStored);
  }

  /** The newest `count` events, oldest first, leaving out the donors in `skip`. */
  private newest(count: number, skip: ReadonlySet<number>): StoredEvent[] {
    return this.sql
      .exec<EventRow>(
        `SELECT seq, github_id, event FROM events
         WHERE github_id NOT IN (SELECT value FROM json_each(?)) ORDER BY seq DESC LIMIT ?`,
        JSON.stringify([...skip]),
        count,
      )
      .toArray()
      .map(toStored)
      .reverse();
  }

  private last(): number {
    const [row] = this.sql.exec<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM events').toArray();
    return row?.seq ?? 0;
  }
}
