import {
  HELD_CHECK_AGAIN_MS,
  projectSettingsSchema,
  validate,
  type CrawlCandidate,
  type CrawlMessage,
  type ModelReading,
  type PolicyChange,
} from '@goodfirsttoken/core';
import { applyPolicyChange, approveFind, type Lister, type Outcome } from '../admin/actions';
import { adminGithubIds } from '../auth/settings';
import {
  dropHeldCandidate,
  getModelReadingOf,
  getPerson,
  getProject,
  holdCandidate,
  holdPolicyChange,
  listCandidates,
  listHeldCandidates,
  listPolicyChanges,
  markSeedsHandled,
  releaseHeldPolicyChanges,
} from '../db';
import { GitHubError } from '../github';
import { readerStatus } from './model';
import { sendRepos } from './producer';

// Deciding crawler finds and policy changes on their own
// (docs/specs/held-items.md, and docs/how-it-works.md, under The policy
// crawler). It runs on the crawler's hourly cron, after the model policy
// reader's run. Each find and policy change that waits and isn't held is
// checked, oldest first. One that passes every check is listed, or applied,
// as an admin's approval does, named for an admin. One that fails is held
// out of the admin queue with its reason. 30 days after it was held, a find
// is dropped and its repo read again, and a policy change is checked again.

/** A find or a policy change whose repo has this many stars or fewer is held. */
export const AUTO_APPROVE_STARS = 100;
/** The most finds and policy changes one run checks on GitHub together, each a read or two with the service token. */
export const AUTO_APPROVE_PER_RUN = 50;
/** How long a find or a policy change is held before the crawler checks it again. */
export const CHECK_AGAIN_MS = HELD_CHECK_AGAIN_MS;
/** The most held finds one run sends back to the crawler to read again. */
export const CHECK_AGAIN_PER_RUN = 50;
/** The reason an approval on its own records on a find, which tells it from an admin's. */
export const AUTO_APPROVED_REASON = `Approved on its own, for more than ${String(AUTO_APPROVE_STARS)} stars.`;
/** The reason an approval on its own records on a policy change. */
export const AUTO_APPLIED_REASON = `Applied on its own, for more than ${String(AUTO_APPROVE_STARS)} stars.`;
/** The most held items that the run's log line names. */
const HELD_IN_LOG = 20;

export interface AutoApproveDeps {
  db: D1Database;
  /** The read-only service token, which checks each repo on GitHub. */
  token: string;
  /** The crawl queue, which reads a held find's repo again. */
  queue: { sendBatch: (messages: Iterable<MessageSendRequest<CrawlMessage>>) => Promise<unknown> };
  now: () => number;
}

