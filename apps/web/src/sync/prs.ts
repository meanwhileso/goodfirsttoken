import {
  CONVERSATION_READ,
  foldUntrusted,
  followUpRecordSchema,
  MAX_FAILING_CHECKS,
  MAX_FOLLOW_UP_PATH,
  MAX_FOLLOW_UP_TEXT,
  type FollowUpAuthorKind,
  type PrRecord,
  type PrState,
} from '@goodfirsttoken/core';
import {
  getClaim,
  listClosedPrsSince,
  listOpenPrs,
  listPushers,
  listRereadsDue,
  rereadDone,
  rereadFailed,
  saveFollowUps,
  savePushers,
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
// While a PR is open, it keeps what maintainers and review bots wrote on it,
// and its failed checks and conflicts, for the donor's next session to
// bring back as follow-ups (docs/specs/follow-through.md). When one has merged or closed,
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
  /** Follow-ups read for the first time: reviews, comments, failed checks, and conflicts. */
  followUps: number;
  /** Reviews by a person other than the PR's author that GitHub says can't push to the repo, which are no follow-ups. */
  withoutPush: number;
  /**
   * Comments in a PR's conversation by a person other than the PR's author
   * whom no read saw push to the repo in the last 90 days, and who doesn't
   * own it, which are no follow-ups.
   */
  conversationLeftOut: number;
  /** Issues of PRs closed without merging that were read again, this run's and earlier runs'. */
  reread: number;
  calls: number;
  stopped: StopReason | null;
}

/** PRs one GraphQL query reads. */
export const BATCH = 50;
/** How long after a PR closed without merging the job reads its state, for a reopen or a merge since. */
export const REOPEN_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** The newest reviews read on each PR. */
export const REVIEWS_READ = 10;
/** The comments read on each of those reviews. */
export const COMMENTS_READ = 10;
/** The checks read on the PR's head, to find the failing ones among them. */
export const CHECKS_READ = 100;

// https://docs.github.com/en/graphql/reference/pulls#object-pullrequest
// https://docs.github.com/en/graphql/reference/pulls#object-pullrequestreview
// https://docs.github.com/en/graphql/reference/pulls#object-pullrequestreviewcomment
// https://docs.github.com/en/graphql/reference/issues#object-issuecomment
// https://docs.github.com/en/graphql/reference/checks#object-statuscheckrollup
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

/** A comment in the PR's conversation. */
interface IssueComment {
  id: string;
  body: string;
  url: string;
  createdAt: string;
  author: Actor | null;
}

/** One check on a commit: a check run, or a commit status. */
type CheckContext =
  | { __typename: 'CheckRun'; name: string; conclusion: string | null }
  | { __typename: 'StatusContext'; context: string; state: string };

interface PullState {
  state: string;
  mergedAt: string | null;
  closedAt: string | null;
  headRefOid?: string;
  baseRefOid?: string;
  baseRefName?: string;
  mergeable?: string;
  author?: Actor | null;
  reviews?: { totalCount?: number; nodes: (Review | null)[] | null } | null;
  comments?: { totalCount?: number; nodes: (IssueComment | null)[] | null } | null;
  commits?: {
    nodes:
      | ({
          commit: {
            oid: string;
            statusCheckRollup: { state: string; contexts: { nodes: (CheckContext | null)[] | null } | null } | null;
          } | null;
        } | null)[]
      | null;
  } | null;
}

type Pulls = Record<string, { pullRequest: PullState | null } | null>;

