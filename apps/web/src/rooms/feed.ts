import { DurableObject } from 'cloudflare:workers';
import { feedEventSchema, githubId, mustParse, repoName, type FeedEvent } from '@goodfirsttoken/core';
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

const DAY = 24 * 60 * 60 * 1000;

/** How many events a feed keeps. Older ones are dropped as new ones arrive. */
export const FEED_KEEPS = 1000;
/** How many of its newest events a feed sends a watcher who gives no `since`. */
export const FEED_TAIL = 100;
/** How long a feed remembers the ID of an event it no longer keeps, to ignore a second copy. */
export const FEED_REMEMBERS_MS = 7 * DAY;

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
`;

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
    let stored = 0;
    for (const entry of entries) {
      const event = mustParse(feedEventSchema, entry.event, 'event');
      const claimant = mustParse(githubId, entry.githubId, 'githubId');
      const fresh = this.sql.exec('INSERT OR IGNORE INTO seen (id, at) VALUES (?, ?)', event.id, now).rowsWritten > 0;
      if (!fresh) continue;
      this.sql.exec(
        'INSERT INTO events (id, github_id, event) VALUES (?, ?, ?)',
        event.id,
        claimant,
        JSON.stringify(event),
      );
      stored += 1;
    }
    // Keep the newest events, and the IDs of the last week and of every
    // event kept.
    this.sql.exec(
      'DELETE FROM events WHERE seq < (SELECT seq FROM events ORDER BY seq DESC LIMIT 1 OFFSET ?)',
      FEED_KEEPS - 1,
    );
    this.sql.exec('DELETE FROM seen WHERE at < ? AND id NOT IN (SELECT id FROM events)', now - FEED_REMEMBERS_MS);
    if (stored > 0) await sendToWatchers(this.ctx, this.env.DB, (seq) => this.after(seq));
    return { stored };
  }

  /**
   * The events the feed keeps after the one with ID `since`, oldest first.
   * With no `since`, or one the feed doesn't keep, every event it keeps.
   * Blocked donors' events are included. Watchers never get those.
   */
  history(since?: string | null): FeedEvent[] {
    const at = typeof since === 'string' ? this.placeOf(since) : null;
    return this.after(at ?? 0).map((event) => mustParse(feedEventSchema, JSON.parse(event.json), 'event'));
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
    return openWatcher(this.ctx, this.env.DB, {
      history: () => {
        const at = since === null ? null : this.placeOf(since);
        return this.after(at ?? 0);
      },
      last: () => this.last(),
      tail: since !== null && this.remembers(since) ? undefined : FEED_TAIL,
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

  private last(): number {
    const [row] = this.sql.exec<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM events').toArray();
    return row?.seq ?? 0;
  }
}
