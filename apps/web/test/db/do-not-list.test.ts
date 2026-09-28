import { beforeEach, describe, expect, test } from 'vitest';
import {
  addToDoNotList,
  createProject,
  doNotListedAmong,
  getDoNotListEntry,
  getProject,
  leaveDoNotListWhenApproved,
  setProjectStatus,
  setProjectStatusFrom,
} from '../../src/db';
import { admin, db, emptyDatabase, HOUR, maintainer, repo, signIn, t0 } from './helpers';

beforeEach(async () => {
  await emptyDatabase();
  await signIn(admin);
});

describe('the do-not-list', () => {
  test('a repo on the do-not-list is found whatever the case of its name', async () => {
    const entry = await addToDoNotList(
      db,
      { repo, reason: 'The maintainers asked in sample-owner/sample-app#90.', addedBy: admin.githubId },
      t0,
    );

    expect(entry).toEqual({
      repo,
      reason: 'The maintainers asked in sample-owner/sample-app#90.',
      addedBy: admin.githubId,
      addedAt: t0,
    });
    expect(await getDoNotListEntry(db, 'Sample-Owner/Sample-App')).toEqual(entry);
  });

  test('a repo not on the list is not found', async () => {
    expect(await getDoNotListEntry(db, repo)).toBeNull();
  });

  test('adding a repo again keeps its first entry', async () => {
    const first = await addToDoNotList(db, { repo, reason: null, addedBy: admin.githubId }, t0);

    const again = await addToDoNotList(
      db,
      { repo: 'SAMPLE-OWNER/sample-app', reason: 'Asked again.', addedBy: admin.githubId },
      t0 + HOUR,
    );

    expect(again).toEqual(first);
  });

  test("a repo comes off the list, whatever the case of its name, with an admin's approval of its registration, and not with a rejection", async () => {
    await signIn(maintainer);
    const registered = { repo, status: 'pending' as const, source: 'registered' as const, policy: null, addedBy: maintainer.githubId };
    const other = 'sample-owner/sample-tools';
    await createProject(db, { ...registered, settings: { tags: ['help wanted'] } }, t0);
    await createProject(db, { ...registered, repo: other, settings: { tags: ['help wanted'] } }, t0);
    await addToDoNotList(db, { repo: 'SAMPLE-OWNER/Sample-App', reason: null, addedBy: admin.githubId }, t0);
    await addToDoNotList(db, { repo: other, reason: null, addedBy: admin.githubId }, t0);
    const decide = async (name: string, status: 'approved' | 'rejected') => {
      const read = await getProject(db, name);
      if (read === null) throw new Error(`${name} is not a project`);
      const change = { status, reason: status === 'rejected' ? 'Not yet.' : null, changedBy: admin.githubId };
      await setProjectStatusFrom(db, read, change, t0 + HOUR, [leaveDoNotListWhenApproved(db, name, admin.githubId, t0 + HOUR)]);
    };

    await decide(repo, 'approved');
    await decide(other, 'rejected');

    expect(await getDoNotListEntry(db, repo)).toBeNull();
    expect(await getDoNotListEntry(db, other)).not.toBeNull();
  });

  test("covers a repo on it, and the issue repo of a project whose code repo is on it, and nothing else", async () => {
    await signIn(maintainer);
    await createProject(
      db,
      {
        repo: 'sample-owner/sample-code',
        status: 'approved',
        source: 'registered',
        policy: null,
        settings: { tags: ['help wanted'], issueRepo: 'sample-owner/sample-issues' },
        addedBy: maintainer.githubId,
      },
      t0,
    );
    await addToDoNotList(db, { repo: 'Sample-Owner/Sample-Code', reason: null, addedBy: admin.githubId }, t0);
    await addToDoNotList(db, { repo, reason: null, addedBy: admin.githubId }, t0);

    const covered = await doNotListedAmong(db, [
      'sample-owner/SAMPLE-APP',
      'sample-owner/sample-issues',
      'sample-owner/sample-code',
      'sample-owner/sample-tools',
    ]);

    expect(covered).toEqual(new Set(['sample-owner/sample-app', 'sample-owner/sample-issues', 'sample-owner/sample-code']));
    expect(await doNotListedAmong(db, [])).toEqual(new Set());
  });

  test('covers an issue repo two projects share only once both code repos are on it', async () => {
    await signIn(maintainer);
    const shared = { status: 'approved' as const, source: 'registered' as const, policy: null, addedBy: maintainer.githubId };
    const settings = { tags: ['help wanted'], issueRepo: 'sample-owner/sample-issues' };
    await createProject(db, { ...shared, repo: 'sample-owner/sample-code', settings }, t0);
    await createProject(db, { ...shared, repo: 'sample-owner/sample-other', settings }, t0);

    await addToDoNotList(db, { repo: 'sample-owner/sample-code', reason: null, addedBy: admin.githubId }, t0);
    const one = await doNotListedAmong(db, ['sample-owner/sample-issues', 'sample-owner/sample-code']);
    await addToDoNotList(db, { repo: 'Sample-Owner/Sample-Other', reason: null, addedBy: admin.githubId }, t0);
    const both = await doNotListedAmong(db, ['SAMPLE-OWNER/sample-issues']);

    expect(one).toEqual(new Set(['sample-owner/sample-code']));
    expect(both).toEqual(new Set(['sample-owner/sample-issues']));
  });

  test('only an approved or paused project keeps an issue repo it shares with a removed project shown, since only they have claims', async () => {
    await signIn(maintainer);
    const base = { source: 'registered' as const, policy: null, addedBy: maintainer.githubId };
    const sharing = async (code: string, issues: string, status: 'approved' | 'paused' | 'pending' | 'rejected') => {
      const settings = { tags: ['help wanted'], issueRepo: issues };
      await createProject(db, { ...base, repo: code, status: status === 'paused' ? 'approved' : status === 'rejected' ? 'pending' : status, settings }, t0);
      if (status === 'paused' || status === 'rejected') {
        await setProjectStatus(db, code, { status, reason: 'Checking.', changedBy: admin.githubId }, t0 + HOUR);
      }
    };
    for (const status of ['approved', 'paused', 'pending', 'rejected'] as const) {
      const issues = `sample-owner/issues-${status}`;
      await sharing(`sample-owner/removed-${status}`, issues, 'approved');
      await sharing(`sample-owner/other-${status}`, issues, status);
      await addToDoNotList(db, { repo: `sample-owner/removed-${status}`, reason: null, addedBy: admin.githubId }, t0);
    }
    // An issue repo only a pending project uses, with no project removed.
    await sharing('sample-owner/waiting', 'sample-owner/issues-waiting', 'pending');

    const covered = await doNotListedAmong(db, [
      'sample-owner/issues-approved',
      'sample-owner/issues-paused',
      'sample-owner/issues-pending',
      'sample-owner/issues-rejected',
      'sample-owner/issues-waiting',
    ]);

    expect(covered).toEqual(new Set(['sample-owner/issues-pending', 'sample-owner/issues-rejected']));
  });

  test("covers a repo on it, and with it every project that keeps its issues there, even one that isn't on it", async () => {
    await signIn(maintainer);
    const base = { status: 'approved' as const, source: 'registered' as const, policy: null, addedBy: maintainer.githubId };
    await createProject(db, { ...base, repo: 'sample-owner/sample-main', settings: { tags: ['help wanted'] } }, t0);
    await createProject(
      db,
      { ...base, repo: 'sample-owner/sample-plugin', settings: { tags: ['help wanted'], issueRepo: 'sample-owner/sample-main' } },
      t0,
    );

    await addToDoNotList(db, { repo: 'sample-owner/sample-main', reason: null, addedBy: admin.githubId }, t0);

    expect(await doNotListedAmong(db, ['sample-owner/sample-main'])).toEqual(new Set(['sample-owner/sample-main']));
  });
});
