import { beforeEach, describe, expect, test } from 'vitest';
import { blockDonor, blockedAmong, getBlock, listBlocks, unblockDonor } from '../../src/db';
import { admin, db, emptyDatabase, HOUR, kenji, priya, signIn, t0 } from './helpers';

const secondAdmin = { githubId: 9002, login: 'sample-admin-two' };

beforeEach(async () => {
  await emptyDatabase();
  await signIn(priya, kenji, admin, secondAdmin);
});

describe('donor blocks', () => {
  test('a blocked donor stays blocked until an admin lifts it', async () => {
    const block = await blockDonor(
      db,
      { githubId: priya.githubId, reason: 'Opened 40 PRs in an hour.', blockedBy: admin.githubId },
      t0,
    );

    expect(block).toEqual({
      githubId: priya.githubId,
      reason: 'Opened 40 PRs in an hour.',
      blockedBy: admin.githubId,
      blockedAt: t0,
    });
    expect(await getBlock(db, priya.githubId)).toEqual(block);
    expect(await getBlock(db, kenji.githubId)).toBeNull();

    expect(await unblockDonor(db, priya.githubId)).toBe(true);
    expect(await getBlock(db, priya.githubId)).toBeNull();
    expect(await unblockDonor(db, priya.githubId)).toBe(false);
  });

  test('blocking a blocked donor again records the new reason, admin, and time', async () => {
    await blockDonor(db, { githubId: priya.githubId, reason: null, blockedBy: admin.githubId }, t0);

    await blockDonor(db, { githubId: priya.githubId, reason: 'Still spamming.', blockedBy: secondAdmin.githubId }, t0 + HOUR);

    expect(await getBlock(db, priya.githubId)).toEqual({
      githubId: priya.githubId,
      reason: 'Still spamming.',
      blockedBy: secondAdmin.githubId,
      blockedAt: t0 + HOUR,
    });
  });

  test('a feed finds which of its donors are blocked, however many it asks about', async () => {
    await blockDonor(db, { githubId: priya.githubId, reason: null, blockedBy: admin.githubId }, t0);
    // More IDs than D1 binds in one statement.
    const asked = [kenji.githubId, priya.githubId, ...Array.from({ length: 150 }, (_, i) => 50_000 + i)];

    expect(await blockedAmong(db, asked)).toEqual(new Set([priya.githubId]));
    expect(await blockedAmong(db, [kenji.githubId])).toEqual(new Set());
    expect(await blockedAmong(db, [])).toEqual(new Set());
  });

  test('blocked donors are listed most recently blocked first, each with their login', async () => {
    await blockDonor(db, { githubId: priya.githubId, reason: null, blockedBy: admin.githubId }, t0);
    await blockDonor(db, { githubId: kenji.githubId, reason: 'Spam.', blockedBy: admin.githubId }, t0 + HOUR);

    expect(await listBlocks(db)).toEqual([
      { githubId: kenji.githubId, login: kenji.login, reason: 'Spam.', blockedBy: admin.githubId, blockedAt: t0 + HOUR },
      { githubId: priya.githubId, login: priya.login, reason: null, blockedBy: admin.githubId, blockedAt: t0 },
    ]);
  });
});
