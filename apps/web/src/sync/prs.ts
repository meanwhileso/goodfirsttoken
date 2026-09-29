import {
  foldUntrusted,
  followUpRecordSchema,
  MAX_FOLLOW_UP_PATH,
  MAX_FOLLOW_UP_TEXT,
  type PrRecord,
  type PrState,
} from '@goodfirsttoken/core';
import {
  getClaim,
  listClosedPrsSince,
  listOpenPrs,
  listRereadsDue,
  rereadDone,
  rereadFailed,
  saveFollowUps,
  setPrState,
  setReviewsRead,
  type NewFollowUp,
  type ReviewsRead,
} from '../db';
import { GitHubError } from '../github';
import { issueRoom, type IssueRoom } from '../rooms/issue-room';
import { SyncStopped, type ServiceGitHub, type StopReason } from './github';
import { rereadIssue } from './issues';
import { reopenClaimPr } from './reopen';

// The PR job (spec section 7). It follows each PR opened for a claim until
// it merges or closes, reading GitHub with the read-only service token.
// While a PR is open, it keeps what reviewers wrote on it, for the donor's
// next session to bring back as follow-ups. When one has merged or closed,
// it tells the claim's issue room, which announces it and takes claims
// again once no PR is open on the issue, then records the outcome in the
// prs table. A PR closed without merging has its issue read again, by the
// sync's rules, so the issue takes claims again at once when it is still
// open and tagged, and for 14 days the job reads the PR's state too, so a
// PR that opens again, or merges, is followed again. The rules are in
// docs/how-it-works.md, under PRs.

export interface PrJobDeps {
  db: D1Database;
  rooms: DurableObjectNamespace<IssueRoom>;
  github: ServiceGitHub;
  now: () => number;
}

/** What one run did, for its log line. */
export interface PrRun {
  checked: number;
  /** PRs recorded closed without merging in the last 14 days whose state the run read. */
  closedChecked: number;
  /** Of those, the ones open again on GitHub, or merged since, recorded open again. */
  reopened: number;
  merged: number;
  closed: number;
  /** Reviews and review comments read for the first time. */
  followUps: number;
  /** Reviews by a person other than the PR's author that GitHub says can't push to the repo, which are no follow-ups. */
  withoutPush: number;
  /** Issues of PRs closed without merging that were read again, this run's and earlier runs'. */
  reread: number;
  calls: number;
  stopped: StopReason | null;
}

/** PRs one GraphQL query reads. */
const BATCH = 50;
/** How long after a PR closed without merging the job reads its state, for a reopen or a merge since. */
export const REOPEN_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** The newest reviews read on each PR. */
export const REVIEWS_READ = 10;
/** The comments read on each of those reviews. */
export const COMMENTS_READ = 10;

// https://docs.github.com/en/graphql/reference/pulls#object-pullrequest
// https://docs.github.com/en/graphql/reference/pulls#object-pullrequestreview
// https://docs.github.com/en/graphql/reference/pulls#object-pullrequestreviewcomment
interface Actor {
  __typename?: string;
  login?: string;
}

/** A comment on a line, in a review. Its author is the review's. */
interface ReviewComment {
  id: string;
  body: string;
  path: string;
  url: string;
  createdAt: string;
}

interface Review {
  id: string;
  authorCanPushToRepository?: boolean;
  state: string;
  body: string;
  url: string;
  submittedAt: string | null;
  author: Actor | null;
  comments: { totalCount?: number; nodes: (ReviewComment | null)[] | null } | null;
}

interface PullState {
  state: string;
  mergedAt: string | null;
  closedAt: string | null;
  author?: Actor | null;
  reviews?: { totalCount?: number; nodes: (Review | null)[] | null } | null;
}

type Pulls = Record<string, { pullRequest: PullState | null } | null>;

