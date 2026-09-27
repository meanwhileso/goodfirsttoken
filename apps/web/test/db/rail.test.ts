import { newClaim, type ClaimRecord, type ProjectSettingsInput, type TaggedIssue } from '@goodfirsttoken/core';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  addPr,
  addToDoNotList,
  blockDonor,
  createProject,
  listProjectsAskingForHelp,
  saveClaim,
  saveIssues,
  savePerson,
  setPrState,
  setProjectStatus,
  startOfWeek,
  topMergers,
} from '../../src/db';
import { admin, DAY, db, emptyDatabase, HOUR, kenji, maintainer, priya, registeredProject, repo, sha, signIn, t0 } from './helpers';

// What the homepage's rail reads from D1: merged this week, and the projects
// asking for help. Every person, repo, and label here is made up.

const sam = { githubId: 1003, login: 'sam' };

beforeEach(async () => {
  await emptyDatabase();
  await signIn(priya, kenji, sam, maintainer, admin);
});

describe('the week', () => {
  // t0 is Saturday 26 September 2026, at noon UTC.
  const monday = Date.UTC(2026, 8, 21);

  test('starts on Monday at 00:00 UTC', () => {
    expect(startOfWeek(t0)).toBe(monday);
    expect(startOfWeek(monday)).toBe(monday);
    expect(startOfWeek(monday - 1)).toBe(monday - 7 * DAY);
    // Sunday, a minute before the next week.
    expect(startOfWeek(monday + 7 * DAY - 60_000)).toBe(monday);
    expect(startOfWeek(monday + 7 * DAY)).toBe(monday + 7 * DAY);
  });
});

