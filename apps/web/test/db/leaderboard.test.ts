import { newClaim, nextClaimState, type ClaimRecord } from '@goodfirsttoken/core';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  addPr,
  addToDoNotList,
  blockDonor,
  createProject,
  dailyActivity,
  mergeRate,
  saveClaim,
  setDelisted,
  setPrState,
  setProjectStatus,
  startOfWeek,
  tally,
  type Tally,
  type TallyScope,
} from '../../src/db';
import { admin, DAY, db, emptyDatabase, HOUR, kenji, maintainer, MINUTE, priya, repo, sha, signIn, t0 } from './helpers';

// The leaderboard's counts, which every ranking on the site reads through
// tally: the leaderboard's views, merged this week, top helpers, and a
// person's totals. Every person, repo, and number here is made up.

const sam = { githubId: 1003, login: 'sam' };
const other = 'sample-owner/sample-desktop';
type Person = typeof priya;

// t0 is Saturday 26 September 2026, at noon UTC. Its week started Monday 21.
const monday = Date.UTC(2026, 8, 21);
const thisWeek: TallyScope = { range: { from: monday, until: monday + 7 * DAY } };
const lastWeek: TallyScope = { range: { from: monday - 7 * DAY, until: monday } };

beforeEach(async () => {
  await emptyDatabase();
  await signIn(priya, kenji, sam, maintainer, admin);
  for (const name of [repo, other]) {
    await createProject(
      db,
      { repo: name, status: 'approved', source: 'registered', policy: null, settings: { tags: ['help wanted'] }, addedBy: maintainer.githubId },
      t0 - 60 * DAY,
    );
  }
});

let made = 0;

/**
 * A claim of `person`'s made at `claimedAt`, with a PR that opened at
 * `opened` unless `pr` is false, and then merged or closed at `ended`
 * when `state` says so.
 */
async function work(
  person: Person,
  {
    project = repo,
    agent = 'claude-code',
    ownProject = false,
    claimedAt = t0 - 3 * HOUR,
    opened = claimedAt + HOUR,
    ended = opened + HOUR,
    state = 'merged',
    tokens = null,
    issue,
    pr = true,
  }: {
    project?: string;
    agent?: string;
    ownProject?: boolean;
    claimedAt?: number;
    opened?: number;
    ended?: number;
    state?: 'open' | 'merged' | 'closed';
    tokens?: number | null;
    issue?: number;
    pr?: boolean;
  } = {},
): Promise<ClaimRecord> {
  made += 1;
  const number = 100 + made;
  let claim: ClaimRecord = {
    id: `c_board${String(made).padStart(6, '0')}`,
    issue: `${project}#${String(issue ?? number)}`,
    project,
    githubId: person.githubId,
    login: person.login,
    agent,
    ownProject,
    startCommit: sha,
    tokenEstimate: tokens,
    ...newClaim(claimedAt),
  };
  if (!pr) {
    await saveClaim(db, claim, 1);
    return claim;
  }
  const ref = { repo: project, number: 900 + made, url: `https://github.com/${project}/pull/${String(900 + made)}` };
  for (const [event, at] of [
    [{ kind: 'submit' }, opened - MINUTE],
    [{ kind: 'open_pr', pr: ref }, opened],
  ] as const) {
    const next = nextClaimState(claim, event, at);
    if (!next.ok) throw new Error(next.refusal.message);
    claim = next.claim;
  }
  await saveClaim(db, claim, 1);
  await addPr(db, { claimId: claim.id, pr: ref, openedAt: opened });
  if (state !== 'open') await setPrState(db, claim.id, state, ended);
  return claim;
}

async function people(scope: TallyScope = {}, limit = 50): Promise<Tally[]> {
  return (await tally(db, 'person', scope, { limit })).rows;
}

async function row(login: string, scope: TallyScope = {}): Promise<Tally | undefined> {
  return (await people(scope)).find((r) => r.login === login);
}

describe('the merge rate', () => {
  test('is merged ÷ (merged + closed), leaving out PRs still open', async () => {
    await work(priya, { state: 'merged' });
    await work(priya, { state: 'merged' });
    await work(priya, { state: 'closed' });
    await work(priya, { state: 'open' });

    const priyaRow = await row('priya');

    expect(priyaRow).toMatchObject({ merged: 2, closed: 1, opened: 4 });
    expect(priyaRow?.mergeRate).toBeCloseTo(2 / 3);
  });

  test('is none for someone whose PRs are all still open, and 0 for someone whose PRs all closed', async () => {
    await work(priya, { state: 'open' });
    await work(kenji, { state: 'closed' });

    expect((await row('priya'))?.mergeRate).toBeNull();
    expect((await row('kenji'))?.mergeRate).toBe(0);
    expect(mergeRate(0, 0)).toBeNull();
    expect(mergeRate(3, 1)).toBe(0.75);
  });
});

