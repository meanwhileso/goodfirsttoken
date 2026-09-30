import type { FeedEvent } from '@goodfirsttoken/core';
import { useState } from 'react';
import type { WallLine } from '../components/Wall';
import { toWallLine } from '../home/live';
import { useLiveFeed } from './useLiveFeed';

/**
 * A wall's lines: the events a page loaded with, newest first, then each
 * event from the feed's socket at `path`, like `/live.ndjson`, on top,
 * keeping the newest `keep`. It follows the feed from after the newest
 * event the page loaded with. A project's page, a person's page, and /live
 * show their walls with it.
 */
export function useWallFeed(path: string, loaded: readonly FeedEvent[] | null, keep: number): WallLine[] {
  const [lines, setLines] = useState(() => (loaded ?? []).map(toWallLine));
  useLiveFeed(path, loaded?.[0]?.id ?? null, (event) => {
    setLines((prev) => [toWallLine(event), ...prev].slice(0, keep));
  });
  return lines;
}
