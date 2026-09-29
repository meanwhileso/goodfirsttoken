import {
  foldUntrusted,
  followUpRecordSchema,
  MAX_FOLLOW_UP_TEXT,
  type PrRecord,
  type PrState,
} from '@goodfirsttoken/core';
import { getClaim, listOpenPrs, saveFollowUps, setPrState, type NewFollowUp } from '../db';
import { GitHubError } from '../github';
import { issueRoom, type IssueRoom } from '../rooms/issue-room';
import { SyncStopped, type ServiceGitHub, type StopReason } from './github';
import { rereadIssue } from './issues';

// The PR job (spec section 7). It follows each PR opened for a claim until
// it merges or closes, reading GitHub with the read-only service token.
// While a PR is open, it keeps what reviewers wrote on it, for the donor's
// next session to bring back as follow-ups. When one has merged or closed,
// it tells the claim's issue room, which announces it and takes claims
// again once no PR is open on the issue, then records the outcome in the
// prs table. A PR closed without merging has its issue read again, by the
// sync's rules, so the issue takes claims again at once when it is still
// open and tagged. The rules are in docs/how-it-works.md, under PRs.

export interface PrJobDeps {
  db: D1Database;
  rooms: DurableObjectNamespace<IssueRoom>;
  github: ServiceGitHub;
  now: () => number;
}

/** What one run did, for its log line. */
export interface PrRun {
  checked: number;
  merged: number;
  closed: number;
  /** Reviews and review comments read for the first time. */
  followUps: number;
  calls: number;
  stopped: StopReason | null;
}

/** PRs one GraphQL query reads. */
const BATCH = 50;
/** The newest reviews read on each PR. */
export const REVIEWS_READ = 10;
/** The comments read on each of those reviews. */
export const COMMENTS_READ = 10;
/** The longest file path a follow-up keeps. */
const MAX_PATH = 4096;

// https://docs.github.com/en/graphql/reference/pulls#object-pullrequest
// https://docs.github.com/en/graphql/reference/pulls#object-pullrequestreview
// https://docs.github.com/en/graphql/reference/pulls#object-pullrequestreviewcomment
interface Actor {
  __typename?: string;
  login?: string;
}

interface ReviewComment {
  id: string;
  body: string;
  path: string;
  url: string;
  createdAt: string;
  author: Actor | null;
}

interface Review {
  id: string;
  state: string;
  body: string;
  url: string;
  submittedAt: string | null;
  author: Actor | null;
  comments: { nodes: (ReviewComment | null)[] | null } | null;
}

interface PullState {
  state: string;
  mergedAt: string | null;
  closedAt: string | null;
  author?: Actor | null;
  reviews?: { nodes: (Review | null)[] | null } | null;
}

type Pulls = Record<string, { pullRequest: PullState | null } | null>;

// A pending review is its author's alone, and a dismissed one no longer
// asks for anything, so the query leaves both out.
const PULL = `fragment Pull on PullRequest {
  state mergedAt closedAt
  author { __typename login }
  reviews(last: ${String(REVIEWS_READ)}, states: [COMMENTED, CHANGES_REQUESTED, APPROVED]) {
    nodes {
      id state body url submittedAt
      author { __typename login }
      comments(first: ${String(COMMENTS_READ)}) { nodes { id body path url createdAt author { __typename login } } }
    }
  }
}`;