describe('the week', () => {
  test('starts Monday at 00:00 UTC: a merge 1 ms before counts last week, and one at 00:00 counts this week', async () => {
    await work(priya, { claimedAt: monday - 4 * HOUR, ended: monday - 1 });
    await work(kenji, { claimedAt: monday - 4 * HOUR, ended: monday });

    // priya claimed, opened, and merged last week, so she has nothing this week.
    expect((await people(thisWeek)).map((r) => [r.login, r.merged])).toEqual([['kenji', 1]]);
    expect((await people(lastWeek)).map((r) => [r.login, r.merged])).toEqual([
      ['priya', 1],
      ['kenji', 0],
    ]);
    expect(startOfWeek(t0)).toBe(monday);
  });

  test('puts each fact of a PR in the week its own time falls in: opened by when it opened, merged or closed by when it ended', async () => {
    // Opened on Sunday, merged on Monday.
    await work(priya, { claimedAt: monday - 3 * HOUR, opened: monday - HOUR, ended: monday + HOUR });
    // Opened on Sunday, closed on Monday.
    await work(priya, { claimedAt: monday - 3 * HOUR, opened: monday - HOUR, ended: monday + 2 * HOUR, state: 'closed' });

    expect(await row('priya', lastWeek)).toMatchObject({ opened: 2, merged: 0, closed: 0, mergeRate: null, issues: 2 });
    expect(await row('priya', thisWeek)).toMatchObject({ opened: 0, merged: 1, closed: 1, mergeRate: 0.5, issues: 0 });
  });
});

describe('own-project work', () => {
  test('has its own column, and counts toward nothing else, the rank included', async () => {
    await work(priya, { ownProject: true, tokens: 5000 });
    await work(priya, { ownProject: true });
    await work(priya, { ownProject: true, state: 'closed' });
    await work(kenji);

    expect((await people()).map((r) => [r.login, r.merged, r.ownMerged])).toEqual([
      ['kenji', 1, 0],
      ['priya', 0, 2],
    ]);
    expect(await row('priya')).toMatchObject({ opened: 0, closed: 0, mergeRate: null, issues: 0, projects: 0, tokens: null });
    // The homepage's merged this week leaves them out entirely.
    expect((await tally(db, 'person', {}, { limit: 5, onlyMerged: true })).rows.map((r) => r.login)).toEqual(['kenji']);
  });

  test("a project's row counts its maintainers' merges in its own column", async () => {
    await work(maintainer, { ownProject: true });
    await work(priya);

    const [project] = (await tally(db, 'project', {}, { limit: 5 })).rows;
    expect(project).toMatchObject({ key: repo, merged: 1, ownMerged: 1, people: 1 });
  });
});

describe('blocked donors', () => {
  test('are hidden from every view, and none of their work counts', async () => {
    await work(priya, { agent: 'codex', tokens: 1000 });
    await work(priya, { agent: 'codex', project: other });
    await work(kenji, { agent: 'cursor' });

    await blockDonor(db, { githubId: priya.githubId, reason: null, blockedBy: admin.githubId }, t0);

    expect((await people()).map((r) => r.login)).toEqual(['kenji']);
    expect((await tally(db, 'agent', {}, { limit: 50 })).rows.map((r) => r.key)).toEqual(['cursor']);
    expect((await tally(db, 'project', {}, { limit: 50 })).rows.map((r) => [r.key, r.merged])).toEqual([[repo, 1]]);
    expect(await dailyActivity(db, priya.githubId, { from: t0 - DAY, until: t0 + DAY })).toEqual([]);
  });
});

