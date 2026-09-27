import { beforeEach, describe, expect, test } from 'vitest';
import { countSessionIssue, createSession, getSession, lastSession } from '../../src/db';
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

  test('every issue claimed in a session counts against it, even when claims arrive at once', async () => {
    const session = await createSession(
      db,
      { githubId: priya.githubId, agent: 'codex', budget: { kind: 'issues', count: 5 } },
      t0,
    );

    await Promise.all([1, 2, 3].map(() => countSessionIssue(db, session.id)));

    expect((await getSession(db, session.id))?.issuesClaimed).toBe(3);
    expect(await countSessionIssue(db, 's_missing')).toBeNull();
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
