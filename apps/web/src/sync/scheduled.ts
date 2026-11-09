import { authSecret, oauthApp, SignInNotSetUp } from '../auth/settings';
import { approveStarredFinds } from '../crawl/auto-approve';
import { runReader } from '../crawl/batches';
import { fillCrawlQueue } from '../crawl/producer';
import { endEveryLapsedConnection } from '../mcp/connections';
import { ALLOWANCES, serviceToken } from './allowances';
import { ServiceGitHub } from './github';
import { syncTaggedIssues } from './issues';
import { recordClearedPrs } from './cleared';
import { followPrs } from './prs';
import { callTriggersAfterPass } from './triggers';

// The jobs that read GitHub with the read-only service token on the
// Worker's cron triggers. What each may spend is in src/sync/allowances.ts,
// and the reads of one project outside the schedule, a maintainer's refresh
// and the read an admin's approval starts, are in src/sync/read-now.ts.
// One more cron, once a day, ends the connections whose grants ran out, and
// revokes their tokens as the OAuth app, with no service token. Each cron in
// apps/web/wrangler.jsonc names one job here.

/** Every 15 minutes: the tagged-issue sync (src/sync/issues.ts). */
export const ISSUE_SYNC_CRON = '*/15 * * * *';
/**
 * Twice an hour, apart from the sync: the PR job (src/sync/prs.ts), then
 * the calls to the donors' triggers for the follow-ups it read
 * (src/sync/triggers.ts), then the job that records cleared PRs nobody
 * recorded (src/sync/cleared.ts).
 */
export const PR_JOB_CRON = '7,37 * * * *';
/**
 * Once an hour, apart from both: the policy crawler's cron job
 * (src/crawl/producer.ts), which queues its seeds and weekly reads, then the
 * model policy reader's run (src/crawl/batches.ts), which collects and sends
 * its batches, then the approval of the waiting finds with more than 100
 * stars (src/crawl/auto-approve.ts).
 */
export const CRAWL_CRON = '52 * * * *';
/** Once a day, apart from the others: ending lapsed connections (src/mcp/connections.ts). */
export const LAPSED_CONNECTIONS_CRON = '23 4 * * *';

/**
 * How many lapsed connections one daily run ends, at most. Each is one call
 * to GitHub to revoke its token, as the OAuth app, never with the service
 * token, and about ten calls to D1 and KV. docs/architecture.md, under The
 * sync, says why this number.
 */
export const LAPSED_PER_RUN = 200;

// The origin the libraries are made for when ending a connection with no
// request. Ending one makes no URL, so any does, and this is the site's own
// when it has a primary domain.
function jobOrigin(env: Env): string {
  const primary = env.PRIMARY_DOMAIN.trim().toLowerCase();
  return primary ? `https://${primary}` : 'https://scheduled.invalid';
}

/**
 * Ends every lapsed connection, up to the day's cap. With a setting sign-in
 * needs missing, no token can be read or revoked, so it tries none.
 */
async function endLapsed(env: Env): Promise<void> {
  try {
    oauthApp();
    authSecret();
  } catch (problem) {
    if (!(problem instanceof SignInNotSetUp)) throw problem;
    console.error(`No lapsed connection was ended. Sign-in is not set up: ${problem.message}`);
    return;
  }
  const ended = await endEveryLapsedConnection(jobOrigin(env), Date.now(), LAPSED_PER_RUN);
  if (ended > 0) console.log(`Ended ${String(ended)} connections whose grants ran out.`);
}

/** Runs the job for a cron trigger. */
export async function runScheduled(cron: string, env: Env): Promise<void> {
  if (cron === LAPSED_CONNECTIONS_CRON) {
    await endLapsed(env);
    return;
  }
  const token = serviceToken(env);
  if (token === null) {
    console.error(`No job ran on the cron ${cron}. The GH_SERVICE_TOKEN secret is not set. docs/self-hosting.md lists the Worker's secrets.`);
    return;
  }
  const now = () => Date.now();
  switch (cron) {
    case ISSUE_SYNC_CRON:
      await syncTaggedIssues({ db: env.DB, rooms: env.ISSUE_ROOM, github: new ServiceGitHub(token, ALLOWANCES.sync), now });
      return;
    case PR_JOB_CRON:
      await followPrs({ db: env.DB, rooms: env.ISSUE_ROOM, github: new ServiceGitHub(token, ALLOWANCES.prs), now });
      // Never throws, so a slow or broken trigger can't stop the job after it.
      await callTriggersAfterPass({ db: env.DB, fetch: (url, init) => fetch(url, init), now });
      await recordClearedPrs({ db: env.DB, github: new ServiceGitHub(token, ALLOWANCES.cleared), now });
      return;
    case CRAWL_CRON:
      try {
        await fillCrawlQueue({ db: env.DB, queue: env.CRAWL_QUEUE, now });
        await runReader({ db: env.DB, now });
      } finally {
        // A failure above still fails the cron, and the waiting finds are approved anyway.
        await approveStarredFinds({ db: env.DB, token, queue: env.CRAWL_QUEUE, now });
      }
      return;
    default:
      console.error(`No job runs on the cron ${cron}. Each cron trigger in wrangler.jsonc needs one in src/sync/scheduled.ts.`);
  }
}