describe('the rows', () => {
  test('rank by PRs merged, and a tie goes to whoever reached the count first, then by login', async () => {
    await work(sam, { ended: t0 - HOUR });
    await work(kenji, { ended: t0 - 2 * HOUR });
    await work(priya, { ended: t0 - 2 * HOUR });
    await work(priya, { state: 'open' });
    await work(sam, { ended: t0 - 30 * MINUTE });
    await work(maintainer, { pr: false });

    expect((await people()).map((r) => [r.login, r.merged])).toEqual([
      ['sam', 2],
      ['kenji', 1],
      ['priya', 1],
      ['sample-maintainer', 0],
    ]);
  });

  test('count issues worked once each, projects helped by merges, and tokens only where an agent gave an estimate', async () => {
    await work(priya, { issue: 7, tokens: 1500 });
    await work(priya, { issue: 7, state: 'closed', tokens: 500 });
    await work(priya, { project: other, issue: 8 });
    await work(priya, { project: other, issue: 9, pr: false });
    await work(kenji);

    expect(await row('priya')).toMatchObject({ issues: 3, projects: 2, tokens: 2000 });
    expect(await row('kenji')).toMatchObject({ issues: 1, projects: 1, tokens: null });
  });

  test('name each person by their login now, with the agent of their latest merge', async () => {
    await work(priya, { agent: 'codex', ended: t0 - 3 * HOUR });
    await work(priya, { agent: 'cursor', ended: t0 - HOUR });
    await work(priya, { agent: 'opencode', state: 'closed', ended: t0 - 30 * MINUTE });
    await signIn({ githubId: priya.githubId, login: 'priya-renamed' });
    await db.prepare('UPDATE people SET seen_at = ? WHERE github_id = ?').bind(t0 + 1, priya.githubId).run();

    expect(await people()).toMatchObject([{ key: String(priya.githubId), login: 'priya-renamed', agent: 'cursor' }]);
  });

  test('leave out a PR the do-not-list names, and a claim on a repo it names', async () => {
    await work(priya, { project: 'sample-owner/removed-app' });
    await work(priya, { project: 'sample-owner/removed-app', pr: false });
    await work(priya);
    await addToDoNotList(db, { repo: 'sample-owner/removed-app', reason: null, addedBy: admin.githubId }, t0);

    expect(await row('priya')).toMatchObject({ merged: 1, opened: 1, issues: 1, projects: 1 });
  });

  test('stop at the limit, and say how many there are in all', async () => {
    await work(priya);
    await work(kenji);
    await work(sam);

    const board = await tally(db, 'person', {}, { limit: 2 });

    expect(board.total).toBe(3);
    expect(board.rows).toHaveLength(2);
  });
});

describe('the view by agent', () => {
  test("counts each agent's PRs by the agent its claim named, with its merge rate", async () => {
    await work(priya, { agent: 'claude-code' });
    await work(kenji, { agent: 'claude-code', state: 'closed' });
    await work(kenji, { agent: 'codex' });
    await work(sam, { agent: 'claude-code', ownProject: true });

    const agents = (await tally(db, 'agent', {}, { limit: 50 })).rows;

    expect(agents.map((r) => [r.key, r.merged, r.closed, r.mergeRate, r.people])).toEqual([
      ['claude-code', 1, 1, 0.5, 1],
      ['codex', 1, 0, 1, 1],
    ]);
  });
});

describe('the view by project', () => {
  test('shows only projects with a page, so a delisted one, or one pending, is left out, and a paused one stays', async () => {
    const pending = 'sample-owner/pending-app';
    const paused = 'sample-owner/paused-app';
    await createProject(
      db,
      { repo: pending, status: 'pending', source: 'registered', policy: null, settings: { tags: ['help wanted'] }, addedBy: maintainer.githubId },
      t0 - DAY,
    );
    await createProject(
      db,
      { repo: paused, status: 'approved', source: 'registered', policy: null, settings: { tags: ['help wanted'] }, addedBy: maintainer.githubId },
      t0 - DAY,
    );
    await setProjectStatus(db, paused, { status: 'paused', reason: null, changedBy: maintainer.githubId }, t0 - DAY);
    await setDelisted(db, other, 'sample-owner/sample-desktop is private on GitHub.', t0 - DAY);
    for (const project of [repo, other, pending, paused]) await work(priya, { project });

    expect((await tally(db, 'project', {}, { limit: 50 })).rows.map((r) => r.key)).toEqual([paused, repo]);
    // Their merges still count for the person, as PRs GitHub shows merged.
    expect(await row('priya')).toMatchObject({ merged: 4, projects: 4 });
  });

  test("names a project by its repo as it was saved, whatever the case of a claim's", async () => {
    await work(priya, { project: repo.toUpperCase() });
    await work(kenji);

    expect((await tally(db, 'project', {}, { limit: 50 })).rows).toMatchObject([{ key: repo, merged: 2, people: 2 }]);
  });
});

describe('a person’s activity', () => {
  test('counts the claims they made and the PRs that ended, by UTC day, and marks a day a PR merged', async () => {
    const sunday = monday - DAY;
    await work(priya, { claimedAt: sunday + HOUR, opened: sunday + 2 * HOUR, ended: monday + HOUR });
    await work(priya, { claimedAt: monday + 2 * HOUR, pr: false });
    await work(priya, { claimedAt: monday + 3 * HOUR, opened: monday + 4 * HOUR, ended: monday + 5 * HOUR, state: 'closed' });

    expect(await dailyActivity(db, priya.githubId, { from: sunday, until: monday + DAY })).toEqual([
      { day: '2026-09-20', events: 1, merged: false },
      { day: '2026-09-21', events: 4, merged: true },
    ]);
  });
});