// A pending review is its author's alone, and a dismissed one no longer
// asks for anything, so the query leaves both out.
const PULL = `fragment Pull on PullRequest {
  state mergedAt closedAt
  author { __typename login }
  reviews(last: ${String(REVIEWS_READ)}, states: [COMMENTED, CHANGES_REQUESTED, APPROVED]) {
    totalCount
    nodes {
      id state body url submittedAt authorCanPushToRepository
      author { __typename login }
      comments(first: ${String(COMMENTS_READ)}) { totalCount nodes { id body path url createdAt } }
    }
  }
}`;

// A PR recorded closed needs its state alone, which asks for no
// connection, so it adds no points to the query.
const STATE = `fragment State on PullRequest { state mergedAt closedAt }`;

/** A PR the job reads: an open one in full, and one recorded closed for its state alone. */
interface Read {
  record: PrRecord;
  open: boolean;
}

async function readStates(github: ServiceGitHub, reads: readonly Read[]): Promise<Pulls> {
  const variables: Record<string, unknown> = {};
  const declared: string[] = [];
  const fields = reads.map(({ record, open }, i) => {
    const n = String(i);
    const [owner = '', name = ''] = record.pr.repo.split('/');
    variables[`o${n}`] = owner;
    variables[`r${n}`] = name;
    variables[`n${n}`] = record.pr.number;
    declared.push(`$o${n}: String!`, `$r${n}: String!`, `$n${n}: Int!`);
    return `p${n}: repository(owner: $o${n}, name: $r${n}) { pullRequest(number: $n${n}) { ...${open ? 'Pull' : 'State'} } }`;
  });
  // GitHub refuses a fragment the query doesn't use.
  const fragments = [reads.some((read) => read.open) && PULL, reads.some((read) => !read.open) && STATE].filter(Boolean);
  const { data, errors } = await github.query<Pulls>(`query (${declared.join(', ')}) { ${fields.join('\n')} }\n${fragments.join('\n')}`, variables);
  if (data === null) throw new SyncStopped('github_error', `GitHub answered no PR: ${errors[0]?.message ?? 'no data'}`);
  // A repo or PR GitHub no longer shows comes back null, with an error, and
  // is read again next time.
  return data;
}

/** When GitHub says the PR merged or closed, or now when it gives no time. */
function outcomeOf(pull: PullState, now: number): { state: PrState; at: number } | null {
  if (pull.state !== 'MERGED' && pull.state !== 'CLOSED') return null;
  const at = Date.parse((pull.state === 'MERGED' ? pull.mergedAt : pull.closedAt) ?? '');
  return { state: pull.state === 'MERGED' ? 'merged' : 'closed', at: Number.isNaN(at) ? now : at };
}

/**
 * The login of the person who wrote a review, when they are neither the
 * PR's author, who is the donor, nor a GitHub App's bot. Good First Token
 * posts on GitHub only as the donor, with the donor's token, so leaving out
 * the PR's author leaves out its posts too. Null for anyone else, and for an
 * account GitHub no longer has.
 */
function personOf(review: Review, prAuthor: string): string | null {
  const login = review.author?.login;
  if (typeof login !== 'string' || review.author?.__typename === 'Bot' || /\[bot\]$/i.test(login)) return null;
  return login.toLowerCase() === prAuthor.toLowerCase() ? null : login;
}

/**
 * The login of the maintainer who wrote a review: a person, by personOf,
 * whom GitHub says can push to the repo, by the review's
 * `authorCanPushToRepository`. GitHub's docs describe it as the author's
 * push access, with nothing about who reads it, where `authorAssociation`
 * hides a private member of the organization from a token outside it.
 * That isn't checked on GitHub, so the run counts the reviews it leaves out
 * for no push access, by withoutPushOf. The review's comments on lines are
 * its author's too.
 */
function reviewerOf(review: Review, prAuthor: string): string | null {
  const login = personOf(review, prAuthor);
  return login !== null && review.authorCanPushToRepository === true ? login : null;
}

/** How many of an open PR's reviews the read took are a person's, by personOf, whom GitHub says can't push to the repo. */
function withoutPushOf(pull: PullState): number {
  const prAuthor = pull.author?.login ?? '';
  return (pull.reviews?.nodes ?? []).filter(
    (review) => review !== null && personOf(review, prAuthor) !== null && review.authorCanPushToRepository !== true,
  ).length;
}

