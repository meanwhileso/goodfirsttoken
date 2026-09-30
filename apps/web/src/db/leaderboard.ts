import { agentName, count, githubId, githubLogin, mustParse, repoName } from '@goodfirsttoken/core';
import { checkTime } from './shared';
import { CLAIM_SHOWN, SHOWN } from './shown';
import { HAS_PAGE } from './waiting';

// The leaderboard's counts, in one query that every ranking uses: the
// leaderboard's views, the homepage's merged this week, a project's top
// helpers, and a person's totals and the projects they helped on their
// page. docs/how-it-works.md, under The leaderboard, has the rules.
//
// Each of a PR's facts counts in the range its own time falls in: an opened
// PR by when it opened, and a merged or closed PR by when it merged or
// closed. A merged PR's close time is when it merged, so merged PRs read the
// indexed close time. Issues worked and tokens count the claims made in the
// range. Work on the claimant's own project counts only in its own column.

const DAY = 24 * 60 * 60 * 1000;

/** What the rows group by: people, agents, or projects. */
export type TallyGroup = 'person' | 'agent' | 'project';

/** Which work counts. Each part left out means no limit on it. */
export interface TallyScope {
  /** Work in the range from `from` up to `until`, both in ms since the epoch. */
  range?: { from: number; until: number };
  /** Only claims on this project, by its code repo. */
  project?: string;
  /** Only this person's claims, by GitHub ID. */
  person?: number;
}

/** One row of counts: a person, an agent, or a project. */
export interface Tally {
  /** A person's GitHub ID, an agent's name, or a project's code repo as it was saved. */
  key: string;
  /** A person's login now. Null for an agent or a project. */
  login: string | null;
  /**
   * The agent of the latest PR from someone else's project that merged in
   * the scope, or else of the latest PR in it, or else of the latest claim
   * in it on someone else's project. Null for an agent's row.
   */
  agent: string | null;
  /** PRs merged, from claims on someone else's project. What the rows rank by. */
  merged: number;
  /** PRs closed without merging, from claims on someone else's project. */
  closed: number;
  /** PRs opened, from claims on someone else's project. */
  opened: number;
  /** merged ÷ (merged + closed), from 0 to 1, or null with no PR merged or closed. */
  mergeRate: number | null;
  /** Issues claimed, on someone else's project. */
  issues: number;
  /** Projects with a PR merged, from someone else's claims on them. */
  projects: number;
  /** People with a PR merged, from their claims on someone else's project. */
  people: number;
  /** The tokens the harnesses estimated for the claims, or null when none gave an estimate. */
  tokens: number | null;
  /** PRs merged from claims on the claimant's own project, which don't count toward the rank. */
  ownMerged: number;
}

/**
 * The merge rate: merged ÷ (merged + closed), or null when no PR has merged
 * or closed, so a person with only open PRs shows no rate.
 */
export function mergeRate(merged: number, closed: number): number | null {
  const ended = merged + closed;
  return ended === 0 ? null : merged / ended;
}

interface TallyRow {
  k: string | number;
  name: string | null;
  agent: string | null;
  merged: number;
  closed: number;
  opened: number;
  own_merged: number;
  projects: number;
  people: number;
  issues: number | null;
  tokens: number | null;
  total: number;
}

// What each group's rows are keyed by, over a claim `c`, and how a row is
// named and filtered once its counts are in. A project's row shows only
// while the project has a page, and a person's names their login now.
const GROUPS: Record<TallyGroup, { key: string; join: string; name: string }> = {
  person: { key: 'c.github_id', join: 'JOIN people pe ON pe.github_id = keys.k', name: 'pe.login' },
  agent: { key: 'c.agent', join: '', name: 'NULL' },
  project: {
    key: 'lower(c.project)',
    join: `JOIN projects p ON p.repo = keys.k AND ${HAS_PAGE}`,
    name: 'p.repo',
  },
};

