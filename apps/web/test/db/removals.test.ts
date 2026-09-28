import { beforeEach, describe, expect, test } from 'vitest';
import { askRemoval, closeRemoval, getWaitingRemoval, listWaitingRemovals } from '../../src/db';
import { admin, coMaintainer, DAY, db, emptyDatabase, HOUR, maintainer, refusal, repo, signIn, t0 } from './helpers';

// The removal_requests table: maintainers' requests to have a repo removed.
// Every person, repo, and reason here is made up.

const reason = 'We review every pull request by hand now.';

beforeEach(async () => {
  await emptyDatabase();
  await signIn(admin, maintainer, coMaintainer);
});

describe('requests to be removed', () => {
  test('a request waits with the reason, who asked, and when', async () => {
    const { request, created } = await askRemoval(db, { repo, reason, requestedBy: maintainer.githubId }, t0);

    expect(created).toBe(true);
    expect(request).toMatchObject({
      repo,
      reason,
      requestedBy: maintainer.githubId,
      requestedAt: t0,
      status: 'waiting',
      closedBy: null,
      closedAt: null,
    });
    expect(request.id).toMatch(/^rem_[A-Za-z0-9_-]{20}$/);
    expect(await getWaitingRemoval(db, 'SAMPLE-OWNER/Sample-App')).toEqual(request);
    expect(await listWaitingRemovals(db)).toEqual([request]);
  });

  test('a repo has one request waiting, whatever the case of its name, and a second keeps the first', async () => {
    const first = await askRemoval(db, { repo, reason, requestedBy: maintainer.githubId }, t0);

    const second = await askRemoval(
      db,
      { repo: 'Sample-Owner/Sample-App', reason: 'Take it off, please.', requestedBy: coMaintainer.githubId },
      t0 + HOUR,
    );

    expect(second).toEqual({ request: first.request, created: false });
    expect(await listWaitingRemovals(db)).toEqual([first.request]);
  });

  test('closing a request keeps it, with the admin who removed the repo and when, and the repo can be asked for again', async () => {
    const { request } = await askRemoval(db, { repo, reason, requestedBy: maintainer.githubId }, t0);

    const closed = await closeRemoval(db, 'Sample-Owner/Sample-App', admin.githubId, t0 + DAY);
    const again = await askRemoval(db, { repo, reason: 'Still no.', requestedBy: coMaintainer.githubId }, t0 + 30 * DAY);

    expect(closed).toEqual({ ...request, status: 'removed', closedBy: admin.githubId, closedAt: t0 + DAY });
    expect(again).toMatchObject({ created: true, request: { status: 'waiting', requestedBy: coMaintainer.githubId } });
    expect(again.request.id).not.toBe(request.id);
    expect(await listWaitingRemovals(db)).toEqual([again.request]);
  });

  test('closing a repo with no request waiting closes nothing', async () => {
    expect(await closeRemoval(db, repo, admin.githubId, t0)).toBeNull();
  });

  test('the queue lists waiting requests oldest first', async () => {
    const later = await askRemoval(db, { repo: 'sample-owner/sample-tools', reason, requestedBy: maintainer.githubId }, t0 + HOUR);
    const earlier = await askRemoval(db, { repo, reason, requestedBy: maintainer.githubId }, t0);

    expect(await listWaitingRemovals(db)).toEqual([earlier.request, later.request]);
  });

  test('a request needs a reason, and names someone who signed in', async () => {
    const noReason = await refusal(askRemoval(db, { repo, reason: '  ', requestedBy: maintainer.githubId }, t0));
    const nobody = await refusal(askRemoval(db, { repo, reason, requestedBy: 4242 }, t0));

    expect(noReason).toContain('reason: must not be empty');
    expect(nobody).toMatch(/FOREIGN KEY/);
    expect(await listWaitingRemovals(db)).toEqual([]);
  });
});