describe('merged this week', () => {
  const week = { from: startOfWeek(t0), until: startOfWeek(t0) + 7 * DAY, limit: 5 };
  let made = 0;

  /**
   * A claim of `person`'s whose PR opened on `project` and then, unless
   * `state` says otherwise, merged at `at`.
   */
  async function pr(
    person: { githubId: number; login: string },
    at: number,
    {
      agent = 'claude-code',
      project = repo,
      ownProject = false,
      state = 'merged',
      issueRepo = project,
    }: {
      agent?: string;
      project?: string;
      ownProject?: boolean;
      state?: 'open' | 'merged' | 'closed';
      issueRepo?: string;
    } = {},
  ): Promise<void> {
    made += 1;
    const number = 500 + made;
    const ref = { repo: project, number, url: `https://github.com/${project}/pull/${String(number)}` };
    const opened = at - 2 * HOUR;
    const claim: ClaimRecord = {
      id: `c_rail${String(made)}`,
      issue: `${issueRepo}#${String(number - 100)}`,
      project,
      githubId: person.githubId,
      login: person.login,
      agent,
      ownProject,
      startCommit: sha,
      tokenEstimate: null,
      ...newClaim(opened - HOUR),
      state: 'pr_opened',
      submittedAt: opened,
      pr: ref,
    };
    await saveClaim(db, claim, 1);
    await addPr(db, { claimId: claim.id, pr: ref, openedAt: opened });
    if (state !== 'open') await setPrState(db, claim.id, state, at);
  }

  test('ranks people by the PRs they got merged this week, most first', async () => {
    await pr(priya, t0 - DAY);
    await pr(kenji, t0 - 2 * DAY);
    await pr(kenji, t0 - HOUR);
    await pr(sam, t0 - 3 * HOUR);

    const ranks = await topMergers(db, week);

    expect(ranks.map(({ login, merged }) => [login, merged])).toEqual([
      ['kenji', 2],
      ['priya', 1],
      ['sam', 1],
    ]);
  });

  test('a PR merged before Monday, still open, or closed without merging does not count', async () => {
    await pr(priya, week.from - 1);
    await pr(kenji, t0 - HOUR, { state: 'open' });
    await pr(sam, t0 - HOUR, { state: 'closed' });
    await pr(sam, week.from);

    expect(await topMergers(db, week)).toEqual([{ githubId: sam.githubId, login: 'sam', agent: 'claude-code', merged: 1 }]);
  });

  test("work on the donor's own project does not count", async () => {
    await pr(priya, t0 - HOUR, { ownProject: true });
    await pr(kenji, t0 - HOUR);

    expect((await topMergers(db, week)).map((rank) => rank.login)).toEqual(['kenji']);
  });

  test('a blocked donor is left out', async () => {
    await pr(priya, t0 - HOUR);
    await pr(kenji, t0 - HOUR);

    await blockDonor(db, { githubId: priya.githubId, reason: null, blockedBy: admin.githubId }, t0);

    expect((await topMergers(db, week)).map((rank) => rank.login)).toEqual(['kenji']);
  });

  test('a PR in a repo on the do-not-list does not count', async () => {
    await pr(priya, t0 - HOUR, { project: 'sample-owner/removed-app' });
    await pr(priya, t0 - HOUR);
    await pr(kenji, t0 - HOUR, { project: 'sample-owner/removed-app' });

    await addToDoNotList(db, { repo: 'Sample-Owner/Removed-App', reason: null, addedBy: admin.githubId }, t0);

    expect(await topMergers(db, week)).toEqual([
      { githubId: priya.githubId, login: 'priya', agent: 'claude-code', merged: 1 },
    ]);
  });

  test('a PR on a project whose issues live in a repo on the do-not-list does not count', async () => {
    await pr(priya, t0 - HOUR, { project: 'sample-owner/split-app', issueRepo: 'sample-owner/split-issues' });
    await pr(kenji, t0 - HOUR);

    await addToDoNotList(db, { repo: 'sample-owner/split-issues', reason: null, addedBy: admin.githubId }, t0);

    expect((await topMergers(db, week)).map((rank) => rank.login)).toEqual(['kenji']);
  });

  test('a tie goes to whoever reached the count first', async () => {
    await pr(sam, t0 - 3 * HOUR);
    await pr(priya, t0 - 5 * HOUR);
    await pr(kenji, t0 - 4 * HOUR);

    expect((await topMergers(db, week)).map((rank) => rank.login)).toEqual(['priya', 'kenji', 'sam']);
  });

  test("shows the person's login now, and the agent of their latest merged PR", async () => {
    await pr(priya, t0 - 3 * HOUR, { agent: 'codex' });
    await pr(priya, t0 - HOUR, { agent: 'cursor' });
    await pr(priya, t0 - 2 * HOUR, { agent: 'opencode' });

    await savePerson(db, { githubId: priya.githubId, login: 'priya-renamed' }, t0 + 1);

    expect(await topMergers(db, week)).toEqual([
      { githubId: priya.githubId, login: 'priya-renamed', agent: 'cursor', merged: 3 },
    ]);
  });

  test('shows at most as many people as asked', async () => {
    await pr(priya, t0 - HOUR);
    await pr(kenji, t0 - HOUR);
    await pr(sam, t0 - HOUR);

    expect(await topMergers(db, { ...week, limit: 2 })).toHaveLength(2);
  });
});

