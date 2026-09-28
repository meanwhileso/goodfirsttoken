import { FIXTURE_REPO, runSkills } from '../scripts/skill-run';
import { expect, test } from './fixtures';
import { SITE } from './hosts';

// The steps of the maintain and admin skills, as `pnpm skills:run` takes
// them against pnpm dev, here against the preview: the sample maintainer's
// agent registers the GitHub fake's sample-owner/sample-parser with the
// settings the server proposed, and the sample admin's agent approves it
// from the admin queue. It reads the queue and lists a project, so it runs
// in the `skills` project, once the admin pages' tests are done.

test("a maintainer's agent registers a sample repo with the proposed settings, and an admin's agent approves it from the queue", async () => {
  const said: string[] = [];

  const run = await runSkills(SITE, (line) => said.push(line));

  expect(run).toMatchObject({ repo: FIXTURE_REPO, status: 'approved' });
  expect(said).toContain(
    `@sample-admin's agent calls admin_decide ${JSON.stringify({ id: run.queueId, decision: 'approve' })}`,
  );
});
