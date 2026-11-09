import type { D1Migration } from 'cloudflare:test';
import { newClaim, type ClaimRecord } from '@goodfirsttoken/core';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  addPr,
  addToDoNotList,
  blockDonor,
  countProjectPrs,
  createSession,
  getPr,
  listOpenPrs,
  listClaimFollowUps,
  listOpenPrsOf,
  giveToWake,
  saveClaim,
  saveFollowThrough,
  saveFollowUps,
  setReviewsRead,
  supersedeFollowUps,
  listEndedToOffer,
  listReopenedClaimPrs,
  markEndedOffered,
  setPrState,
  unblockDonor,
} from '../../src/db';
import { admin, DAY, db, emptyDatabase, HOUR, kenji, MINUTE, priya, refusal, repo, sha, signIn, t0, takeOffDoNotList } from './helpers';

function prRef(number: number) {
  return { repo, number, url: `https://github.com/${repo}/pull/${String(number)}` };
}

/** A claim the room holds as pr_opened, with its PR. */
function openedClaim(claimId: string, number: number): ClaimRecord {
  return {
    id: claimId,
    issue: `${repo}#${String(number - 40)}`,
    project: repo,
    githubId: priya.githubId,
    login: priya.login,
    agent: 'claude-code',
    ownProject: false,
    startCommit: sha,
    tokenEstimate: null,
    ...newClaim(t0),
    state: 'pr_opened',
    submittedAt: t0 + HOUR,
    pr: prRef(number),
  };
}

beforeEach(async () => {
  await emptyDatabase();
  await signIn(priya);
  await saveClaim(db, openedClaim('c_1', 57), 1);
  await saveClaim(db, openedClaim('c_2', 58), 1);
});

