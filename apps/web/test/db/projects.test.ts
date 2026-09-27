import { settingKeys } from '@goodfirsttoken/core';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  changeSettings,
  createProject,
  getProject,
  listProjects,
  listProjectsByIssueRepo,
  setProjectStatus,
  settingsHistory,
  statusHistory,
  takeOverListing,
} from '../../src/db';
import {
  admin,
  coMaintainer,
  db,
  emptyDatabase,
  HOUR,
  maintainer,
  priya,
  refusal,
  registeredProject,
  repo,
  signIn,
  t0,
} from './helpers';

const policy = {
  quote: 'Pull requests written with coding agents are welcome once a person has read the diff.',
  url: 'https://github.com/sample-owner/sample-app/blob/main/CONTRIBUTING.md',
  tier: 'allows_with_conditions' as const,
};

beforeEach(async () => {
  await emptyDatabase();
  await signIn(maintainer, coMaintainer, admin);
});

describe('projects', () => {
  test('a registered project is saved with its settings, and settings it left out take their defaults', async () => {
    const created = await createProject(
      db,
      {
        repo,
        status: 'pending',
        source: 'registered',
        policy: null,
        settings: { tags: ['help wanted'], prMode: 'automatic' },
        addedBy: maintainer.githubId,
      },
      t0,
    );

    const stored = await getProject(db, repo);
    expect(stored).toEqual(created);
    expect(stored).toMatchObject({
      repo,
      status: 'pending',
      statusReason: null,
      source: 'registered',
      policy: null,
      addedBy: maintainer.githubId,
      addedAt: t0,
      statusChangedBy: maintainer.githubId,
      statusChangedAt: t0,
      settingsVersion: 1,
    });
    expect(stored?.settings).toMatchObject({ tags: ['help wanted'], prMode: 'automatic', claimsPerIssue: 3 });
  });

  test('a project listed from its policy keeps the quote, the link, and the tier', async () => {
    await createProject(
      db,
      { repo, status: 'approved', source: 'policy', policy, settings: { tags: ['ready'] }, addedBy: admin.githubId },
      t0,
    );

    expect((await getProject(db, repo))?.policy).toEqual(policy);
  });

  test('a project listed from its policy without the policy is refused, naming the field', async () => {
    const message = await refusal(
      createProject(
        db,
        { repo, status: 'approved', source: 'policy', policy: null, settings: { tags: ['ready'] }, addedBy: admin.githubId },
        t0,
      ),
    );

    expect(message).toContain('policy: is required for a project listed from its policy');
    expect(await getProject(db, repo)).toBeNull();
  });

  test('a repo can be a project only once, whatever the case of its name', async () => {
    await registeredProject();

    const again = await createProject(
      db,
      {
        repo: 'Sample-Owner/Sample-App',
        status: 'approved',
        source: 'policy',
        policy,
        settings: { tags: ['ready'] },
        addedBy: admin.githubId,
      },
      t0 + HOUR,
    );

    expect(again).toBeNull();
    const stored = await getProject(db, 'SAMPLE-OWNER/sample-app');
    expect(stored).toMatchObject({ repo, source: 'registered', settings: { tags: ['help wanted'] } });
  });

  test('a project that does not exist is not found', async () => {
    expect(await getProject(db, repo)).toBeNull();
  });

  test('the admin queue lists pending projects oldest first, apart from approved ones', async () => {
    const add = (name: string, status: 'pending' | 'approved', at: number) =>
      createProject(
        db,
        { repo: name, status, source: 'registered', policy: null, settings: { tags: ['help wanted'] }, addedBy: maintainer.githubId },
        at,
      );
    await add('sample-owner/newer', 'pending', t0 + HOUR);
    await add('sample-owner/older', 'pending', t0);
    await add('sample-owner/listed', 'approved', t0);

    expect((await listProjects(db, 'pending')).map((p) => p.repo)).toEqual(['sample-owner/older', 'sample-owner/newer']);
    expect((await listProjects(db, 'approved')).map((p) => p.repo)).toEqual(['sample-owner/listed']);
  });

  test('a project is found by the repo its issues live in, and follows a change of issue repo', async () => {
    await registeredProject({ tags: ['help wanted'], issueRepo: 'sample-owner/sample-issues' });

    expect((await listProjectsByIssueRepo(db, 'sample-owner/sample-issues')).map((p) => p.repo)).toEqual([repo]);
    expect(await listProjectsByIssueRepo(db, repo)).toEqual([]);

    await changeSettings(db, repo, { issueRepo: null }, maintainer.githubId, t0 + HOUR);

    expect(await listProjectsByIssueRepo(db, 'sample-owner/sample-issues')).toEqual([]);
    expect((await listProjectsByIssueRepo(db, repo)).map((p) => p.repo)).toEqual([repo]);
  });

  test('a rejection keeps its reason for the maintainer', async () => {
    await registeredProject();

    await setProjectStatus(
      db,
      repo,
      { status: 'rejected', reason: 'The notes ask agents to skip tests.', changedBy: admin.githubId },
      t0 + HOUR,
    );

    expect(await getProject(db, repo)).toMatchObject({
      status: 'rejected',
      statusReason: 'The notes ask agents to skip tests.',
    });
  });

  test('a rejection without a reason is refused and changes nothing', async () => {
    await registeredProject();

    const message = await refusal(
      setProjectStatus(db, repo, { status: 'rejected', reason: null, changedBy: admin.githubId }, t0 + HOUR),
    );

    expect(message).toContain('reason: is required for a rejected project');
    expect((await getProject(db, repo))?.status).toBe('approved');
    expect(await statusHistory(db, repo)).toHaveLength(1);
  });

  test('resuming a paused project clears the pause reason', async () => {
    await registeredProject();
    await setProjectStatus(
      db,
      repo,
      { status: 'paused', reason: 'Too many PRs this week.', changedBy: maintainer.githubId },
      t0 + HOUR,
    );

    const resumed = await setProjectStatus(
      db,
      repo,
      { status: 'approved', reason: null, changedBy: maintainer.githubId },
      t0 + 2 * HOUR,
    );

    expect(resumed).toMatchObject({ status: 'approved', statusReason: null });
    expect(await getProject(db, repo)).toEqual(resumed);
    expect(
      await setProjectStatus(db, 'sample-owner/missing', { status: 'paused', reason: null, changedBy: null }, t0),
    ).toBeNull();
  });

  test('status changes show who made them and when', async () => {
    await registeredProject();

    await setProjectStatus(
      db,
      repo,
      { status: 'paused', reason: 'Too many PRs this week.', changedBy: coMaintainer.githubId },
      t0 + HOUR,
    );
    await setProjectStatus(db, repo, { status: 'approved', reason: null, changedBy: admin.githubId }, t0 + 2 * HOUR);

    expect(await getProject(db, repo)).toMatchObject({
      status: 'approved',
      statusChangedBy: admin.githubId,
      statusChangedAt: t0 + 2 * HOUR,
    });
    expect(await statusHistory(db, repo)).toEqual([
      { repo, status: 'approved', reason: null, changedBy: admin.githubId, changedAt: t0 + 2 * HOUR },
      { repo, status: 'paused', reason: 'Too many PRs this week.', changedBy: coMaintainer.githubId, changedAt: t0 + HOUR },
      { repo, status: 'approved', reason: null, changedBy: maintainer.githubId, changedAt: t0 },
    ]);
  });

  test('a pause Good First Token makes on its own names no person', async () => {
    await registeredProject();

    const paused = await setProjectStatus(
      db,
      repo,
      { status: 'paused', reason: 'The repo was archived.', changedBy: null },
      t0 + HOUR,
    );

    expect(paused).toMatchObject({ status: 'paused', statusChangedBy: null, statusChangedAt: t0 + HOUR });
    expect((await statusHistory(db, repo))[0]).toMatchObject({ changedBy: null, reason: 'The repo was archived.' });
  });

  test.each([
    ['an approval', 'approved' as const, null],
    ['a rejection', 'rejected' as const, 'The notes ask agents to skip tests.'],
  ])('%s always names the admin who made it', async (_, status, reason) => {
    await createProject(
      db,
      { repo, status: 'pending', source: 'registered', policy: null, settings: { tags: ['help wanted'] }, addedBy: maintainer.githubId },
      t0,
    );

    const message = await refusal(setProjectStatus(db, repo, { status, reason, changedBy: null }, t0 + HOUR));

    expect(message).toContain('changedBy: is required unless the project is paused');
    expect(await getProject(db, repo)).toMatchObject({ status: 'pending', statusChangedBy: maintainer.githubId });
    expect(await statusHistory(db, repo)).toHaveLength(1);
  });

  test('a status change that changes nothing adds nothing to the history', async () => {
    await registeredProject();

    const same = await setProjectStatus(db, repo, { status: 'approved', reason: null, changedBy: admin.githubId }, t0 + HOUR);

    expect(same).toMatchObject({ statusChangedBy: maintainer.githubId, statusChangedAt: t0 });
    expect(await statusHistory(db, repo)).toHaveLength(1);
  });

  test('two identical pauses at once add one history row, and the project names the one that landed', async () => {
    await registeredProject();
    const pause = { status: 'paused' as const, reason: 'Busy week.' };

    await Promise.all([
      setProjectStatus(db, repo, { ...pause, changedBy: maintainer.githubId }, t0 + HOUR),
      setProjectStatus(db, repo, { ...pause, changedBy: coMaintainer.githubId }, t0 + HOUR + 1),
    ]);

    const [newest, ...older] = await statusHistory(db, repo);
    expect(older).toHaveLength(1);
    expect(await getProject(db, repo)).toMatchObject({
      status: 'paused',
      statusReason: 'Busy week.',
      statusChangedBy: newest?.changedBy,
      statusChangedAt: newest?.changedAt,
    });
  });

  test('two different status changes at once both land, and the project matches the newest', async () => {
    await registeredProject();

    await Promise.all([
      setProjectStatus(db, repo, { status: 'paused', reason: 'Busy week.', changedBy: maintainer.githubId }, t0 + HOUR),
      setProjectStatus(
        db,
        repo,
        { status: 'paused', reason: 'Moving to a new CI.', changedBy: coMaintainer.githubId },
        t0 + HOUR + 1,
      ),
    ]);

    const history = await statusHistory(db, repo);
    expect(history).toHaveLength(3);
    expect(history.map((c) => c.reason)).toEqual(expect.arrayContaining(['Busy week.', 'Moving to a new CI.', null]));
    const newest = history[0];
    expect(await getProject(db, repo)).toMatchObject({
      status: newest?.status,
      statusReason: newest?.reason,
      statusChangedBy: newest?.changedBy,
      statusChangedAt: newest?.changedAt,
    });
  });

  test('a new reason for a paused project is a change', async () => {
    await registeredProject();
    const pause = { status: 'paused' as const, changedBy: maintainer.githubId };
    await setProjectStatus(db, repo, { ...pause, reason: 'Busy week.' }, t0 + HOUR);

    await setProjectStatus(db, repo, { ...pause, reason: 'Busy month.' }, t0 + 2 * HOUR);

    expect((await statusHistory(db, repo)).map((c) => c.reason)).toEqual(['Busy month.', 'Busy week.', null]);
  });
});