/**
 * What reviewers wrote on an open PR, as follow-ups: the text of each
 * review that comments or asks for changes, and each comment on a line, in
 * any review but a dismissed one. An approval's own text asks for nothing.
 * Each text, and each file's path, is folded to one line and cut. Empty
 * text, and anything GitHub gives in another form, is left out.
 */
function followUpsOf(pull: PullState): NewFollowUp[] {
  const prAuthor = pull.author?.login;
  if (typeof prAuthor !== 'string') return [];
  const found: NewFollowUp[] = [];
  const add = (followUp: NewFollowUp) => {
    const checked = followUpRecordSchema.omit({ claimId: true, readAt: true, shownAt: true, answeredAt: true }).safeParse({
      ...followUp,
      body: foldUntrusted(followUp.body, MAX_FOLLOW_UP_TEXT),
      path: followUp.path === null ? null : foldUntrusted(followUp.path, MAX_FOLLOW_UP_PATH),
    });
    if (checked.success) found.push(checked.data);
  };
  for (const review of pull.reviews?.nodes ?? []) {
    if (review === null || !['COMMENTED', 'CHANGES_REQUESTED', 'APPROVED'].includes(review.state)) continue;
    const reviewer = reviewerOf(review, prAuthor);
    if (reviewer === null) continue;
    if (review.state !== 'APPROVED') {
      add({
        commentId: review.id,
        reviewer,
        body: review.body,
        path: null,
        url: review.url,
        writtenAt: Date.parse(review.submittedAt ?? ''),
      });
    }
    for (const comment of review.comments?.nodes ?? []) {
      if (comment === null) continue;
      add({
        commentId: comment.id,
        reviewer,
        body: comment.body,
        path: comment.path,
        url: comment.url,
        writtenAt: Date.parse(comment.createdAt),
      });
    }
  }
  return found;
}

/**
 * What the read covered of an open PR's reviews: every review GitHub counts,
 * pending and dismissed ones left out, and for each review it took, newest
 * first, the comments on lines of a maintainer's review it left out.
 * setReviewsRead adds it to what earlier reads covered.
 */
function reviewsReadOf(pull: PullState): Omit<ReviewsRead, 'claimId'> {
  const read = (pull.reviews?.nodes ?? []).filter((review) => review !== null);
  const prAuthor = pull.author?.login ?? '';
  const leftOut = read
    .map((review) =>
      reviewerOf(review, prAuthor) === null ? 0 : Math.max(0, (review.comments?.totalCount ?? 0) - (review.comments?.nodes?.length ?? 0)),
    )
    .reverse();
  return { reviews: Math.max(pull.reviews?.totalCount ?? 0, read.length), leftOut };
}

/**
 * Tells the claim's issue room that its PR merged or closed without
 * merging, then records it in the prs table. False when the room didn't
 * hear, and the PR stays as the table had it, for the next run to try
 * again. A PR recorded closed without merging has its issue due to be read
 * again.
 */
async function recordEnd(deps: PrJobDeps, record: PrRecord, issue: string, outcome: { state: PrState; at: number }): Promise<boolean> {
  try {
    const told = await issueRoom(deps.rooms, issue).claimPrEnded({
      claimId: record.claimId,
      pr: record.pr,
      merged: outcome.state === 'merged',
    });
    if (!told.ok) return false;
  } catch (error) {
    console.warn(`The room for ${issue} didn't hear that its PR closed. The next run tries again.`, error);
    return false;
  }
  await setPrState(deps.db, record.claimId, outcome.state, outcome.at);
  return true;
}

/**
 * Reads every open PR in the prs table, oldest first, then the state of
 * each PR recorded closed without merging in the last 14 days, oldest close
 * first, in the same queries, until they are done or the run has to stop.
 * It first asks GitHub what is left of the budget. An open PR's new reviews
 * and review comments are kept as follow-ups. A PR whose room didn't hear
 * it merged or closed stays open in the table, so the next run tries again.
 * A closed one that GitHub shows open again is recorded open by
 * reopenClaimPr, and one merged since is recorded open, then merged. Then
 * the run reads again the issue of each PR that closed without merging and
 * waits for it, this run's and those an earlier run couldn't read. A
 * refusal from GitHub stops the run, which ends without an error.
 */