describe('PRs', () => {
  test("a claim's PR is recorded as open", async () => {
    const added = await addPr(db, { claimId: 'c_1', pr: prRef(57), openedAt: t0 + 2 * HOUR });

    expect(added).toEqual({
      claimId: 'c_1',
      pr: prRef(57),
      state: 'open',
      openedAt: t0 + 2 * HOUR,
      mergedAt: null,
      closedAt: null,
    });
    expect(await getPr(db, 'c_1')).toEqual(added);
    expect(await getPr(db, 'c_2')).toBeNull();
  });

  test('recording the same PR again keeps the first record', async () => {
    const first = await addPr(db, { claimId: 'c_1', pr: prRef(57), openedAt: t0 + 2 * HOUR });

    expect(await addPr(db, { claimId: 'c_1', pr: prRef(57), openedAt: t0 + 3 * HOUR })).toEqual(first);
  });

  test("a claim's PR is the one the claim records, and can't be swapped for another", async () => {
    const message = await refusal(addPr(db, { claimId: 'c_1', pr: prRef(59), openedAt: t0 + 2 * HOUR }));
    expect(message).toContain(`records ${repo}#57`);
    expect(await getPr(db, 'c_1')).toBeNull();

    await saveClaim(db, { ...openedClaim('c_3', 60), state: 'awaiting_review', pr: null }, 1);
    await addPr(db, { claimId: 'c_3', pr: prRef(60), openedAt: t0 + 2 * HOUR });

    await refusal(addPr(db, { claimId: 'c_3', pr: prRef(61), openedAt: t0 + 3 * HOUR }));
    expect((await getPr(db, 'c_3'))?.pr).toEqual(prRef(60));
  });

  test('a PR belongs to one claim', async () => {
    await addPr(db, { claimId: 'c_1', pr: prRef(57), openedAt: t0 + 2 * HOUR });
    await saveClaim(db, { ...openedClaim('c_3', 60), state: 'awaiting_review', pr: null }, 1);

    const message = await refusal(addPr(db, { claimId: 'c_3', pr: prRef(57), openedAt: t0 + 2 * HOUR }));

    expect(message).toContain('already recorded for claim c_1');
    expect(await getPr(db, 'c_3')).toBeNull();
  });

  test('a merged PR records when it merged and when it closed, and stays merged', async () => {
    await addPr(db, { claimId: 'c_1', pr: prRef(57), openedAt: t0 });

    const merged = await setPrState(db, 'c_1', 'merged', t0 + DAY);

    expect(merged).toMatchObject({ state: 'merged', mergedAt: t0 + DAY, closedAt: t0 + DAY });
    expect(await setPrState(db, 'c_1', 'closed', t0 + 2 * DAY)).toEqual(merged);
    expect(await setPrState(db, 'c_1', 'open', t0 + 2 * DAY)).toEqual(merged);
    expect(await getPr(db, 'c_1')).toEqual(merged);
  });

  test("a PR's times change only when its state does", async () => {
    await addPr(db, { claimId: 'c_1', pr: prRef(57), openedAt: t0 });
    await setPrState(db, 'c_1', 'closed', t0 + DAY);

    const again = await setPrState(db, 'c_1', 'closed', t0 + 2 * DAY);

    expect(again).toMatchObject({ state: 'closed', mergedAt: null, closedAt: t0 + DAY });
  });

  test('a reopened PR is open again, with no close time', async () => {
    await addPr(db, { claimId: 'c_1', pr: prRef(57), openedAt: t0 });
    await setPrState(db, 'c_1', 'closed', t0 + DAY);

    expect(await setPrState(db, 'c_1', 'open', t0 + 2 * DAY)).toMatchObject({ state: 'open', closedAt: null });
  });

  test('a merge or close time before the PR opened counts as the time it opened, since clocks differ', async () => {
    await addPr(db, { claimId: 'c_1', pr: prRef(57), openedAt: t0 + DAY });

    const merged = await setPrState(db, 'c_1', 'merged', t0);

    expect(merged).toMatchObject({ state: 'merged', mergedAt: t0 + DAY, closedAt: t0 + DAY });
  });

  test('the job that follows PRs sees the open ones, oldest first', async () => {
    await addPr(db, { claimId: 'c_2', pr: prRef(58), openedAt: t0 + HOUR });
    await addPr(db, { claimId: 'c_1', pr: prRef(57), openedAt: t0 });

    expect((await listOpenPrs(db)).map((p) => p.claimId)).toEqual(['c_1', 'c_2']);

    await setPrState(db, 'c_1', 'merged', t0 + DAY);

    expect((await listOpenPrs(db)).map((p) => p.claimId)).toEqual(['c_2']);
  });

  test("a project's PR counts are its claims' open PRs and merged PRs, and a closed PR counts in neither", async () => {
    await saveClaim(db, openedClaim('c_3', 59), 1);
    await saveClaim(db, { ...openedClaim('c_4', 60), project: 'sample-owner/sample-tools' }, 1);
    await addPr(db, { claimId: 'c_1', pr: prRef(57), openedAt: t0 });
    await addPr(db, { claimId: 'c_2', pr: prRef(58), openedAt: t0 });
    await addPr(db, { claimId: 'c_3', pr: prRef(59), openedAt: t0 });
    await addPr(db, { claimId: 'c_4', pr: prRef(60), openedAt: t0 });
    await setPrState(db, 'c_2', 'merged', t0 + DAY);
    await setPrState(db, 'c_3', 'closed', t0 + DAY);

    expect(await countProjectPrs(db, repo.toUpperCase())).toEqual({ open: 1, merged: 1 });
    expect(await countProjectPrs(db, 'sample-owner/sample-tools')).toEqual({ open: 1, merged: 0 });
    expect(await countProjectPrs(db, 'sample-owner/nothing-here')).toEqual({ open: 0, merged: 0 });
  });

  test("a claim's PR recorded closed is found open again for its own issue alone, and an open or merged one never", async () => {
    await addPr(db, { claimId: 'c_1', pr: prRef(57), openedAt: t0 });
    await addPr(db, { claimId: 'c_2', pr: prRef(58), openedAt: t0 });
    await setPrState(db, 'c_1', 'closed', t0 + DAY);

    // c_1 is on #17, and c_2, whose PR is still open, on #18.
    const own = await listReopenedClaimPrs(db, [prRef(57), prRef(58)], `${repo}#17`);
    const other = await listReopenedClaimPrs(db, [prRef(57)], `${repo}#18`);
    await setPrState(db, 'c_1', 'open', t0 + 2 * DAY);
    await setPrState(db, 'c_1', 'merged', t0 + 3 * DAY);

    expect(own).toEqual([{ claimId: 'c_1', pr: prRef(57) }]);
    expect(other).toEqual([]);
    expect(await listReopenedClaimPrs(db, [prRef(57)], `${repo}#17`)).toEqual([]);
  });

  test('a claim with no PR has no state to set', async () => {
    expect(await setPrState(db, 'c_1', 'merged', t0 + DAY)).toBeNull();
  });
});