describe('project settings', () => {
  test('settings history records who changed what', async () => {
    await registeredProject({ tags: ['help wanted'] });

    await changeSettings(db, repo, { prMode: 'automatic', claimsPerIssue: 2 }, coMaintainer.githubId, t0 + HOUR);

    const history = await settingsHistory(db, repo);
    expect(history.map(({ version, changed, changedBy, changedAt }) => ({ version, changed, changedBy, changedAt }))).toEqual([
      { version: 2, changed: ['prMode', 'claimsPerIssue'], changedBy: coMaintainer.githubId, changedAt: t0 + HOUR },
      { version: 1, changed: settingKeys, changedBy: maintainer.githubId, changedAt: t0 },
    ]);
    expect(history[1]?.settings).toMatchObject({ prMode: 'reviewed', claimsPerIssue: 3 });
    expect(history[0]?.settings).toMatchObject({ prMode: 'automatic', claimsPerIssue: 2 });
  });

  test('a change applies at once, and settings it leaves out keep their value', async () => {
    await registeredProject({ tags: ['help wanted'], agentNotes: 'Run the tests first.' });

    const result = await changeSettings(db, repo, { prMode: 'automatic' }, maintainer.githubId, t0 + HOUR);

    expect(result).toMatchObject({ ok: true, changed: ['prMode'] });
    expect(await getProject(db, repo)).toMatchObject({
      settingsVersion: 2,
      settings: { prMode: 'automatic', agentNotes: 'Run the tests first.', tags: ['help wanted'] },
    });
  });

  test('a change that changes nothing adds nothing to the history', async () => {
    await registeredProject({ tags: ['help wanted'], prMode: 'automatic' });

    const result = await changeSettings(db, repo, { prMode: 'automatic' }, coMaintainer.githubId, t0 + HOUR);

    expect(result).toMatchObject({ ok: true, changed: [] });
    expect(await settingsHistory(db, repo)).toHaveLength(1);
  });

  test('an invalid change is refused with the setting named, and saves nothing', async () => {
    await registeredProject({ tags: ['help wanted'] });

    const result = await changeSettings(db, repo, { excludedTags: ['Help Wanted'] }, maintainer.githubId, t0 + HOUR);

    expect(result).toEqual({
      ok: false,
      problems: [{ field: 'excludedTags', message: 'lists "Help Wanted", which is also a tag' }],
    });
    expect(await settingsHistory(db, repo)).toHaveLength(1);
    expect((await getProject(db, repo))?.settings.excludedTags).toEqual([]);
  });

  test('two maintainers changing different settings at once both keep their change', async () => {
    await registeredProject({ tags: ['help wanted'] });

    await Promise.all([
      changeSettings(db, repo, { prMode: 'automatic' }, maintainer.githubId, t0 + HOUR),
      changeSettings(db, repo, { claimsPerIssue: 5 }, coMaintainer.githubId, t0 + HOUR),
    ]);

    expect((await getProject(db, repo))?.settings).toMatchObject({ prMode: 'automatic', claimsPerIssue: 5 });
    const history = await settingsHistory(db, repo);
    expect(history.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(history.slice(0, 2).flatMap((v) => v.changed).sort()).toEqual(['claimsPerIssue', 'prMode']);
  });

  test('a change by someone who never signed in is refused, so every change names a real person', async () => {
    await registeredProject({ tags: ['help wanted'] });

    await refusal(changeSettings(db, repo, { prMode: 'automatic' }, priya.githubId, t0 + HOUR));

    expect(await getProject(db, repo)).toMatchObject({ settingsVersion: 1, settings: { prMode: 'reviewed' } });
    expect(await settingsHistory(db, repo)).toHaveLength(1);
  });

  test('changing the settings of a repo that is not a project saves nothing', async () => {
    expect(await changeSettings(db, repo, { prMode: 'automatic' }, maintainer.githubId, t0)).toBeNull();
    expect(await settingsHistory(db, repo)).toEqual([]);
  });

  test('stored settings that break the schema are refused on the way out, naming the field', async () => {
    await registeredProject({ tags: ['help wanted'] });
    await db
      .prepare("UPDATE project_settings SET settings = json_set(settings, '$.claimsPerIssue', 50) WHERE repo = ?")
      .bind(repo)
      .run();

    expect(await refusal(getProject(db, repo))).toContain(
      'settings.claimsPerIssue: must be a whole number from 1 to 10',
    );
  });
});

describe('a maintainer taking over a listing made from a policy', () => {
  async function listing() {
    return createProject(
      db,
      { repo, status: 'approved', source: 'policy', policy, settings: { tags: ['ready'], prMode: 'automatic' }, addedBy: admin.githubId },
      t0,
    );
  }

  test("the maintainer's settings replace the listing's, the project becomes registered with no policy, and its status stays", async () => {
    await listing();

    const took = await takeOverListing(db, repo, { tags: ['help wanted'], claimsPerIssue: 2 }, maintainer.githubId, t0 + HOUR);

    const stored = await getProject(db, repo);
    expect(took?.project).toEqual(stored);
    expect(stored).toMatchObject({
      source: 'registered',
      policy: null,
      status: 'approved',
      statusChangedBy: admin.githubId,
      addedBy: maintainer.githubId,
      addedAt: t0 + HOUR,
      settingsVersion: 2,
    });
    // Whole settings: prMode, which the maintainer left out, is back to its default.
    expect(stored?.settings).toMatchObject({ tags: ['help wanted'], claimsPerIssue: 2, prMode: 'reviewed' });
    expect(took?.changed.sort()).toEqual(['claimsPerIssue', 'prMode', 'tags']);
    expect((await settingsHistory(db, repo))[0]).toMatchObject({ version: 2, changedBy: maintainer.githubId, changedAt: t0 + HOUR });
    expect(await statusHistory(db, repo)).toHaveLength(1);
  });

  test("settings the same as the listing's save no new version, and the project still becomes registered", async () => {
    await listing();

    const took = await takeOverListing(db, repo, { tags: ['ready'], prMode: 'automatic' }, maintainer.githubId, t0 + HOUR);

    expect(took?.changed).toEqual([]);
    expect(await getProject(db, repo)).toMatchObject({ source: 'registered', policy: null, settingsVersion: 1 });
    expect(await settingsHistory(db, repo)).toHaveLength(1);
  });

  test('a registered project, or a repo that is no project, is not taken over', async () => {
    await registeredProject({ tags: ['help wanted'] });

    expect(await takeOverListing(db, repo, { tags: ['ready'] }, coMaintainer.githubId, t0 + HOUR)).toBeNull();
    expect(await takeOverListing(db, 'sample-owner/sample-tools', { tags: ['ready'] }, coMaintainer.githubId, t0)).toBeNull();
    expect(await getProject(db, repo)).toMatchObject({ addedBy: maintainer.githubId, settings: { tags: ['help wanted'] } });
  });
});