/**
 * The counts for each person, agent, or project the scope covers, most PRs
 * merged first, at most `limit` rows, and how many rows there are in all.
 * A row is there when the scope holds a PR of its, opened, merged, or
 * closed in the range, own-project ones included, or a claim of its made in
 * the range on someone else's project. Blocked donors are left
 * out, and so is anything the do-not-list names, as SHOWN says. A project
 * shows only while it has a page. `onlyMerged` keeps the rows with a PR
 * merged. Ties go to whoever reached the count first, by the time of their
 * latest merge, then by name.
 */
export async function tally(
  db: D1Database,
  group: TallyGroup,
  scope: TallyScope,
  { limit, onlyMerged = false }: { limit: number; onlyMerged?: boolean },
): Promise<{ total: number; rows: Tally[] }> {
  const { range, project, person } = scope;
  // ?1 and ?2 are the range, ?3 the project, ?4 the person, and ?5 the limit.
  const binds = [
    range ? checkTime(range.from, 'from') : null,
    range ? checkTime(range.until, 'until') : null,
    project === undefined ? null : mustParse(repoName, project, 'project'),
    person === undefined ? null : mustParse(githubId, person, 'person'),
    mustParse(count, limit, 'limit'),
  ];
  const within = (column: string) => (range ? `(${column} >= ?1 AND ${column} < ?2)` : `(${column} IS NOT NULL)`);
  const claims = [
    ...(project === undefined ? [] : ['c.project = ?3']),
    ...(person === undefined ? [] : ['c.github_id = ?4']),
  ];
  // PRs opened or ended in the range. prs_by_opened and prs_by_closed serve
  // a range, claims_by_project a project, and claims_by_person a person.
  const prs = [...claims, ...(range ? [`(${within('p.opened_at')} OR ${within('p.closed_at')})`] : [])];
  const made = [...claims, ...(range ? [within('c.claimed_at')] : [])];
  const { key, join, name } = GROUPS[group];
  const where = (parts: string[]) => (parts.length === 0 ? '' : `${parts.join(' AND ')} AND`);

  const { results } = await db
    .prepare(
      `WITH scoped AS (
         SELECT ${key} AS k, c.github_id, c.agent, lower(c.project) AS project, c.own_project,
           p.opened_at, p.closed_at,
           (p.state = 'merged' AND ${within('p.closed_at')}) AS merged_in,
           (p.state = 'closed' AND ${within('p.closed_at')}) AS closed_in,
           ${within('p.opened_at')} AS opened_in
         FROM prs p JOIN claims c ON c.id = p.claim_id
         WHERE ${where(prs)} ${SHOWN}
       ),
       ranked AS (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY k ORDER BY (merged_in AND own_project = 0) DESC, COALESCE(closed_at, opened_at) DESC
         ) AS nth
         FROM scoped
       ),
       counts AS (
         SELECT k,
           SUM(own_project = 0 AND merged_in) AS merged,
           SUM(own_project = 0 AND closed_in) AS closed,
           SUM(own_project = 0 AND opened_in) AS opened,
           SUM(own_project = 1 AND merged_in) AS own_merged,
           COUNT(DISTINCT CASE WHEN own_project = 0 AND merged_in THEN project END) AS projects,
           COUNT(DISTINCT CASE WHEN own_project = 0 AND merged_in THEN github_id END) AS people,
           MAX(CASE WHEN own_project = 0 AND merged_in THEN closed_at END) AS last_merged,
           MAX(CASE WHEN nth = 1 THEN agent END) AS agent
         FROM ranked GROUP BY k
       ),
       worked AS (
         SELECT ${key} AS k, COUNT(DISTINCT lower(c.issue_repo) || '#' || c.issue_number) AS issues,
           SUM(c.token_estimate) AS tokens, MAX(c.claimed_at) AS last_claimed, c.agent AS agent
         FROM claims c
         WHERE ${where(made)} c.own_project = 0 AND ${CLAIM_SHOWN}
         GROUP BY k
       ),
       keys AS (SELECT k FROM counts UNION SELECT k FROM worked)
       SELECT keys.k, ${name} AS name, COALESCE(counts.agent, worked.agent) AS agent,
         COALESCE(counts.merged, 0) AS merged, COALESCE(counts.closed, 0) AS closed,
         COALESCE(counts.opened, 0) AS opened, COALESCE(counts.own_merged, 0) AS own_merged,
         COALESCE(counts.projects, 0) AS projects, COALESCE(counts.people, 0) AS people,
         worked.issues, worked.tokens, COUNT(*) OVER () AS total
       FROM keys ${join}
       LEFT JOIN counts ON counts.k = keys.k
       LEFT JOIN worked ON worked.k = keys.k
       ${onlyMerged ? 'WHERE counts.merged > 0' : ''}
       ORDER BY merged DESC, counts.last_merged, name, keys.k
       LIMIT ?5`,
    )
    .bind(...binds)
    .all<TallyRow>();

  return {
    total: mustParse(count, results[0]?.total ?? 0, 'total'),
    rows: results.map((row) => {
      const merged = mustParse(count, row.merged, 'merged');
      const closed = mustParse(count, row.closed, 'closed');
      return {
        key: group === 'project' ? mustParse(repoName, row.name, 'project') : String(row.k),
        login: group === 'person' ? mustParse(githubLogin, row.name, 'login') : null,
        agent: group === 'agent' || row.agent === null ? null : mustParse(agentName, row.agent, 'agent'),
        merged,
        closed,
        opened: mustParse(count, row.opened, 'opened'),
        mergeRate: mergeRate(merged, closed),
        issues: mustParse(count, row.issues ?? 0, 'issues'),
        projects: mustParse(count, row.projects, 'projects'),
        people: mustParse(count, row.people, 'people'),
        tokens: row.tokens === null ? null : mustParse(count, row.tokens, 'tokens'),
        ownMerged: mustParse(count, row.own_merged, 'ownMerged'),
      };
    }),
  };
}