describe('projects asking for help', () => {
  let synced = 0;

  function issues(project: string, labels: string[][], linked: number[] = []): TaggedIssue[] {
    return labels.map((issueLabels, i) => {
      synced += 1;
      return {
        issue: `${project}#${String(i + 1)}`,
        project,
        title: `Sample issue ${String(i + 1)}`,
        labels: issueLabels,
        linkedPr: linked.includes(i + 1)
          ? { repo: project, number: 90 + i, url: `https://github.com/${project}/pull/${String(90 + i)}` }
          : null,
        syncedAt: t0 + synced,
      };
    });
  }

  async function project(name: string, addedAt: number, settings: ProjectSettingsInput = { tags: ['help wanted'] }) {
    const made = await createProject(
      db,
      { repo: name, status: 'approved', source: 'registered', policy: null, settings, addedBy: maintainer.githubId },
      addedAt,
    );
    if (!made) throw new Error(`${name} is already a project`);
    return made;
  }

  test('are the approved projects, leaving out pending, rejected, and paused ones, and any on the do-not-list', async () => {
    await registeredProject();
    await project('sample-owner/paused-app', t0);
    await setProjectStatus(db, 'sample-owner/paused-app', { status: 'paused', reason: null, changedBy: null }, t0 + 1);
    await createProject(
      db,
      {
        repo: 'sample-owner/pending-app',
        status: 'pending',
        source: 'registered',
        policy: null,
        settings: { tags: ['help wanted'] },
        addedBy: maintainer.githubId,
      },
      t0,
    );
    await project('sample-owner/removed-app', t0);
    await project('sample-owner/elsewhere-app', t0, { tags: ['help wanted'], issueRepo: 'sample-owner/removed-issues' });
    await addToDoNotList(db, { repo: 'sample-owner/removed-app', reason: null, addedBy: admin.githubId }, t0);
    await addToDoNotList(db, { repo: 'sample-owner/removed-issues', reason: null, addedBy: admin.githubId }, t0);

    const help = await listProjectsAskingForHelp(db, 5, t0);

    expect(help.total).toBe(1);
    expect(help.projects.map(({ project: p }) => p.repo)).toEqual([repo]);
  });

  test('count the tagged issues waiting for an agent: a tag, whatever its case, no excluded tag, and no linked PR', async () => {
    await registeredProject({ tags: ['help wanted', 'goodfirsttoken'], excludedTags: ['good first issue'] });
    await saveIssues(
      db,
      issues(
        repo,
        [
          ['Help Wanted'],
          ['goodfirsttoken', 'bug'],
          ['help wanted', 'good first issue'],
          ['help wanted'],
          ['bug'],
        ],
        [4],
      ),
    );

    const help = await listProjectsAskingForHelp(db, 5, t0);

    expect(help.projects.map(({ project: p, waiting }) => [p.repo, waiting])).toEqual([[repo, 2]]);
  });

  test('count an issue as waiting only while a new agent could claim it: one slot free, but not every slot taken', async () => {
    await registeredProject({ tags: ['help wanted'], claimsPerIssue: 3 });
    await signIn(maintainer, { githubId: 1004, login: 'ines' });
    await saveIssues(db, issues(repo, [['help wanted'], ['help wanted'], ['help wanted'], ['help wanted']]));
    let claims = 0;
    const claimOn = async (number: number, person: { githubId: number; login: string }, changes: Partial<ClaimRecord> = {}) => {
      claims += 1;
      await saveClaim(
        db,
        {
          id: `c_slot${String(claims)}`,
          issue: `${repo}#${String(number)}`,
          project: repo,
          githubId: person.githubId,
          login: person.login,
          agent: 'claude-code',
          ownProject: false,
          startCommit: sha,
          tokenEstimate: null,
          ...newClaim(t0 - HOUR),
          ...changes,
        },
        1,
      );
    };
    // #1: every slot taken, by claims working, paused, and awaiting review.
    await claimOn(1, priya);
    await claimOn(1, kenji, { state: 'paused' });
    await claimOn(1, sam, { state: 'awaiting_review', submittedAt: t0 - HOUR });
    // #2: two held and one released, so a slot is free.
    await claimOn(2, priya);
    await claimOn(2, kenji);
    await claimOn(2, sam, { state: 'released', releaseReason: 'the tests would not run' });
    // #3: three stored as working, but one is past its 24 hours, so it holds no slot.
    await claimOn(3, priya);
    await claimOn(3, kenji);
    await claimOn(3, sam, { ...newClaim(t0 - DAY) });
    // #4: nobody on it.

    const help = await listProjectsAskingForHelp(db, 5, t0);

    expect(help.projects.map(({ project: p, waiting }) => [p.repo, waiting])).toEqual([[repo, 3]]);
  });

  test('come in order of issues waiting, then the newest added, and the total counts past the limit', async () => {
    await project('sample-owner/older-quiet', t0);
    await project('sample-owner/newer-quiet', t0 + DAY);
    await project('sample-owner/one-waiting', t0);
    await project('sample-owner/two-waiting', t0);
    await saveIssues(db, [
      ...issues('sample-owner/one-waiting', [['help wanted']]),
      ...issues('sample-owner/two-waiting', [['help wanted'], ['help wanted']]),
    ]);

    const help = await listProjectsAskingForHelp(db, 3, t0);

    expect(help.total).toBe(4);
    expect(help.projects.map(({ project: p, waiting }) => [p.repo, waiting])).toEqual([
      ['sample-owner/two-waiting', 2],
      ['sample-owner/one-waiting', 1],
      ['sample-owner/newer-quiet', 0],
    ]);
  });

  test('none yet is an empty list', async () => {
    expect(await listProjectsAskingForHelp(db, 5, t0)).toEqual({ total: 0, projects: [] });
  });
});
