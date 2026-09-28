import { beforeEach, describe, expect, test } from 'vitest';
import { confirmCla, getClaConfirmation } from '../../src/db';
import { db, emptyDatabase, kenji, priya, repo, signIn, t0 } from './helpers';

// Each donor's confirmation that they signed a project's CLA. The projects
// and links are made up.

beforeEach(async () => {
  await emptyDatabase();
  await signIn(priya, kenji);
});

describe('CLA confirmations', () => {
  test("a confirmation is kept for the donor and the project, with the link they confirmed, and the project compares without case", async () => {
    await confirmCla(db, { githubId: priya.githubId, project: repo, claUrl: 'https://sample-owner.test/cla' }, t0);

    expect(await getClaConfirmation(db, priya.githubId, repo.toUpperCase())).toEqual({
      githubId: priya.githubId,
      project: repo,
      claUrl: 'https://sample-owner.test/cla',
      confirmedAt: t0,
    });
    expect(await getClaConfirmation(db, kenji.githubId, repo)).toBeNull();
    expect(await getClaConfirmation(db, priya.githubId, 'sample-owner/sample-tools')).toBeNull();
  });

  test('confirming a new link replaces the old one, so the donor has one confirmation per project', async () => {
    await confirmCla(db, { githubId: priya.githubId, project: repo, claUrl: 'https://sample-owner.test/cla' }, t0);
    await confirmCla(db, { githubId: priya.githubId, project: repo, claUrl: 'https://sample-owner.test/cla-v2' }, t0 + 1);

    expect(await getClaConfirmation(db, priya.githubId, repo)).toMatchObject({
      claUrl: 'https://sample-owner.test/cla-v2',
      confirmedAt: t0 + 1,
    });
  });

  test('a CLA link must be https', async () => {
    await expect(
      confirmCla(db, { githubId: priya.githubId, project: repo, claUrl: 'http://sample-owner.test/cla' }, t0),
    ).rejects.toThrow('claUrl: must be an https link');
    expect(await getClaConfirmation(db, priya.githubId, repo)).toBeNull();
  });
});
