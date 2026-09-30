import type { TokenSquare } from '../components/TokenField';

// A person's activity graph, for the server and the page alike: one square
// for each UTC day of the last 52 weeks, a column for each week from Monday
// to Sunday, the current week last.

const DAY = 24 * 60 * 60 * 1000;

/** How many weeks the graph shows. */
export const ACTIVITY_WEEKS = 52;

/** A day's work: claims made and PRs merged or closed, and whether one merged. */
export interface DayWork {
  /** The UTC day, like 2026-09-27. */
  day: string;
  events: number;
  merged: boolean;
}

/**
 * How bright a day is: none, 1, 2, 3 or 4, and 5 or more, up to the
 * brightest. A day a PR merged is green, however busy.
 */
export function levelOf(work: Pick<DayWork, 'events' | 'merged'> | undefined): TokenSquare {
  if (!work || work.events === 0) return 0;
  if (work.merged) return 'merged';
  if (work.events >= 5) return 4;
  if (work.events >= 3) return 3;
  return work.events as 1 | 2;
}

/** When the graph starts: the Monday 51 weeks before the one that holds `thisWeek`. */
export function activityStart(thisWeek: number): number {
  return thisWeek - (ACTIVITY_WEEKS - 1) * 7 * DAY;
}

/**
 * The graph's squares, row by row: the Mondays of each week, oldest first,
 * then the Tuesdays, down to the Sundays. So a grid of 52 columns shows a
 * week in each column. `start` is the Monday it starts on, at 00:00 UTC.
 */
export function activitySquares(days: readonly DayWork[], start: number): TokenSquare[] {
  const byDay = new Map(days.map((work) => [work.day, work]));
  const squares: TokenSquare[] = [];
  for (let weekday = 0; weekday < 7; weekday++) {
    for (let week = 0; week < ACTIVITY_WEEKS; week++) {
      const day = new Date(start + (week * 7 + weekday) * DAY).toISOString().slice(0, 10);
      squares.push(levelOf(byDay.get(day)));
    }
  }
  return squares;
}