// A pending review is its author's alone, and a dismissed one no longer
// asks for anything, so the query leaves both out. The head's checks come
// from its one commit in `commits(last: 1)`.
const PULL = `fragment Pull on PullRequest {
  state mergedAt closedAt headRefOid baseRefOid baseRefName mergeable
  author { __typename login }
  reviews(last: ${String(REVIEWS_READ)}, states: [COMMENTED, CHANGES_REQUESTED, APPROVED]) {
    totalCount
    nodes {
      id state body url submittedAt authorCanPushToRepository
      author { __typename login }
      comments(first: ${String(COMMENTS_READ)}) { totalCount nodes { id body path url createdAt } }
    }
  }
  comments(last: ${String(CONVERSATION_READ)}) { totalCount nodes { id body url createdAt author { __typename login } } }
  commits(last: 1) {
    nodes {
      commit {
        oid
        statusCheckRollup {
          state
          contexts(first: ${String(CHECKS_READ)}) {
            nodes { __typename ... on CheckRun { name conclusion } ... on StatusContext { context state } }
          }
        }
      }
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
 * The login of the person who wrote a review or a comment, when they are
 * neither the PR's author, who is the donor, nor a bot. Good First Token
 * posts on GitHub only as the donor, with the donor's token, so leaving out
 * the PR's author leaves out its posts too. A user account whose login ends
 * in `[bot]` is left out with the bots, and is no review bot either. Null
 * for anyone else, and for an account GitHub no longer has.
 */
function personOf(author: Actor | null, prAuthor: string): string | null {
  const login = author?.login;
  if (typeof login !== 'string' || author?.__typename === 'Bot' || /\[bot\]$/i.test(login)) return null;
  return login.toLowerCase() === prAuthor.toLowerCase() ? null : login;
}

/**
 * The login of a review bot: an account GitHub types `Bot`, which is a
 * GitHub App's. GraphQL gives its login with no `[bot]` on the end, and the
 * follow-up keeps it so. Null for anyone else.
 */
function botOf(author: Actor | null): string | null {
  const login = author?.login;
  if (author?.__typename !== 'Bot' || typeof login !== 'string') return null;
  return login.replace(/\[bot\]$/i, '');
}

/** Who wrote a follow-up, and whether they are a maintainer or a bot. */
interface Author {
  login: string;
  kind: FollowUpAuthorKind;
}

/**
 * Who wrote a review whose words count as a follow-up: a review bot, by
 * botOf, or a maintainer, a person, by personOf, whom GitHub says can push
 * to the repo, by the review's `authorCanPushToRepository`. GitHub's docs
 * describe it as the author's push access, with nothing about who reads it,
 * where `authorAssociation` hides a private member of the organization from
 * a token outside it. That isn't checked on GitHub, so the run counts the
 * reviews it leaves out for no push access, by withoutPushOf. The review's
 * comments on lines are its author's too.
 */
function reviewerOf(review: Review, prAuthor: string): Author | null {
  const bot = botOf(review.author);
  if (bot !== null) return { login: bot, kind: 'bot' };
  const login = personOf(review.author, prAuthor);
  return login !== null && review.authorCanPushToRepository === true ? { login, kind: 'maintainer' } : null;
}

/** The people whose reviews on an open PR the read took showed push access to the repo, the PR's author too. */
function pushersOf(pull: PullState): string[] {
  return (pull.reviews?.nodes ?? []).flatMap((review) => {
    const login = review?.author?.login;
    if (review === null || review.authorCanPushToRepository !== true || typeof login !== 'string') return [];
    return personOf(review.author, '') === null ? [] : [login];
  });
}

/** How many of an open PR's reviews the read took are a person's, by personOf, whom GitHub says can't push to the repo. */
function withoutPushOf(pull: PullState): number {
  const prAuthor = pull.author?.login ?? '';
  return (pull.reviews?.nodes ?? []).filter(
    (review) => review !== null && personOf(review.author, prAuthor) !== null && review.authorCanPushToRepository !== true,
  ).length;
}

/**
 * Who counts as a maintainer for a comment in a PR's conversation, which
 * shows no push access: someone a read saw push to the repo in a review in
 * the last 90 days, kept in repo_pushers, and the repo's owner. Both in
 * lower case.
 */
interface Maintainers {
  pushers: ReadonlySet<string>;
  owner: string;
}

/**
 * Who wrote a comment in the conversation whose words count as a
 * follow-up: a review bot, or a maintainer by `maintainers`. Null for
 * anyone else.
 */
function commenterOf(comment: IssueComment, prAuthor: string, maintainers: Maintainers): Author | null {
  const bot = botOf(comment.author);
  if (bot !== null) return { login: bot, kind: 'bot' };
  const login = personOf(comment.author, prAuthor);
  if (login === null) return null;
  const key = login.toLowerCase();
  return maintainers.pushers.has(key) || key === maintainers.owner ? { login, kind: 'maintainer' } : null;
}

/** How many of the conversation's comments the read took are a person's, by personOf, who counts as no maintainer. */
function conversationLeftOutOf(pull: PullState, maintainers: Maintainers): number {
  const prAuthor = pull.author?.login ?? '';
  return (pull.comments?.nodes ?? []).filter(
    (comment) => comment !== null && personOf(comment.author, prAuthor) !== null && commenterOf(comment, prAuthor, maintainers) === null,
  ).length;
}

/** What a check run's conclusion or a commit status's state says failed. */
const FAILED_RUN = new Set(['ACTION_REQUIRED', 'CANCELLED', 'FAILURE', 'STARTUP_FAILURE', 'TIMED_OUT']);
const FAILED_STATUS = new Set(['ERROR', 'FAILURE']);

/** The names of the head's checks that failed, of those the read took, in GitHub's order. */
function failingChecksOf(contexts: readonly (CheckContext | null)[]): string[] {
  return contexts.flatMap((check) => {
    if (check?.__typename === 'CheckRun') return check.conclusion !== null && FAILED_RUN.has(check.conclusion) ? [check.name] : [];
    if (check?.__typename === 'StatusContext') return FAILED_STATUS.has(check.state) ? [check.context] : [];
    return [];
  });
}

/**
 * The PR's checks and conflict as follow-ups from GitHub, with no author.
 * Checks on the head that GitHub's combined state says failed are one, known
 * by the head's SHA, so one follow-up stands for one head. Its text is that
 * state and the names of up to 10 failing checks, which are repo text. A
 * PR GitHub says is `CONFLICTING` is one, known by the head's and the
 * base's SHAs. `UNKNOWN`, which GitHub often gives before it has worked out
 * the merge, makes none, and the next read tries again. Both are known by
 * the time the job first saw them.
 *
 * The follow-ups an older head's checks or a conflict that GitHub no longer
 * shows still wait, until a submit answers them: superseding them takes
 * follow-up states, under Follow-up states in docs/specs/follow-through.md.
 */
function githubFollowUpsOf(pull: PullState, prUrl: string, readAt: number): NewFollowUp[] {
  const head = pull.headRefOid;
  if (typeof head !== 'string' || head === '') return [];
  const found: NewFollowUp[] = [];
  const commit = pull.commits?.nodes?.at(-1)?.commit;
  const rollup = commit?.oid === head ? commit.statusCheckRollup : null;
  if (rollup && FAILED_STATUS.has(rollup.state)) {
    const names = failingChecksOf(rollup.contexts?.nodes ?? [])
      .map((name) => foldUntrusted(name, MAX_FOLLOW_UP_PATH))
      .filter((name) => name !== '')
      .slice(0, MAX_FAILING_CHECKS);
    found.push({
      commentId: head,
      kind: 'checks',
      reviewer: null,
      authorKind: null,
      body: names.length === 0 ? rollup.state : `${rollup.state}: ${names.join(', ')}`,
      path: null,
      url: `${prUrl}/checks?sha=${encodeURIComponent(head)}`,
      writtenAt: readAt,
    });
  }
  const base = pull.baseRefOid;
  if (pull.mergeable === 'CONFLICTING' && typeof base === 'string' && base !== '') {
    found.push({
      commentId: `${head}:${base}`,
      kind: 'conflict',
      reviewer: null,
      authorKind: null,
      body: `CONFLICTING with ${pull.baseRefName ?? 'its base branch'}`,
      path: null,
      url: prUrl,
      writtenAt: readAt,
    });
  }
  return found;
}

/**
 * What maintainers and review bots wrote on an open PR, and what GitHub
 * shows of its checks and whether it can merge, as follow-ups: the text of
 * each review that comments or asks for changes, each comment on a line, in
 * any review but a dismissed one, each comment in the conversation, failed
 * checks, and a conflict. An approval's own text asks for nothing. Each
 * text, and each file's path, is folded to one line and cut. Empty text,
 * and anything GitHub gives in another form, is left out.
 */
function followUpsOf(pull: PullState, prUrl: string, maintainers: Maintainers, readAt: number): NewFollowUp[] {
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
    const author = reviewerOf(review, prAuthor);
    if (author === null) continue;
    if (review.state !== 'APPROVED') {
      add({
        commentId: review.id,
        kind: 'review',
        reviewer: author.login,
        authorKind: author.kind,
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
        kind: 'line',
        reviewer: author.login,
        authorKind: author.kind,
        body: comment.body,
        path: comment.path,
        url: comment.url,
        writtenAt: Date.parse(comment.createdAt),
      });
    }
  }
  for (const comment of pull.comments?.nodes ?? []) {
    if (comment === null) continue;
    const author = commenterOf(comment, prAuthor, maintainers);
    if (author === null) continue;
    add({
      commentId: comment.id,
      kind: 'conversation',
      reviewer: author.login,
      authorKind: author.kind,
      body: comment.body,
      path: null,
      url: comment.url,
      writtenAt: Date.parse(comment.createdAt),
    });
  }
  for (const followUp of githubFollowUpsOf(pull, prUrl, readAt)) add(followUp);
  return found;
}

/**
 * What the read covered of an open PR's reviews and conversation: every
 * review GitHub counts, pending and dismissed ones left out, and for each
 * review it took, newest first, the comments on lines of a maintainer's or
 * a bot's review it left out, then every comment GitHub counts in the
 * conversation, and how many of the newest it took. setReviewsRead adds it
 * to what earlier reads covered.
 */
function reviewsReadOf(pull: PullState): Omit<ReviewsRead, 'claimId' | 'readAt'> {
  const read = (pull.reviews?.nodes ?? []).filter((review) => review !== null);
  const prAuthor = pull.author?.login ?? '';
  const leftOut = read
    .map((review) =>
      reviewerOf(review, prAuthor) === null ? 0 : Math.max(0, (review.comments?.totalCount ?? 0) - (review.comments?.nodes?.length ?? 0)),
    )
    .reverse();
  const took = (pull.comments?.nodes ?? []).length;
  return {
    reviews: Math.max(pull.reviews?.totalCount ?? 0, read.length),
    leftOut,
    conversation: Math.max(pull.comments?.totalCount ?? 0, took),
    conversationTook: took,
  };
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
 * Whether the PR job still reads the PR: open, or recorded closed without
 * merging in the last 14 days. A merged PR never changes, and one closed
 * longer ago is no longer read.
 */
export function isFollowed(record: PrRecord, now: number): boolean {
  if (record.state === 'open') return true;
  return record.state === 'closed' && record.closedAt !== null && record.closedAt >= now - REOPEN_WINDOW_MS;
}

/** A run's count of what it did, with nothing done yet. */
function newPrRun(): PrRun {
  return {
    checked: 0,
    closedChecked: 0,
    reopened: 0,
    merged: 0,
    closed: 0,
    followUps: 0,
    withoutPush: 0,
    conversationLeftOut: 0,
    reread: 0,
    calls: 0,
    stopped: null,
  };
}

/**
 * Reads one batch of PRs in one query, and records what GitHub shows for
 * each, as followPrs describes. Gives the claims whose PR GitHub gave. A
 * PR GitHub no longer shows is left as the table has it.
 */
async function followBatch(deps: PrJobDeps, batch: readonly Read[], run: PrRun): Promise<Set<string>> {
  // A check and the PR job can read the same PR at once, so the counts
  // carry when the read was made, and an older read's counts change nothing.
  const readAt = deps.now();
  const pulls = await readStates(deps.github, batch);
  const read = new Set<string>();
  const covered: ReviewsRead[] = [];
  // Who can push to each repo, from every review this batch read first, so
  // a maintainer's review on one PR counts for their comments on another.
  const seen = batch.flatMap(({ record, open }, i) => {
    const pull = pulls[`p${String(i)}`]?.pullRequest;
    return open && pull != null && outcomeOf(pull, readAt) === null
      ? pushersOf(pull).map((login) => ({ repo: record.pr.repo, login }))
      : [];
  });
  const repos = [...new Set(batch.filter(({ open }) => open).map(({ record }) => record.pr.repo))];
  if (repos.length > 0) await savePushers(deps.db, seen, readAt);
  const pushers = await listPushers(deps.db, repos, readAt);
  for (const [i, { record, open: followed }] of batch.entries()) {
    const pull = pulls[`p${String(i)}`]?.pullRequest;
    if (pull == null) continue;
    read.add(record.claimId);
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
      const maintainers: Maintainers = {
        pushers: pushers.get(record.pr.repo.toLowerCase()) ?? new Set(),
        owner: (record.pr.repo.split('/')[0] ?? '').toLowerCase(),
      };
      run.followUps += await saveFollowUps(deps.db, record.claimId, followUpsOf(pull, record.pr.url, maintainers, readAt), deps.now());
      run.withoutPush += withoutPushOf(pull);
      run.conversationLeftOut += conversationLeftOutOf(pull, maintainers);
      covered.push({ claimId: record.claimId, ...reviewsReadOf(pull), readAt });
      continue;
    }
    const claim = await getClaim(deps.db, record.claimId);
    if (claim === null || !(await recordEnd(deps, record, claim.issue, outcome))) continue;
    if (outcome.state === 'merged') run.merged += 1;
    else run.closed += 1;
  }
  await setReviewsRead(deps.db, covered);
  return read;
}

/** Records why a run stopped, for a stop GitHub caused. Any other error goes on up. */
function stoppedBy(run: PrRun, error: unknown, job: string): void {
  if (error instanceof SyncStopped) {
    run.stopped = error.reason;
    console.warn(`${job} stopped. ${error.message}`);
  } else if (error instanceof GitHubError) {
    run.stopped = 'github_error';
    console.warn(`${job} stopped. GitHub answered ${String(error.status)}: ${error.message}`);
  } else {
    throw error;
  }
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
  const run = newPrRun();
  const [open, closed, due] = await Promise.all([
    listOpenPrs(deps.db),
    listClosedPrsSince(deps.db, deps.now() - REOPEN_WINDOW_MS),
    listRereadsDue(deps.db),
  ]);
  const reads: Read[] = [...open.map((record) => ({ record, open: true })), ...closed.map((record) => ({ record, open: false }))];
  try {
    if (reads.length > 0 || due.length > 0) await deps.github.checkGitHub();
    for (let start = 0; start < reads.length; start += BATCH) {
      await followBatch(deps, reads.slice(start, start + BATCH), run);
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
    stoppedBy(run, error, 'The PR job');
  }
  run.calls = deps.github.calls;
  console.log(
    `The PR job read open PRs: ${String(run.checked)} of ${String(open.length)}, PRs closed in the last 14 days: ${String(run.closedChecked)} of ${String(closed.length)}, open again: ${String(run.reopened)}, merged: ${String(run.merged)}, closed: ${String(run.closed)}, issues read again: ${String(run.reread)}, new follow-ups: ${String(run.followUps)}, reviews left out for no push access: ${String(run.withoutPush)}, conversation comments left out from people who are no maintainer: ${String(run.conversationLeftOut)}, calls to GitHub: ${String(run.calls)}. Left: ${JSON.stringify(deps.github.left())}.${run.stopped === null ? '' : ` Stopped: ${run.stopped}.`}`,
  );
  return run;
}

/**
 * Reads the PRs of the claims named, now, for donors who asked with
 * check_pr, and records what GitHub shows the way followPrs does: an open
 * PR in full, and one recorded closed without merging in the last 14 days
 * for its state alone. A merged PR stays merged, so it isn't read. The
 * issue of a PR this read finds closed without merging is due to be read
 * again, and the PR job's next run reads it. Gives the claims whose PR
 * GitHub gave, and the run. A refusal from GitHub stops the read, which
 * ends without an error. src/sync/pr-checker.ts decides when it runs.
 */
export async function checkClaimPrs(deps: PrJobDeps, records: readonly PrRecord[]): Promise<{ read: Set<string>; run: PrRun }> {
  const run = newPrRun();
  const reads: Read[] = records
    .filter((record) => isFollowed(record, deps.now()))
    .map((record) => ({ record, open: record.state === 'open' }));
  const read = new Set<string>();
  try {
    if (reads.length > 0) await deps.github.checkGitHub();
    for (let start = 0; start < reads.length; start += BATCH) {
      for (const claimId of await followBatch(deps, reads.slice(start, start + BATCH), run)) read.add(claimId);
    }
  } catch (error) {
    stoppedBy(run, error, 'A check of PRs');
  }
  run.calls = deps.github.calls;
  console.log(
    `A check of PRs asked for ${String(records.length)}, read ${String(read.size)}, open again: ${String(run.reopened)}, merged: ${String(run.merged)}, closed: ${String(run.closed)}, new follow-ups: ${String(run.followUps)}, calls to GitHub: ${String(run.calls)}. Left: ${JSON.stringify(deps.github.left())}.${run.stopped === null ? '' : ` Stopped: ${run.stopped}.`}`,
  );
  return { read, run };
}
