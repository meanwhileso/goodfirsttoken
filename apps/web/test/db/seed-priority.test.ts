import { beforeEach, expect, test } from 'vitest';
import { verifyCrawlPriority } from '@goodfirsttoken/core';
import { addSeed, getSeed, listSeedsToHandle, markSeedsHandled, saveSeedEvidence, addToDoNotList } from '../../src/db';
import { admin, DAY, db, emptyDatabase, HOUR, maintainer, signIn, t0 } from './helpers';

const evidence = (changes = {}) => verifyCrawlPriority({
  stars: 10000, public: true, archived: false, pushedAt: new Date(t0).toISOString(), metadataCheckedAt: new Date(t0).toISOString(),
  maintainerGitHubLogin: 'sample-maintainer', role: 'maintainer', roleSourceUrl: 'https://github.com/sample-owner/sample-app/blob/main/MAINTAINERS.md',
  identitySourceUrl: 'https://github.com/sample-maintainer', xHandle: 'sample_person', postUrl: 'https://x.com/sample_person/status/123',
  publishedAt: new Date(t0).toISOString(), timePrecision: 'exact', postKind: 'authored', evidenceCheckedAt: new Date(t0).toISOString(), ...changes,
}, admin.githubId, t0);

beforeEach(async () => { await emptyDatabase(); await signIn(admin, maintainer); });

test('priority is applied before the limit, then oldest added time and repo name within each group', async () => {
  await addSeed(db, { repo: 'sample-owner/ordinary', addedBy: admin.githubId }, t0 - HOUR);
  await saveSeedEvidence(db, { repo: 'sample-owner/z-priority', addedBy: admin.githubId, evidence: evidence() }, t0);
  await saveSeedEvidence(db, { repo: 'sample-owner/a-priority', addedBy: admin.githubId, evidence: evidence() }, t0);
  await saveSeedEvidence(db, { repo: 'sample-owner/low-stars', addedBy: admin.githubId, evidence: evidence({ stars: 9999 }) }, t0 - 1);
  expect((await listSeedsToHandle(db, 1, null, t0)).map((seed) => seed.repo)).toEqual(['sample-owner/a-priority']);
  expect((await listSeedsToHandle(db, 4, null, t0)).map((seed) => seed.repo)).toEqual(['sample-owner/a-priority', 'sample-owner/z-priority', 'sample-owner/ordinary', 'sample-owner/low-stars']);
  expect((await listSeedsToHandle(db, 1, null, t0 + 30 * DAY + 1)).map((seed) => seed.repo)).toEqual(['sample-owner/ordinary']);
});

test('saving, expiring, and clearing evidence preserve seed handling history and do not requeue it in this pass', async () => {
  const { seed } = await addSeed(db, { repo: 'sample-owner/handled', addedBy: maintainer.githubId }, t0 - HOUR);
  await markSeedsHandled(db, [{ repo: seed.repo, outcome: 'queued' }], t0);
  await saveSeedEvidence(db, { repo: seed.repo, addedBy: admin.githubId, evidence: evidence() }, t0 + HOUR);
  expect(await getSeed(db, seed.repo)).toMatchObject({ ...seed, handledAt: t0, outcome: 'queued', evidence: evidence() });
  expect(await listSeedsToHandle(db, 10, t0, t0 + HOUR)).toEqual([]);
  const cleared = await saveSeedEvidence(db, { repo: seed.repo, addedBy: admin.githubId, evidence: null }, t0 + 31 * DAY);
  expect(cleared?.seed).toEqual({ ...seed, handledAt: t0, outcome: 'queued', evidence: null });
  expect(await listSeedsToHandle(db, 10, t0, t0 + 31 * DAY)).toEqual([]);
  expect(await listSeedsToHandle(db, 10, t0 + 1, t0 + 31 * DAY)).toEqual([cleared?.seed]);
});

test('evidence for a waiting candidate creates a handled proposed seed, and later updates preserve it', async () => {
  const first = await saveSeedEvidence(db, { repo: 'sample-owner/proposed', addedBy: admin.githubId, evidence: evidence(), proposed: true }, t0);
  expect(first).toMatchObject({ added: true, evidenceChanged: true, seed: { handledAt: t0, outcome: 'proposed' } });
  const next = await saveSeedEvidence(db, { repo: 'sample-owner/proposed', addedBy: maintainer.githubId, evidence: null, proposed: true }, t0 + HOUR);
  expect(next).toMatchObject({ added: false, evidenceChanged: true, seed: { addedBy: admin.githubId, addedAt: t0, handledAt: t0, outcome: 'proposed', evidence: null } });
  expect(await listSeedsToHandle(db, 10, t0, t0 + HOUR)).toEqual([]);
});

test('the evidence write itself refuses a do-not-list repo without altering its ordinary seed', async () => {
  const original = await addSeed(db, { repo: 'sample-owner/removed', addedBy: admin.githubId }, t0);
  await addToDoNotList(db, { repo: original.seed.repo, addedBy: admin.githubId, reason: null }, t0);
  expect(await saveSeedEvidence(db, { repo: original.seed.repo, addedBy: admin.githubId, evidence: evidence() }, t0)).toBeNull();
  expect(await getSeed(db, original.seed.repo)).toEqual(original.seed);
});
