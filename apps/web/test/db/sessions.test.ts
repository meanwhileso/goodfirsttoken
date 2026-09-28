import { beforeEach, describe, expect, test } from 'vitest';
import {
  createSession,
  editSessionQueue,
  getSession,
  lastSession,
  returnSessionIssue,
  takeSessionIssue,
} from '../../src/db';
import { db, emptyDatabase, HOUR, kenji, priya, refusal, signIn, t0 } from './helpers';

beforeEach(async () => {
  await emptyDatabase();
  await signIn(priya, kenji);
});

describe('donor sessions', () => {
  test('a new session starts with its budget and no issues claimed', async () => {
    const session = await createSession(
      db,
      { githubId: priya.githubId, agent: 'claude-code', budget: { kind: 'issues', count: 3 } },
      t0,
    );

    expect(session).toMatchObject({
      githubId: priya.githubId,
      agent: 'claude-code',
      budget: { kind: 'issues', count: 3 },
      startedAt: t0,
      issuesClaimed: 0,
    });
    expect(await getSession(db, session.id)).toEqual(session);
    expect(await getSession(db, 's_missing')).toBeNull();
  });

  test('claims counted against a budget of issues at the same moment never take more than it has, and a count given back frees one', async () => {
    const session = await createSession(
      db,
      { githubId: priya.githubId, agent: 'codex', budget: { kind: 'issues', count: 2 } },
      t0,
    );

    const taken = await Promise.all([1, 2, 3, 4, 5].map(() => takeSessionIssue(db, session.id, t0)));
    const full = (await getSession(db, session.id))?.issuesClaimed;
    await returnSessionIssue(db, session.id);
    const again = await takeSessionIssue(db, session.id, t0);

    expect(taken.filter((s) => s !== null)).toHaveLength(2);
    expect(full).toBe(2);
    expect(again).toMatchObject({ issuesClaimed: 2 });
    expect(await takeSessionIssue(db, 's_missing', t0)).toBeNull();
  });

  test('a budget of time takes no count once its minutes have passed', async () => {
    const session = await createSession(
      db,
      { githubId: priya.githubId, agent: 'codex', budget: { kind: 'time', minutes: 30 } },
      t0,
    );

    expect(await takeSessionIssue(db, session.id, t0 + 30 * 60_000 - 1)).toMatchObject({ issuesClaimed: 1 });
    expect(await takeSessionIssue(db, session.id, t0 + 30 * 60_000)).toBeNull();
  });

  test("a session keeps the donor's picks in order, and an edit changes them", async () => {
    const session = await createSession(db, { githubId: priya.githubId, agent: 'codex', budget: { kind: 'until_limit' } }, t0);

    await editSessionQueue(db, session.id, () => ['sample-owner/sample-app#3', 'sample-owner/sample-app#1']);
    const first = (await getSession(db, session.id))?.queue;
    await editSessionQueue(db, session.id, (queue) => queue.slice(1));

    expect(session.queue).toEqual([]);
    expect(first).toEqual(['sample-owner/sample-app#3', 'sample-owner/sample-app#1']);
    expect((await getSession(db, session.id))?.queue).toEqual(['sample-owner/sample-app#1']);
    expect(await editSessionQueue(db, 's_missing', () => [])).toBeNull();
  });

  test('edits to a queue at the same moment each apply to the queue as the other left it, so no pick comes back', async () => {
    const session = await createSession(db, { githubId: priya.githubId, agent: 'codex', budget: { kind: 'until_limit' } }, t0);
    const [a, b, c] = ['sample-owner/sample-app#1', 'sample-owner/sample-app#2', 'sample-owner/sample-app#3'];
    await editSessionQueue(db, session.id, () => [a, b, c]);

    await Promise.all([
      editSessionQueue(db, session.id, (queue) => queue.filter((pick) => pick !== a)),
      editSessionQueue(db, session.id, (queue) => queue.filter((pick) => pick !== b)),
    ]);

    expect((await getSession(db, session.id))?.queue).toEqual([c]);
  });

  test("a donor's last session is their most recent one", async () => {
    const budget = { kind: 'time' as const, minutes: 90 };
    await createSession(db, { githubId: priya.githubId, agent: 'claude-code', budget }, t0);
    const latest = await createSession(db, { githubId: priya.githubId, agent: 'opencode', budget }, t0 + HOUR);
    await createSession(db, { githubId: kenji.githubId, agent: 'codex', budget }, t0 + 2 * HOUR);

    expect(await lastSession(db, priya.githubId)).toEqual(latest);
  });

  test('a donor with no session yet has no last session', async () => {
    expect(await lastSession(db, priya.githubId)).toBeNull();
  });

  test('a budget over the limit is refused, naming the field', async () => {
    const message = await refusal(
      createSession(db, { githubId: priya.githubId, agent: 'claude-code', budget: { kind: 'issues', count: 101 } }, t0),
    );

    expect(message).toContain('budget.count: must be a whole number from 1 to 100');
    expect(await lastSession(db, priya.githubId)).toBeNull();
  });
});