/** What one run did, for its log line. */
export interface AutoApproveRun {
  /** The admin the approvals are named for, or null when nothing waited. */
  approver: number | null;
  /** The repos whose finds were listed. */
  approved: string[];
  /** The projects whose policy changes were applied. */
  applied: string[];
  /** The finds and policy changes held this run, and why. */
  held: { repo: string; kind: 'candidate' | 'policy_change'; why: string }[];
  /** The repos whose held finds were dropped and sent back to the crawler. */
  readAgain: string[];
  /** How many held policy changes stopped being held, to be checked again. */
  released: number;
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

/** Why the model's reading holds a find or a policy change, or null when it doesn't. */
function whyNotFromReading(reading: ModelReading | null): string | null {
  if (reading === null) return 'no model reading of the docs it was read from';
  if (!reading.agree) return 'the two tiers it read disagree';
  if (reading.dropped > 0) return 'a statement it read failed its check against the files';
  if (reading.steering.length > 0) return 'its docs have lines that try to steer a reader';
  if (reading.statements.some((s) => s.about === 'canary' || s.about === 'noAutonomy')) {
    return 'its docs have a canary or keep agents from working on their own';
  }
  return null;
}

const tooFewStars = `it has ${String(AUTO_APPROVE_STARS)} stars or fewer`;

/** Why a find is held before GitHub is asked, or null when it is checked there. */
async function whyHoldFind(db: D1Database, find: CrawlCandidate): Promise<string | null> {
  if (find.facts.stars <= AUTO_APPROVE_STARS) return tooFewStars;
  const fromReading = whyNotFromReading(await getModelReadingOf(db, find.repo, find.docsHash));
  if (fromReading !== null) return fromReading;
  if (!validate(projectSettingsSchema, find.settings, 'settings').ok) return 'it has no tags';
  // An admin listed it by hand, or its maintainers registered it. A find doesn't change their listing.
  if ((await getProject(db, find.repo)) !== null) return 'it is a project already';
  return null;
}

/** Why a policy change is held before GitHub is asked, or null when it is checked there. */
async function whyHoldChange(db: D1Database, change: PolicyChange): Promise<string | null> {
  if (change.why === 'no_verdict') return 'the reader gave no verdict on its docs';
  if (change.policy === null) return 'its docs give no policy to list it from';
  if (change.madeBy !== 'model') return "the crawler's rules sent it, before the model read policies";
  const fromReading = whyNotFromReading(await getModelReadingOf(db, change.repo, change.docsHash));
  if (fromReading !== null) return fromReading;
  if (change.facts.stars <= AUTO_APPROVE_STARS) return tooFewStars;
  return null;
}

/** Whether a GitHub failure is the token's, not one repo's, so the run stops. */
function stopsTheRun(error: unknown): boolean {
  return !(error instanceof GitHubError) || error.status === 401 || error.rateLimited || error.status >= 500;
}

/**
 * Drops the finds held 30 days or more, at most CHECK_AGAIN_PER_RUN, and
 * sends their repos to the crawl queue, so the crawler reads each again and
 * makes a new find. A find an admin decided in the meantime stays as they
 * decided it. Then stops holding the policy changes held 30 days or more,
 * so this run checks them again.
 */
async function checkAgain(deps: AutoApproveDeps, run: AutoApproveRun): Promise<void> {
  const heldBy = deps.now() - CHECK_AGAIN_MS;
  // Without the model, the crawler makes no find, so a find dropped now would be lost.
  if ((await readerStatus(deps.db, deps.now())).reads) {
    for (const find of await listHeldCandidates(deps.db, heldBy, CHECK_AGAIN_PER_RUN)) {
      if (await dropHeldCandidate(deps.db, find.id)) run.readAgain.push(find.repo);
    }
    await sendRepos(deps, run.readAgain, false);
    // A seed's own monthly read would read the repo again in the next hour. This read counts as it.
    await markSeedsHandled(deps.db, run.readAgain.map((repo) => ({ repo, outcome: 'queued' as const })), deps.now());
  }
  run.released = await releaseHeldPolicyChanges(deps.db, heldBy);
}

/**
 * Lists the finds, and applies the policy changes, that wait, aren't held,
 * and pass every check, oldest first, checking at most 50 a run on GitHub
 * together. The rest are held out of the admin queue with their reasons:
 *
 * - A find is held when its repo has 100 stars or fewer, the model's
 *   reading of the docs it was found in isn't kept, its two tiers disagree,
 *   a statement failed its check, or the docs have steering lines, a
 *   canary, or a line that keeps agents from working on their own. So is a
 *   find with no tags, one for a repo that is a project already, and one
 *   the listing refuses, as for a repo GitHub now shows archived.
 * - A policy change is held when it was sent for docs with no verdict, its
 *   docs give no policy,
 *   the crawler's rules sent it, its reading fails the same checks, its
 *   repo has 100 stars or fewer, or the listing refuses it. One sent for a
 *   ban a second reading didn't confirm stays in the admin queue, since the
 *   listing may now ban AI help.
 *
 * A GitHub failure that is the token's, a rate limit, or GitHub's own error
 * holds nothing, and the run asks GitHub nothing more, for the next hour to
 * try again. First it
 * checks again what was held 30 days or more. Returns null when no admin
 * has signed in, so there is no one to name, and nothing is held.
 */
export async function approveStarredFinds(deps: AutoApproveDeps): Promise<AutoApproveRun | null> {
  const { db, token } = deps;
  const run: AutoApproveRun = { approver: null, approved: [], applied: [], held: [], readAgain: [], released: 0 };
  const waiting = async () => {
    const [finds, changes] = await Promise.all([listCandidates(db, 'waiting'), listPolicyChanges(db, 'waiting')]);
    return { finds: finds.filter((find) => find.held === null), changes: changes.filter((change) => change.held === null) };
  };
  const anyHeld = async () =>
    (await listHeldCandidates(db, deps.now(), 1)).length > 0 ||
    (await listPolicyChanges(db, 'waiting')).some((change) => change.held !== null);
  let { finds, changes } = await waiting();
  if (finds.length === 0 && changes.length === 0 && !(await anyHeld())) return run;
  const id = await approver(db);
  if (id === null) {
    console.warn(
      `No find or policy change was checked on its own. No admin in ADMIN_GITHUB_IDS has signed in to Good First Token, and a listing names the admin who added it. Finds waiting: ${String(finds.length)}, policy changes waiting: ${String(changes.length)}.`,
    );
    return null;
  }
  run.approver = id;
  await checkAgain(deps, run);
  if (run.released > 0) ({ finds, changes } = await waiting());
  const lister: Lister = { githubId: id, gitHubToken: () => Promise.resolve(token) };

  type Item =
    | { kind: 'candidate'; at: number; find: CrawlCandidate }
    | { kind: 'policy_change'; at: number; change: PolicyChange };
  const items: Item[] = [
    ...finds.map((find) => ({ kind: 'candidate' as const, at: find.foundAt, find })),
    ...changes.map((change) => ({ kind: 'policy_change' as const, at: change.foundAt, change })),
  ].sort((a, b) => a.at - b.at);

  const hold = async (item: Item, why: string) => {
    const now = deps.now();
    const held = item.kind === 'candidate' ? await holdCandidate(db, item.find.id, why, now) : await holdPolicyChange(db, item.change.id, why, now);
    if (held) run.held.push({ repo: item.kind === 'candidate' ? item.find.repo : item.change.repo, kind: item.kind, why });
  };

  let tried = 0;
  let stopped = false;
  for (const item of items) {
    // A change sent for a ban a second reading didn't confirm waits for an admin, since the listing may now ban AI help.
    if (item.kind === 'policy_change' && item.change.why === 'ban_unconfirmed') continue;
    const why = item.kind === 'candidate' ? await whyHoldFind(db, item.find) : await whyHoldChange(db, item.change);
    if (why !== null) {
      await hold(item, why);
      continue;
    }
    // The rest wait for the next run, but the run still holds what fails before GitHub is asked.
    if (tried === AUTO_APPROVE_PER_RUN || stopped) continue;
    tried += 1;
    const repo = item.kind === 'candidate' ? item.find.repo : item.change.repo;
    try {
      let outcome: Outcome<'admin_decide'>;
      if (item.kind === 'candidate') {
        outcome = await approveFind(lister, item.find, {}, deps.now(), { reason: AUTO_APPROVED_REASON, readNow: false });
      } else {
        const policy = item.change.policy;
        if (policy === null) throw new Error(`${repo}'s policy change has no policy, and was checked anyway.`);
        outcome = await applyPolicyChange(lister, { ...item.change, policy }, {}, deps.now(), { reason: AUTO_APPLIED_REASON, readNow: false });
      }
      if (outcome.ok) (item.kind === 'candidate' ? run.approved : run.applied).push(outcome.value.repo);
      // One an admin decided, or a weekly read replaced, while GitHub was read no longer waits, so it isn't held.
      else await hold(item, outcome.refusal.message);
    } catch (error) {
      if (stopsTheRun(error)) {
        console.error(`Checking ${repo} on its own failed, and the run asks GitHub nothing more. The next hourly run tries again.`, error);
        stopped = true;
        continue;
      }
      await hold(item, `GitHub answered ${String((error as GitHubError).status)}`);
    }
  }
  const list = (repos: string[]) => (repos.length === 0 ? 'none' : repos.join(', '));
  const named = run.held.slice(0, HELD_IN_LOG).map((held) => `${held.repo} (${held.kind === 'policy_change' ? 'policy change, ' : ''}${held.why})`);
  const more = run.held.length > HELD_IN_LOG ? `, and ${String(run.held.length - HELD_IN_LOG)} more` : '';
  console.log(
    `Checked on their own, named for the admin ${String(id)}. Finds approved: ${list(run.approved)}. Policy changes applied: ${list(run.applied)}. Held out of the admin queue: ${named.length === 0 ? 'none' : named.join('; ')}${more}. Held finds sent back to the crawler to read again: ${list(run.readAgain)}. Held policy changes checked again: ${String(run.released)}.`,
  );
  return run;
}
