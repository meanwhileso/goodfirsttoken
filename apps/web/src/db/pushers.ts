import { githubLogin, mustParse, repoName } from '@goodfirsttoken/core';
import { checkTime } from './shared';

// The repo_pushers table: for each repo, the logins whose reviews on a PR
// there showed push access when the PR job read them, and when it last saw
// it. A comment in a PR's conversation shows no push access, so the PR job
// counts its author as a maintainer by this table. The rules are in
// docs/how-it-works.md, under PRs.

/** How long a review that showed push access counts for its author's conversation comments. */
export const PUSHER_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Records that a read at `seenAt` saw a review by each login show push
 * access to the repo, and drops what no read saw in the 90 days before,
 * in one batch. A later sighting moves a login's time on, and an earlier
 * one changes nothing.
 */
export async function savePushers(db: D1Database, seen: readonly { repo: string; login: string }[], seenAt: number): Promise<void> {
  const at = checkTime(seenAt, 'seenAt');
  const rows = seen.map(({ repo, login }) => [mustParse(repoName, repo, 'repo'), mustParse(githubLogin, login, 'login')]);
  const statements = [db.prepare('DELETE FROM repo_pushers WHERE seen_at < ?').bind(at - PUSHER_WINDOW_MS)];
  if (rows.length > 0) {
    statements.push(
      db
        .prepare(
          `INSERT INTO repo_pushers (repo, login, seen_at)
           SELECT json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), ?1 FROM json_each(?2) j WHERE true
           ON CONFLICT (repo, login) DO UPDATE SET seen_at = MAX(seen_at, excluded.seen_at)`,
        )
        .bind(at, JSON.stringify(rows)),
    );
  }
  await db.batch(statements);
}

/**
 * The logins a read saw show push access to each repo in the 90 days
 * before `now`, by repo, both in lower case.
 */
export async function listPushers(db: D1Database, repos: readonly string[], now: number): Promise<Map<string, Set<string>>> {
  const found = new Map<string, Set<string>>();
  if (repos.length === 0) return found;
  const names = repos.map((repo) => mustParse(repoName, repo, 'repo'));
  const { results } = await db
    .prepare(
      `SELECT repo, login FROM repo_pushers
       WHERE repo IN (SELECT value FROM json_each(?1)) AND seen_at >= ?2`,
    )
    .bind(JSON.stringify(names), checkTime(now) - PUSHER_WINDOW_MS)
    .all<{ repo: string; login: string }>();
  for (const { repo, login } of results) {
    const key = repo.toLowerCase();
    const logins = found.get(key) ?? new Set<string>();
    logins.add(login.toLowerCase());
    found.set(key, logins);
  }
  return found;
}