describe('merged and closed PRs offered to their donor', () => {
  /** What a session offers the donor: the ended PRs it listed and then marked offered. */
  async function takeEndedToOffer(person: number, now: number) {
    const listed = await listEndedToOffer(db, person);
    const taken = await markEndedOffered(
      db,
      listed.map((pr) => pr.claimId),
      now,
    );
    return listed.filter((pr) => taken.has(pr.claimId));
  }

  beforeEach(async () => {
    await addPr(db, { claimId: 'c_1', pr: prRef(57), openedAt: t0 + 2 * HOUR });
    await addPr(db, { claimId: 'c_2', pr: prRef(58), openedAt: t0 + 2 * HOUR });
  });

  test('a PR that merged or closed is offered to its donor once, with how it ended, and an open one never', async () => {
    await setPrState(db, 'c_1', 'merged', t0 + DAY);
    await saveClaim(db, openedClaim('c_3', 59), 1);
    await addPr(db, { claimId: 'c_3', pr: prRef(59), openedAt: t0 + 2 * HOUR });
    await setPrState(db, 'c_3', 'closed', t0 + DAY + HOUR);

    const first = await takeEndedToOffer(priya.githubId, t0 + 2 * DAY);
    const again = await takeEndedToOffer(priya.githubId, t0 + 3 * DAY);

    expect(first).toEqual([
      { claimId: 'c_1', issue: `${repo}#17`, pr: prRef(57), outcome: 'merged', agent: 'claude-code', title: null, closedAt: t0 + DAY },
      { claimId: 'c_3', issue: `${repo}#19`, pr: prRef(59), outcome: 'closed', agent: 'claude-code', title: null, closedAt: t0 + DAY + HOUR },
    ]);
    expect(again).toEqual([]);
    expect(await takeEndedToOffer(kenji.githubId, t0 + 2 * DAY)).toEqual([]);
  });

  test('of two sessions that list the same ended PR at once, only the one that marks it first offers it', async () => {
    await setPrState(db, 'c_1', 'merged', t0 + DAY);
    const one = await listEndedToOffer(db, priya.githubId);
    const other = await listEndedToOffer(db, priya.githubId);

    const first = await markEndedOffered(db, one.map((pr) => pr.claimId), t0 + 2 * DAY);
    const second = await markEndedOffered(db, other.map((pr) => pr.claimId), t0 + 2 * DAY);

    expect([one.length, other.length]).toEqual([1, 1]);
    expect([...first]).toEqual(['c_1']);
    expect([...second]).toEqual([]);
  });

  test('listing the ended PRs marks none offered, so a session whose answer fails leaves them for the next', async () => {
    await setPrState(db, 'c_1', 'closed', t0 + DAY);

    await listEndedToOffer(db, priya.githubId);

    expect(await takeEndedToOffer(priya.githubId, t0 + 2 * DAY)).toMatchObject([{ claimId: 'c_1', outcome: 'closed' }]);
  });

  test("a blocked donor's PR, and one the do-not-list names, is not offered, and waits until neither holds", async () => {
    await signIn(admin);
    await setPrState(db, 'c_1', 'merged', t0 + DAY);
    await blockDonor(db, { githubId: priya.githubId, reason: null, blockedBy: admin.githubId }, t0 + DAY);
    const whileBlocked = await takeEndedToOffer(priya.githubId, t0 + 2 * DAY);
    await unblockDonor(db, priya.githubId);
    await addToDoNotList(db, { repo, reason: null, addedBy: admin.githubId }, t0 + 2 * DAY);
    const whileListed = await takeEndedToOffer(priya.githubId, t0 + 3 * DAY);
    await takeOffDoNotList(repo);

    expect([whileBlocked, whileListed]).toEqual([[], []]);
    expect(await takeEndedToOffer(priya.githubId, t0 + 4 * DAY)).toMatchObject([{ claimId: 'c_1' }]);
  });

  test('the migration that brought the offer offers no PR that ended before its donor started a session', async () => {
    await setPrState(db, 'c_1', 'merged', t0 + DAY);
    await setPrState(db, 'c_2', 'closed', t0 + DAY);
    await saveClaim(db, openedClaim('c_3', 59), 1);
    await addPr(db, { claimId: 'c_3', pr: prRef(59), openedAt: t0 + 2 * HOUR });
    await setPrState(db, 'c_3', 'merged', t0 + 3 * DAY);
    await createSession(db, { githubId: priya.githubId, agent: 'claude-code', budget: { kind: 'until_limit' } }, t0 + 2 * DAY);
    const { TEST_MIGRATIONS } = env as Env & { TEST_MIGRATIONS: D1Migration[] };
    const migration = TEST_MIGRATIONS.find((m) => m.name === '0010_follow_ups.sql');
    // The table and the columns are there already, so only the rows it writes run again.
    const writes = migration?.queries.filter((query) => /^\s*UPDATE\b/i.test(query)) ?? [];

    for (const query of writes) await db.prepare(query).run();

    expect(writes).toHaveLength(1);
    expect(await takeEndedToOffer(priya.githubId, t0 + 4 * DAY)).toMatchObject([{ claimId: 'c_3' }]);
  });
});

