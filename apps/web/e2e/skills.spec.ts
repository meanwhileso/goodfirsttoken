import { LOCAL_API_URL } from '@goodfirsttoken/github-fake/local';
import { DONOR, DONOR_ISSUE, FIXTURE_REPO, runDonorSkills, runSkills } from '../scripts/skill-run';
import { expect, test } from './fixtures';
import { SITE } from './hosts';

// The steps of the maintain and admin skills, as `pnpm skills:run` takes
// them against pnpm dev, here against the preview: the sample maintainer's
// agent registers the GitHub fake's sample-owner/sample-parser with the
// settings the server proposed, and the sample admin's agent approves it
// from the admin queue. It reads the queue and lists a project, so it runs
// in the `skills` project, once the admin pages' tests are done. Then a
// sample donor's agent follows the give skill on the one sample issue no
// other test claims, sample-owner/sample-app#311, and gets its work to a PR
// on the GitHub fake.

test("a maintainer's agent registers a sample repo with the proposed settings, and an admin's agent approves it from the queue", async () => {
  const said: string[] = [];

  const run = await runSkills(SITE, (line) => said.push(line));

  expect(run).toMatchObject({ repo: FIXTURE_REPO, status: 'approved' });
  expect(said).toContain(
    `@sample-admin's agent calls admin_decide ${JSON.stringify({ id: run.queueId, decision: 'approve' })}`,
  );
});

test("a donor's agent follows the give skill from a session to a claim, updates, a submit, and a PR", async ({ request }) => {
  // The server asks for a wait of up to 10 seconds between two posts.
  test.setTimeout(90_000);
  expect((await request.post('/dev/seed')).status()).toBe(200);
  const said: string[] = [];

  const run = await runDonorSkills(SITE, (line) => said.push(line));

  expect(run).toMatchObject({ issue: DONOR_ISSUE, resumed: false });
  expect(run.waitedSeconds).toBeGreaterThan(0);
  expect(said.filter((line) => line.startsWith(`@${DONOR}'s agent calls post_update`))).toHaveLength(3);
  // The project opens agent PRs by itself, so the submit opened this one.
  expect(run.reviewReason).toBeNull();
  const pr = (await (await request.get(`${LOCAL_API_URL}/repos/sample-owner/sample-app/pulls/${String(run.pr.number)}`)).json()) as {
    state: string;
    user: { login: string };
    body: string;
    head: { ref: string };
  };
  expect(pr).toMatchObject({ state: 'open', user: { login: DONOR }, head: { ref: `goodfirsttoken/issue-311-${run.claimId}` } });
  expect(pr.body).toContain('Closes #311');
});
