import { utcDay, type FeedEvent } from '@goodfirsttoken/core';
import { env } from 'cloudflare:workers';
import { LIVE_LINES } from '../home/live';
import { siteAddress } from '../home/load';
import { homeFeed } from '../rooms/feed';

// What /live shows when it loads: the homepage's feed, which holds every
// event from everyone, with more of it than the homepage's wall. It runs on
// the server only: the route calls it through the server function in
// ./data.ts, then follows the feed over /live.ndjson.

export interface LivePage {
  /** How the site names itself, as on the homepage. */
  site: string;
  /** The feed's newest events, newest first, or null when the feed couldn't be read. */
  lines: FeedEvent[] | null;
}

/** The home feed's newest lines, as of `now`. */
export async function loadLive(request: Request, now = Date.now()): Promise<LivePage> {
  try {
    const glance = await homeFeed(env.FEED).glance({ count: LIVE_LINES, day: utcDay(now) });
    return { site: siteAddress(request), lines: glance === null ? null : glance.events.reverse() };
  } catch (error) {
    console.warn('/live could not read the home feed.', error);
    return { site: siteAddress(request), lines: null };
  }
}