describe('the migration that gave follow-ups their kinds', () => {
  test("keeps every follow-up stored before, in its order, as a maintainer's review or comment on a line", async () => {
    const { TEST_MIGRATIONS } = env as Env & { TEST_MIGRATIONS: D1Migration[] };
    const queries = (name: string) => TEST_MIGRATIONS.find((m) => m.name === name)?.queries ?? [];
    // The table as 0010 made it, with rows as they were stored then.
    const before = queries('0010_follow_ups.sql').filter((query) => /CREATE TABLE follow_ups\b/.test(query));
    // The new table, filled from the old one, then in its place.
    const after = queries('20261108191958_follow_up_kinds.sql').filter((query) => /\bfollow_ups(_next)?\b/.test(query));
    await db.prepare('DROP TABLE follow_ups').run();
    for (const query of before) await db.prepare(query).run();
    const insert = db.prepare(
      `INSERT INTO follow_ups (claim_id, comment_id, reviewer, body, path, url, written_at, read_at, shown_at, answered_at)
       VALUES (?, ?, 'octo-maintainer', ?, ?, 'https://github.com/a/b/pull/1', ?, ?, ?, NULL)`,
    );
    await db.batch([
      insert.bind('c_1', 'PRR_b', 'Add a test.', null, t0, t0, t0 + HOUR),
      insert.bind('c_1', 'PRRC_a', 'This drops the hash.', 'src/a.ts', t0, t0, null),
    ]);

    for (const query of after) await db.prepare(query).run();
    // The table as the next migration makes it, which the reads below take.
    for (const query of queries('20261108195209_follow_up_states.sql')) await db.prepare(query).run();

    expect(before).toHaveLength(1);
    expect(after).toHaveLength(4);
    expect((await listClaimFollowUps(db, 'c_1')).map((f) => [f.commentId, f.kind, f.reviewer, f.authorKind, f.path, f.shownAt])).toEqual([
      ['PRR_b', 'review', 'octo-maintainer', 'maintainer', null, t0 + HOUR],
      ['PRRC_a', 'line', 'octo-maintainer', 'maintainer', 'src/a.ts', null],
    ]);
  });
});