async function readStates(github: ServiceGitHub, prs: readonly PrRecord[]): Promise<Pulls> {
  const variables: Record<string, unknown> = {};
  const declared: string[] = [];
  const fields = prs.map((record, i) => {
    const n = String(i);
    const [owner = '', name = ''] = record.pr.repo.split('/');
    variables[`o${n}`] = owner;
    variables[`r${n}`] = name;
    variables[`n${n}`] = record.pr.number;
    declared.push(`$o${n}: String!`, `$r${n}: String!`, `$n${n}: Int!`);
    return `p${n}: repository(owner: $o${n}, name: $r${n}) { pullRequest(number: $n${n}) { ...Pull } }`;
  });
  const { data, errors } = await github.query<Pulls>(`query (${declared.join(', ')}) { ${fields.join('\n')} }\n${PULL}`, variables);
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
 * The login of a reviewer: someone other than the PR's author, who is the
 * donor, and not a GitHub App's bot. Good First Token posts on GitHub only
 * as the donor, with the donor's token, so leaving out the PR's author
 * leaves out its posts too. Null for anyone else, and for an account
 * GitHub no longer has.
 */
function reviewerOf(author: Actor | null | undefined, prAuthor: string): string | null {
  const login = author?.login;
  if (typeof login !== 'string' || author?.__typename === 'Bot' || /\[bot\]$/i.test(login)) return null;
  return login.toLowerCase() === prAuthor.toLowerCase() ? null : login;
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
      path: followUp.path === null ? null : foldUntrusted(followUp.path, MAX_PATH),
    });
    if (checked.success) found.push(checked.data);
  };
  for (const review of pull.reviews?.nodes ?? []) {
    if (review === null || !['COMMENTED', 'CHANGES_REQUESTED', 'APPROVED'].includes(review.state)) continue;
    const reviewer = reviewerOf(review.author, prAuthor);
    if (reviewer !== null && review.state !== 'APPROVED') {
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
      const commenter = reviewerOf(comment.author, prAuthor);
      if (commenter === null) continue;
      add({
        commentId: comment.id,
        reviewer: commenter,
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
 * Reads every open PR in the prs table, oldest first, until they are done
 * or the run has to stop. It first asks GitHub what is left of the budget.
 * An open PR's new reviews and review comments are kept as follow-ups. A
 * PR whose room didn't hear it merged or closed stays open in the table, so
 * the next run tries again. A refusal from GitHub stops the run, which ends
 * without an error.
 */
export async function followPrs(deps: PrJobDeps): Promise<PrRun> {
  const run: PrRun = { checked: 0, merged: 0, closed: 0, followUps: 0, calls: 0, stopped: null };
  const open = await listOpenPrs(deps.db);
  try {
    if (open.length > 0) await deps.github.checkGitHub();
    for (let start = 0; start < open.length; start += BATCH) {
      const batch = open.slice(start, start + BATCH);
      const pulls = await readStates(deps.github, batch);
      for (const [i, record] of batch.entries()) {
        const pull = pulls[`p${String(i)}`]?.pullRequest;
        if (pull == null) continue;
        run.checked += 1;
        const outcome = outcomeOf(pull, deps.now());
        if (outcome === null) {
          run.followUps += await saveFollowUps(deps.db, record.claimId, followUpsOf(pull), deps.now());
          continue;
        }
        const claim = await getClaim(deps.db, record.claimId);
        if (claim === null) continue;
        try {
          const told = await issueRoom(deps.rooms, claim.issue).claimPrEnded({
            claimId: claim.id,
            pr: record.pr,
            merged: outcome.state === 'merged',
          });
          if (!told.ok) continue;
        } catch (error) {
          console.warn(`The room for ${claim.issue} didn't hear that its PR closed. The next run tries again.`, error);
          continue;
        }
        await setPrState(deps.db, record.claimId, outcome.state, outcome.at);
        if (outcome.state === 'merged') {
          run.merged += 1;
        } else {
          run.closed += 1;
          await rereadIssue(deps, claim.issue);
        }
      }
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
    `The PR job read open PRs: ${String(run.checked)} of ${String(open.length)}, merged: ${String(run.merged)}, closed: ${String(run.closed)}, new follow-ups: ${String(run.followUps)}, calls to GitHub: ${String(run.calls)}. Left: ${JSON.stringify(deps.github.left())}.${run.stopped === null ? '' : ` Stopped: ${run.stopped}.`}`,
  );
  return run;
}