export async function followPrs(deps: PrJobDeps): Promise<PrRun> {
  const run: PrRun = {
    checked: 0,
    closedChecked: 0,
    reopened: 0,
    merged: 0,
    closed: 0,
    followUps: 0,
    withoutPush: 0,
    reread: 0,
    calls: 0,
    stopped: null,
  };
  const [open, closed, due] = await Promise.all([
    listOpenPrs(deps.db),
    listClosedPrsSince(deps.db, deps.now() - REOPEN_WINDOW_MS),
    listRereadsDue(deps.db),
  ]);
  const reads: Read[] = [...open.map((record) => ({ record, open: true })), ...closed.map((record) => ({ record, open: false }))];
  try {
    if (reads.length > 0 || due.length > 0) await deps.github.checkGitHub();
    for (let start = 0; start < reads.length; start += BATCH) {
      const batch = reads.slice(start, start + BATCH);
      const pulls = await readStates(deps.github, batch);
      const covered: ReviewsRead[] = [];
      for (const [i, { record, open: followed }] of batch.entries()) {
        const pull = pulls[`p${String(i)}`]?.pullRequest;
        if (pull == null) continue;
        const outcome = outcomeOf(pull, deps.now());
        if (!followed) {
          run.closedChecked += 1;
          if (outcome?.state === 'closed') continue;
          const claim = await getClaim(deps.db, record.claimId);
          if (claim === null || !(await reopenClaimPr(deps, { claimId: claim.id, issue: claim.issue, pr: record.pr }))) continue;
          run.reopened += 1;
          if (outcome?.state === 'merged' && (await recordEnd(deps, record, claim.issue, outcome))) run.merged += 1;
          continue;
        }
        run.checked += 1;
        if (outcome === null) {
          run.followUps += await saveFollowUps(deps.db, record.claimId, followUpsOf(pull), deps.now());
          run.withoutPush += withoutPushOf(pull);
          covered.push({ claimId: record.claimId, ...reviewsReadOf(pull) });
          continue;
        }
        const claim = await getClaim(deps.db, record.claimId);
        if (claim === null || !(await recordEnd(deps, record, claim.issue, outcome))) continue;
        if (outcome.state === 'merged') run.merged += 1;
        else run.closed += 1;
      }
      await setReviewsRead(deps.db, covered);
    }
    // A read that can't run now, as when another run holds the project,
    // stays due for the next run, behind the reads that never failed. One
    // the run stopped in stays where it is.
    for (const { claimId, issue } of await listRereadsDue(deps.db)) {
      if (!(await rereadIssue(deps, issue))) {
        await rereadFailed(deps.db, claimId, deps.now());
        continue;
      }
      await rereadDone(deps.db, claimId);
      run.reread += 1;
    }
  } catch (error) {
    if (error instanceof SyncStopped) {
      run.stopped = error.reason;
      console.warn(`The PR job stopped. ${error.message}`);
    } else if (error instanceof GitHubError) {
      run.stopped = 'github_error';
      console.warn(`The PR job stopped. GitHub answered ${String(error.status)}: ${error.message}`);
    } else {
      throw error;
    }
  }
  run.calls = deps.github.calls;
  console.log(
    `The PR job read open PRs: ${String(run.checked)} of ${String(open.length)}, PRs closed in the last 14 days: ${String(run.closedChecked)} of ${String(closed.length)}, open again: ${String(run.reopened)}, merged: ${String(run.merged)}, closed: ${String(run.closed)}, issues read again: ${String(run.reread)}, new follow-ups: ${String(run.followUps)}, reviews left out for no push access: ${String(run.withoutPush)}, calls to GitHub: ${String(run.calls)}. Left: ${JSON.stringify(deps.github.left())}.${run.stopped === null ? '' : ` Stopped: ${run.stopped}.`}`,
  );
  return run;
}