describe('the migration that gave follow-ups their states', () => {
  test('settles as fixed each follow-up a submit answered, keeps the rest open, and keeps their order', async () => {
    const { TEST_MIGRATIONS } = env as Env & { TEST_MIGRATIONS: D1Migration[] };
    const queries = (name: string) => TEST_MIGRATIONS.find((m) => m.name === name)?.queries ?? [];
    // The table as the migration before made it, with rows as they were stored then.
    const before = queries('20261108191958_follow_up_kinds.sql').filter((query) => /CREATE TABLE follow_ups_next\b/.test(query));
    await db.prepare('DROP TABLE follow_ups').run();
    for (const query of before) await db.prepare(query.replace('follow_ups_next', 'follow_ups')).run();
    const insert = db.prepare(
      `INSERT INTO follow_ups (claim_id, comment_id, kind, reviewer, author_kind, body, path, url, written_at, read_at, shown_at, answered_at)
       VALUES ('c_1', ?, ?, ?, ?, 'Add a test.', NULL, 'https://github.com/a/b/pull/1', ?, ?, ?, ?)`,
    );
    await db.batch([
      insert.bind('PRR_b', 'review', 'octo-maintainer', 'maintainer', t0 + HOUR, t0 + HOUR, t0 + HOUR, t0 + 2 * HOUR),
      insert.bind('abc', 'checks', null, null, t0, t0, null, null),
      insert.bind('IC_a', 'conversation', 'octo-bot', 'bot', t0, t0, t0 + HOUR, null),
    ]);

    for (const query of queries('20261108195209_follow_up_states.sql')) await db.prepare(query).run();

    expect(before).toHaveLength(1);
    expect((await listClaimFollowUps(db, 'c_1')).map((f) => [f.commentId, f.state, f.outcome, f.answeredAt, f.question, f.replyUrl])).toEqual([
      ['abc', 'open', null, null, null, null],
      ['IC_a', 'open', null, null, null, null],
      ['PRR_b', 'settled', 'fixed', t0 + 2 * HOUR, null, null],
    ]);
    // A settled follow-up has an outcome and a time, and only one that waits for the donor has a question.
    const bad = (state: string, outcome: string | null, answeredAt: number | null, question: string | null) =>
      db
        .prepare(
          `INSERT INTO follow_ups (claim_id, comment_id, kind, reviewer, author_kind, body, path, url, written_at, read_at, state, outcome, answered_at, question)
           VALUES ('c_1', 'X', 'review', 'octo', 'maintainer', 'b', NULL, 'https://github.com/a/b/pull/1', 1, 1, ?, ?, ?, ?)`,
        )
        .bind(state, outcome, answeredAt, question)
        .run();
    await expect(bad('settled', null, t0, null)).rejects.toThrow();
    await expect(bad('settled', 'fixed', null, null)).rejects.toThrow();
    await expect(bad('open', 'fixed', t0, null)).rejects.toThrow();
    await expect(bad('waiting_donor', null, null, null)).rejects.toThrow();
    await expect(bad('open', null, null, 'Why?')).rejects.toThrow();
    await expect(bad('settled', 'superseded', t0, null)).rejects.toThrow();
    await expect(bad('settled', 'replied', t0, null)).rejects.toThrow();
  });
});

