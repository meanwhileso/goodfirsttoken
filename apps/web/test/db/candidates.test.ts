import { beforeEach, describe, expect, test } from 'vitest';
import {
  addCandidate,
  addToDoNotList,
  decideCandidate,
  getCandidate,
  getWaitingCandidate,
  listCandidates,
  type NewCandidate,
} from '../../src/db';
import { admin, DAY, db, emptyDatabase, HOUR, refusal, repo, signIn, t0 } from './helpers';

const found: NewCandidate = {
  repo,
  facts: { stars: 1200, createdAt: t0 - 900 * DAY, pushedAt: t0 - DAY, ownerCreatedAt: t0 - 2000 * DAY },
  policy: {
    quote: 'Agents may open pull requests on issues labeled ready for help.',
    url: 'https://github.com/sample-owner/sample-app/blob/main/AI_POLICY.md',
    tier: 'invites_agents',
  },
  settings: { prMode: 'automatic', disclosure: { trailer: 'Assisted-by', prBody: null } },
  suggestedTags: [{ name: 'ready for help', openIssues: 8 }],
};

beforeEach(async () => {
  await emptyDatabase();
  await signIn(admin);
});

describe('crawl candidates', () => {
  test('a crawler find waits in the admin queue with its facts, policy, and suggestions', async () => {
    const added = await addCandidate(db, found, t0);

    expect(added).toMatchObject({ ...found, foundAt: t0, status: 'waiting', decidedBy: null, decidedAt: null, reason: null });
    expect(await getCandidate(db, added?.id ?? '')).toEqual(added);
    expect(await listCandidates(db, 'waiting')).toEqual([added]);
    expect(await getCandidate(db, 'cand_missing')).toBeNull();
  });

  test('a repo waits in the queue at most once, whatever the case of its name', async () => {
    await addCandidate(db, found, t0);

    expect(await addCandidate(db, { ...found, repo: 'Sample-Owner/Sample-App' }, t0 + HOUR)).toBeNull();
    expect(await listCandidates(db, 'waiting')).toHaveLength(1);
  });

  test('a repo on the do-not-list never enters the admin queue', async () => {
    await addToDoNotList(db, { repo: 'Sample-Owner/Sample-App', reason: null, addedBy: admin.githubId }, t0);

    expect(await addCandidate(db, found, t0 + HOUR)).toBeNull();
    expect(await listCandidates(db, 'waiting')).toEqual([]);
  });

  test('a rejection keeps its reason, who decided, and when, and leaves the queue', async () => {
    const added = await addCandidate(db, found, t0);

    const rejected = await decideCandidate(
      db,
      added?.id ?? '',
      { status: 'rejected', decidedBy: admin.githubId, reason: 'The policy covers docs changes only.' },
      t0 + DAY,
    );

    expect(rejected).toMatchObject({
      status: 'rejected',
      decidedBy: admin.githubId,
      decidedAt: t0 + DAY,
      reason: 'The policy covers docs changes only.',
    });
    expect(await listCandidates(db, 'waiting')).toEqual([]);
    expect(await listCandidates(db, 'rejected')).toEqual([rejected]);
  });

  test('a rejection without a reason is refused, and the candidate keeps waiting', async () => {
    const added = await addCandidate(db, found, t0);

    const message = await refusal(
      decideCandidate(db, added?.id ?? '', { status: 'rejected', decidedBy: admin.githubId, reason: null }, t0 + DAY),
    );

    expect(message).toContain('reason: is required to reject');
    expect((await getCandidate(db, added?.id ?? ''))?.status).toBe('waiting');
  });

  test('a candidate is decided once', async () => {
    const added = await addCandidate(db, found, t0);
    const approve = { status: 'approved' as const, decidedBy: admin.githubId, reason: null };
    const approved = await decideCandidate(db, added?.id ?? '', approve, t0 + DAY);

    expect(
      await decideCandidate(db, added?.id ?? '', { ...approve, status: 'rejected', reason: 'Changed my mind.' }, t0 + 2 * DAY),
    ).toBeNull();
    expect(await getCandidate(db, added?.id ?? '')).toEqual(approved);
  });

  test('a repo decided before can wait in the queue again', async () => {
    const first = await addCandidate(db, found, t0);
    await decideCandidate(
      db,
      first?.id ?? '',
      { status: 'rejected', decidedBy: admin.githubId, reason: 'Too few tagged issues.' },
      t0 + DAY,
    );

    const again = await addCandidate(db, found, t0 + 30 * DAY);

    expect(again).toMatchObject({ repo, status: 'waiting', foundAt: t0 + 30 * DAY });
    expect(again?.id).not.toBe(first?.id);
  });

  test("a repo's waiting find is found whatever the case of its name, and a decided one isn't", async () => {
    const waiting = await addCandidate(db, found, t0);

    expect(await getWaitingCandidate(db, 'SAMPLE-OWNER/sample-app')).toEqual(waiting);
    await decideCandidate(db, waiting?.id ?? '', { status: 'approved', decidedBy: admin.githubId, reason: null }, t0 + DAY);
    expect(await getWaitingCandidate(db, repo)).toBeNull();
  });
});