/** One UTC day of a person's work. */
export interface ActiveDay {
  /** The UTC day, like 2026-09-27. */
  day: string;
  /** Claims made, and PRs merged or closed, that day. */
  events: number;
  /** Whether a PR of theirs merged that day. */
  merged: boolean;
}

/**
 * A person's work on each UTC day from `from` up to `until` that had any,
 * oldest first: the claims they made, and their PRs that merged or closed,
 * own-project work included. What the site hides stays hidden, as SHOWN
 * says. At most one row a day, so the range bounds the rows.
 */
export async function dailyActivity(
  db: D1Database,
  person: number,
  { from, until }: { from: number; until: number },
): Promise<ActiveDay[]> {
  // The person's claims through claims_by_person, and each one's PR by key.
  const { results } = await db
    .prepare(
      `SELECT day, SUM(events) AS events, MAX(merged) AS merged FROM (
         SELECT c.claimed_at / ${String(DAY)} AS day, 1 AS events, 0 AS merged FROM claims c
         WHERE c.github_id = ?1 AND c.claimed_at >= ?2 AND c.claimed_at < ?3 AND ${CLAIM_SHOWN}
         UNION ALL
         SELECT p.closed_at / ${String(DAY)}, 1, p.state = 'merged' FROM claims c JOIN prs p ON p.claim_id = c.id
         WHERE c.github_id = ?1 AND p.closed_at >= ?2 AND p.closed_at < ?3 AND ${SHOWN}
       ) GROUP BY day ORDER BY day`,
    )
    .bind(mustParse(githubId, person, 'person'), checkTime(from, 'from'), checkTime(until, 'until'))
    .all<{ day: number; events: number; merged: number }>();
  return results.map((row) => ({
    day: new Date(row.day * DAY).toISOString().slice(0, 10),
    events: mustParse(count, row.events, 'events'),
    merged: row.merged === 1,
  }));
}