describe('superseding checks and conflicts', () => {
  const checks = (head: string) => ({
    commentId: head,
    kind: 'checks' as const,
    reviewer: null,
    authorKind: null,
    body: 'FAILURE: test',
    path: null,
    url: `https://github.com/${repo}/pull/57/checks?sha=${head}`,
    writtenAt: t0,
  });
  const conflict = (head: string, base: string) => ({ ...checks(head), commentId: `${head}:${base}`, kind: 'conflict' as const, body: 'CONFLICTING with main', url: prRef(57).url });
  const states = async () => (await listClaimFollowUps(db, 'c_1')).map((f) => [f.commentId, f.state, f.outcome]);

  test('a read made before another, that lands after it, supersedes nothing the other stored', async () => {
    const [old, next] = ['a'.repeat(40), 'b'.repeat(40)];
    await saveFollowUps(db, 'c_1', [checks(old), conflict(old, 'c'.repeat(40))], t0);
    // The newer read, at t0 + 2 hours, finds a new head that fails and conflicts.
    await supersedeFollowUps(db, [{ claimId: 'c_1', head: next, mergeable: 'CONFLICTING', readAt: t0 + 2 * HOUR }], t0 + 2 * HOUR);
    await saveFollowUps(db, 'c_1', [checks(next), conflict(next, 'c'.repeat(40))], t0 + 2 * HOUR);

    // The older read, made at t0 + 1 hour, lands now, and found the old head mergeable.
    const superseded = await supersedeFollowUps(db, [{ claimId: 'c_1', head: old, mergeable: 'MERGEABLE', readAt: t0 + HOUR }], t0 + 3 * HOUR);

    expect(superseded).toBe(0);
    expect(await states()).toEqual([
      [old, 'settled', 'superseded'],
      [`${old}:${'c'.repeat(40)}`, 'settled', 'superseded'],
      [next, 'open', null],
      [`${next}:${'c'.repeat(40)}`, 'open', null],
    ]);
  });

  test('checks that fail again on a head a push left, and a conflict again after the PR could merge, come back open, as new to each wake', async () => {
    const [old, next, base] = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)];
    await addPr(db, { claimId: 'c_1', pr: prRef(57), openedAt: t0 });
    const wake = (await saveFollowThrough(db, priya.githubId, { save: { harness: 'chatgpt', level: 'notify', intervalMinutes: 60 } }, t0)).saved;
    if (wake === null) throw new Error('no wake saved');
    await supersedeFollowUps(db, [{ claimId: 'c_1', head: old, mergeable: 'CONFLICTING', readAt: t0 }], t0);
    await saveFollowUps(db, 'c_1', [checks(old), conflict(old, base)], t0);
    const keys = [old, `${old}:${base}`].map((followUpId) => ({ claimId: 'c_1', followUpId }));
    await giveToWake(db, wake.id, keys, t0 + MINUTE);
    // A push to a new head that passes and can merge supersedes both.
    await supersedeFollowUps(db, [{ claimId: 'c_1', head: next, mergeable: 'MERGEABLE', readAt: t0 + HOUR }], t0 + HOUR);
    // The branch goes back to the old head, which fails and conflicts again.
    const back = t0 + 2 * HOUR;
    await supersedeFollowUps(db, [{ claimId: 'c_1', head: old, mergeable: 'CONFLICTING', readAt: back }], back);
    const added = await saveFollowUps(db, 'c_1', [{ ...checks(old), writtenAt: back }, { ...conflict(old, base), writtenAt: back }], back);

    expect(added).toBe(2);
    expect((await listClaimFollowUps(db, 'c_1')).map((f) => [f.commentId, f.state, f.outcome, f.writtenAt, f.readAt, f.shownAt, f.answeredAt])).toEqual([
      [old, 'open', null, back, back, null, null],
      [`${old}:${base}`, 'open', null, back, back, null, null],
    ]);
    expect(await giveToWake(db, wake.id, keys, back + MINUTE)).toEqual(keys);
  });

  test("checks on the same head that a run sorted stay as it sorted them when they fail again", async () => {
    const head = 'a'.repeat(40);
    await saveFollowUps(db, 'c_1', [checks(head)], t0);
    await db.prepare("UPDATE follow_ups SET state = 'settled', outcome = 'no_change', answered_at = ?1").bind(t0).run();

    const added = await saveFollowUps(db, 'c_1', [checks(head)], t0 + HOUR);

    expect(added).toBe(0);
    expect(await states()).toEqual([[head, 'settled', 'no_change']]);
  });

  test("a read that saves after a newer read started, before the newer one supersedes, is superseded by it, so only the newer head's checks stay open", async () => {
    const [a, b] = ['a'.repeat(40), 'b'.repeat(40)];
    await addPr(db, { claimId: 'c_1', pr: prRef(57), openedAt: t0 });
    const [startX, startY, saveX, saveY] = [t0 + HOUR, t0 + HOUR + MINUTE, t0 + HOUR + 2 * MINUTE, t0 + HOUR + 3 * MINUTE];
    // Read X starts first and finds head A failing. Read Y starts next and finds head B failing.
    await supersedeFollowUps(db, [{ claimId: 'c_1', head: a, mergeable: 'MERGEABLE', readAt: startX }], saveX);
    await saveFollowUps(db, 'c_1', [checks(a)], saveX, startX);
    await supersedeFollowUps(db, [{ claimId: 'c_1', head: b, mergeable: 'MERGEABLE', readAt: startY }], saveY);
    await saveFollowUps(db, 'c_1', [checks(b)], saveY, startY);

    expect(await states()).toEqual([
      [a, 'settled', 'superseded'],
      [b, 'open', null],
    ]);
    expect((await listOpenPrsOf(db, priya.githubId))[0]?.failedChecksHead).toBe(b);
  });

  test("a read made before another, that lands after it, adds no checks or conflict, and still adds its reviews", async () => {
    const [old, next] = ['a'.repeat(40), 'b'.repeat(40)];
    await addPr(db, { claimId: 'c_1', pr: prRef(57), openedAt: t0 });
    // The newer read, at t0 + 2 hours, finds a new head that passes and can merge.
    await supersedeFollowUps(db, [{ claimId: 'c_1', head: next, mergeable: 'MERGEABLE', readAt: t0 + 2 * HOUR }], t0 + 2 * HOUR);
    // The older read, made at t0 + 1 hour, lands now. It found the old head failing and conflicting, and a review.
    await supersedeFollowUps(db, [{ claimId: 'c_1', head: old, mergeable: 'CONFLICTING', readAt: t0 + HOUR }], t0 + 3 * HOUR);
    const review = { ...checks(old), commentId: 'PRR_1', kind: 'review' as const, reviewer: 'sample-maintainer', authorKind: 'maintainer' as const, body: 'Add a test.' };
    await saveFollowUps(db, 'c_1', [checks(old), conflict(old, 'c'.repeat(40)), review], t0 + 3 * HOUR, t0 + HOUR);

    expect(await states()).toEqual([['PRR_1', 'open', null]]);
  });

  test("UNKNOWN supersedes no conflict, even on a new head, and a settled follow-up stays as it settled", async () => {
    const [head, next] = ['a'.repeat(40), 'e'.repeat(40)];
    await saveFollowUps(db, 'c_1', [conflict(head, 'c'.repeat(40)), checks('d'.repeat(40))], t0);
    await db.prepare("UPDATE follow_ups SET state = 'settled', outcome = 'no_change', answered_at = ?1 WHERE kind = 'checks'").bind(t0).run();

    const superseded = await supersedeFollowUps(db, [{ claimId: 'c_1', head: next, mergeable: 'UNKNOWN', readAt: t0 + HOUR }], t0 + HOUR);

    expect(superseded).toBe(0);
    expect(await states()).toEqual([
      [`${head}:${'c'.repeat(40)}`, 'open', null],
      ['d'.repeat(40), 'settled', 'no_change'],
    ]);
  });
});

