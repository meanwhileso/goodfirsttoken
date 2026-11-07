import { projectSettingsSchema, validate, type CrawlCandidate, type ModelReading } from '@goodfirsttoken/core';
import { approveFind, type Lister } from '../admin/actions';
import { adminGithubIds } from '../auth/settings';
import { getModelReadingOf, getPerson, getProject, listCandidates } from '../db';
import { GitHubError } from '../github';

// Approving a crawler find on its own (docs/how-it-works.md, under The
// policy crawler): a waiting find whose repo had more than 100 stars when the
// crawler read it is listed from its policy, as an admin's approval lists it,
// with the settings the crawler suggested, and named for an admin. It runs on
// the crawler's hourly cron, after the model policy reader's run, so a find
// written in that run is approved in the same hour, and so is a find that
// waited from before. The conditions are the ones
// docs/specs/model-policy-reader.md sets for listing a requested repo at
// once, under Requested repos, but for the check reading.

/** A find whose repo has more stars than this is approved on its own. */
export const AUTO_APPROVE_STARS = 100;
/** The most finds one run checks on GitHub, each a read or two with the service token. */
export const AUTO_APPROVE_PER_RUN = 50;
/** The reason an approval on its own records on the find, which tells it from an admin's. */
export const AUTO_APPROVED_REASON = `Approved on its own, for more than ${String(AUTO_APPROVE_STARS)} stars.`;
/** The most finds left for an admin that the run's log line names. */
const LEFT_IN_LOG = 20;

export interface AutoApproveDeps {
  db: D1Database;
  /** The read-only service token, which checks each repo on GitHub. */
  token: string;
  now: () => number;
}

/** What one run did, for its log line. */
export interface AutoApproveRun {
  /** The admin the approvals are named for, or null when no find had the stars. */
  approver: number | null;
  approved: string[];
  /** The finds with enough stars that keep waiting for an admin, and why. */
  left: { repo: string; why: string }[];
}

/**
 * The admin an approval on its own is named for: the first in
 * ADMIN_GITHUB_IDS who has signed in, since a listing names a person who
 * added it. Null when none has.
 */
async function approver(db: D1Database): Promise<number | null> {
  for (const id of adminGithubIds()) {
    if ((await getPerson(db, id)) !== null) return id;
  }
  return null;
}

/** Why the model's reading leaves a find for an admin, or null when it doesn't. */
function whyNotFromReading(reading: ModelReading | null): string | null {
  if (reading === null) return 'no model reading of the docs it was found in';
  if (!reading.agree) return 'the two tiers it read disagree';
  if (reading.dropped > 0) return 'a statement it read failed its check against the files';
  if (reading.steering.length > 0) return 'its docs have lines that try to steer a reader';
  if (reading.statements.some((s) => s.about === 'canary' || s.about === 'noAutonomy')) {
    return 'its docs have a canary or keep agents from working on their own';
  }
  return null;
}

/** Why a find is left for an admin before GitHub is asked, or null when it is checked there. */
async function whyLeft(db: D1Database, find: CrawlCandidate): Promise<string | null> {
  const fromReading = whyNotFromReading(await getModelReadingOf(db, find.repo, find.docsHash));
  if (fromReading !== null) return fromReading;
  if (!validate(projectSettingsSchema, find.settings, 'settings').ok) return 'it has no tags';
  // An admin listed it by hand, or its maintainers registered it. A find doesn't change their listing.
  if ((await getProject(db, find.repo)) !== null) return 'it is a project already';
  return null;
}

/** Whether a GitHub failure is the token's, not one repo's, so the run stops. */
function stopsTheRun(error: unknown): boolean {
  return !(error instanceof GitHubError) || error.status === 401 || error.rateLimited || error.status >= 500;
}

/**
 * Approves the waiting finds with more than 100 stars, oldest first,
 * checking at most 50 a run on GitHub. A find keeps waiting for an admin
 * when the model's reading of the docs it was found in isn't kept, its two
 * tiers disagree, a statement failed its check, or it has steering lines, a
 * canary, or a line that keeps agents from working on their own. So does a
 * find with no tags, one for a repo that is a project already, and one the
 * approval refuses, as for a repo GitHub now shows archived. Returns null
 * when no admin has signed in, so there is no one to name.
 */
export async function approveStarredFinds(deps: AutoApproveDeps): Promise<AutoApproveRun | null> {
  const { db, token } = deps;
  const starred = (await listCandidates(db, 'waiting')).filter((find) => find.facts.stars > AUTO_APPROVE_STARS);
  if (starred.length === 0) return { approver: null, approved: [], left: [] };
  const id = await approver(db);
  if (id === null) {
    console.warn(
      `No find was approved on its own. No admin in ADMIN_GITHUB_IDS has signed in to Good First Token, and a listing names the admin who added it. Finds waiting with more than ${String(AUTO_APPROVE_STARS)} stars: ${String(starred.length)}.`,
    );
    return null;
  }
  const lister: Lister = { githubId: id, gitHubToken: () => Promise.resolve(token) };
  const run: AutoApproveRun = { approver: id, approved: [], left: [] };
  let tried = 0;
  for (const find of starred) {
    const why = await whyLeft(db, find);
    if (why !== null) {
      run.left.push({ repo: find.repo, why });
      continue;
    }
    if (tried === AUTO_APPROVE_PER_RUN) break;
    tried += 1;
    try {
      const outcome = await approveFind(lister, find, {}, deps.now(), { reason: AUTO_APPROVED_REASON, readNow: false });
      if (outcome.ok) run.approved.push(outcome.value.repo);
      else run.left.push({ repo: find.repo, why: outcome.refusal.message });
    } catch (error) {
      if (stopsTheRun(error)) {
        console.error(`Approving ${find.repo}'s find on its own failed, and the run stopped. The next hourly run tries again.`, error);
        break;
      }
      run.left.push({ repo: find.repo, why: `GitHub answered ${String((error as GitHubError).status)}` });
    }
  }
  const list = (repos: string[]) => (repos.length === 0 ? 'none' : repos.join(', '));
  const named = run.left.slice(0, LEFT_IN_LOG).map((left) => `${left.repo} (${left.why})`);
  const more = run.left.length > LEFT_IN_LOG ? `, and ${String(run.left.length - LEFT_IN_LOG)} more` : '';
  console.log(
    `Finds approved on their own, for more than ${String(AUTO_APPROVE_STARS)} stars: ${list(run.approved)}. Named for the admin ${String(id)}. Left for an admin: ${named.length === 0 ? 'none' : named.join('; ')}${more}.`,
  );
  return run;
}
