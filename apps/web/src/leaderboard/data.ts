import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { PAGE_STATUS_HEADER } from '../mcp/paths';
import { loadLeaderboard, type LeaderboardResult } from './load';

export type { Board, LeaderboardPage, LeaderboardResult } from './load';

// Runs on the server when the leaderboard loads, and when someone navigates
// to it. It reads no cookie and sets none. When the database can't answer,
// the page says so with 503, which src/server.ts sets from
// PAGE_STATUS_HEADER.
export const getLeaderboard = createServerFn({ method: 'GET' }).handler(async (): Promise<LeaderboardResult> => {
  const board = await loadLeaderboard();
  if (board.state === 'unavailable') setResponseHeader(PAGE_STATUS_HEADER, '503');
  return board;
});