describe("a PR's reviews as reads covered them", () => {
  const reviewsOf = async (claimId: string) =>
    db.prepare('SELECT reviews, reviews_read, comments_left_out FROM prs WHERE claim_id = ?').bind(claimId).first();

  test('a read made before the one stored changes nothing, so two reads that land out of order never count the same reviews twice', async () => {
    await addPr(db, { claimId: 'c_1', pr: prRef(57), openedAt: t0 });
    // A check read 3 reviews and saved first. The PR job's read, made before it, lands after it with 1.
    await setReviewsRead(db, [{ claimId: 'c_1', reviews: 3, leftOut: [0, 0, 2], readAt: t0 + 2 * HOUR }]);
    await setReviewsRead(db, [{ claimId: 'c_1', reviews: 1, leftOut: [0], readAt: t0 + HOUR }]);

    expect(await reviewsOf('c_1')).toEqual({ reviews: 3, reviews_read: 3, comments_left_out: 2 });

    await setReviewsRead(db, [{ claimId: 'c_1', reviews: 4, leftOut: [0], readAt: t0 + 3 * HOUR }]);

    expect(await reviewsOf('c_1')).toEqual({ reviews: 4, reviews_read: 4, comments_left_out: 2 });
  });
});

describe("a donor's open PRs", () => {
  test("lists the donor's open PRs, oldest first, with the reviews counted at the last read, and no merged one", async () => {
    await addPr(db, { claimId: 'c_2', pr: prRef(58), openedAt: t0 + HOUR });
    await addPr(db, { claimId: 'c_1', pr: prRef(57), openedAt: t0 });
    await setReviewsRead(db, [{ claimId: 'c_2', reviews: 2, leftOut: [0, 0], readAt: t0 + 2 * HOUR }]);
    await setPrState(db, 'c_1', 'merged', t0 + 3 * HOUR);

    expect(await listOpenPrsOf(db, priya.githubId)).toEqual([
      { claimId: 'c_2', issue: `${repo}#18`, pr: prRef(58), reviews: 2, conversation: 0, failedChecksHead: null, conflictHead: null },
    ]);
  });

  test('a blocked donor, and a PR the do-not-list names, list none, as every listing of their PRs leaves them out', async () => {
    await addPr(db, { claimId: 'c_1', pr: prRef(57), openedAt: t0 });
    await signIn(admin);
    await blockDonor(db, { githubId: priya.githubId, reason: null, blockedBy: admin.githubId }, t0);
    const whileBlocked = await listOpenPrsOf(db, priya.githubId);
    await unblockDonor(db, priya.githubId);
    await addToDoNotList(db, { repo, reason: 'Asked to be removed.', addedBy: admin.githubId }, t0);
    const whileListed = await listOpenPrsOf(db, priya.githubId);
    await takeOffDoNotList(repo);

    expect(whileBlocked).toEqual([]);
    expect(whileListed).toEqual([]);
    expect(await listOpenPrsOf(db, priya.githubId)).toHaveLength(1);
  });
});
