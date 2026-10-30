import {
  MAX_PR_TITLE,
  claimDeadlines,
  foldIssueTitle,
  holdsSlot,
  nextClaimState,
  prTitle,
  stripSecretsFromText,
  toolResult,
  type ClaimEvent,
  type ClaimRecord,
  type PrRef,
  type ProjectRecord,
  type Refusal,
  type ReviewReason,
  type SubmissionRecord,
  type ToolInput,
  type ToolOutput,
} from '@goodfirsttoken/core';
import { env } from 'cloudflare:workers';
import type { Caller } from '../auth/permissions';
import {
  addPr,
  answerFollowUps,
  countOpenPrsByProject,
  getIssue,
  getPr,
  getProject,
  getSubmission,
  countClearedByProject,
  getSubmissions,
  listPersonClaims,
  saveSubmission,
  setClearance,
} from '../db';
import { checkIssueFacts, linkedPrs, readIssue, readRepoFacts, type GitHubIssue, type IssueRules, type RepoFacts } from '../donor/github';
import { GitHubError, gitHubUrls } from '../github';
import { blockedRefusal, openPrRefusal, projectClosedRefusal, type Donor } from '../donor/rules';
import {
  branchFor,
  hasTrailer,
  isWorkflowPath,
  closingLine,
  prBody,
  pullMismatch,
  redacted,
  type ClearedPr,
  reviewReason,
} from '../donor/work';
import { BranchReader, branchUrls, commitUrl, type PullFacts } from '../donor/branches';
import { issueRoom } from '../rooms/issue-room';
import {
  answer,
  donorOf,
  gitHubIssueUrl,
  isRefusal,
  liveUrl,
  lower,
  ownClaim,
  refusal,
  refuse,
  stateAt,
  tokenOf,
  type Answer,
} from './donor';

// submit_work, open_pr, and record_pr: the donor's agent pushes the claim's
// branch, and submit_work checks it on GitHub and puts the work in the
// donor's review queue. open_pr, or the Open PR button on /me
// (src/me/page.ts), clears it to open as a PR by the same rules, and the
// donor opens the PR with their own tools. record_pr, or the job in
// src/sync/cleared.ts, records it. Every GitHub call here is a read, with
// the donor's own token, for their own claim: the server writes nothing to
// GitHub for a donor's work (docs/specs/agent-submits.md). The claim changes
// only in its issue's room, so the live feeds and the issue page see each
// submit and each PR. The rules are in docs/how-it-works.md, under The
// donor's tools.

/** The most files GitHub lists in a comparison. */
const COMPARE_FILES = 300;

function samePr(a: PrRef, b: PrRef): boolean {
  return lower(a.repo) === lower(b.repo) && a.number === b.number;
}

/** A claim the caller may submit to or open a PR for, with what the answer needs. */
interface Work {
  /** The claim as its room holds it now. */
  claim: ClaimRecord;
  project: ProjectRecord;
  donor: Donor;
  /** Open PRs on the issue that the room knows of, other than the claim's own. */
  roomPrs: PrRef[];
}

/**
 * The caller's claim, checked before anything goes to GitHub: it is theirs,
 * they aren't blocked, its project still takes work, and the claim can take
 * `event` now. A claim whose PR merged or closed takes no more work.
 */
async function workOn(caller: Caller, claimId: string, event: ClaimEvent, now: number): Promise<Work | Refusal> {
  const found = await ownClaim(caller, claimId);
  if (isRefusal(found)) return found;
  const donor = await donorOf(caller);
  const blocked = await blockedRefusal(env.DB, donor);
  if (blocked) return blocked;
  const project = await getProject(env.DB, found.project);
  const closed = await projectClosedRefusal(env.DB, project, found.project);
  if (closed || project === null) return closed ?? refusal('project_not_open', `${found.project} is no longer a project.`);
  const snapshot = await issueRoom(env.ISSUE_ROOM, found.issue).snapshot();
  const claim = snapshot.claims.find((held) => held.id === found.id) ?? found;
  const checked = nextClaimState(claim, event, Math.max(now, claim.claimedAt));
  if (!checked.ok) return checked.refusal;
  if (claim.pr !== null) {
    const pr = await getPr(env.DB, claim.id);
    if (pr?.state === 'merged') {
      return refusal('pr_closed', `Claim ${claim.id}'s PR, ${claim.pr.url}, merged, so the claim takes no more work. Pick another issue.`);
    }
    if (pr?.state === 'closed') {
      return refusal(
        'pr_closed',
        `Claim ${claim.id}'s PR, ${claim.pr.url}, closed without merging, so the claim takes no more work. While ${claim.issue} is open and tagged, it takes claims again: claim it with claim_issue to try again.`,
      );
    }
  }
  const roomPrs = snapshot.prs.filter((pr) => claim.pr === null || !samePr(pr, claim.pr));
  return { claim, project, donor, roomPrs };
}

/** The open PRs on the issue now, on GitHub and in its room, other than the claim's own. */
async function otherPrs(reads: BranchReader, work: Work, names: readonly string[]): Promise<PrRef[]> {
  const links = (await linkedPrs(reads.reader, work.project, work.claim.issue, names)) ?? [];
  const own = work.claim.pr;
  const found: PrRef[] = [];
  for (const pr of [...links.map((link) => link.pr), ...work.roomPrs]) {
    if (own !== null && samePr(pr, own)) continue;
    if (!found.some((known) => samePr(known, pr))) found.push(pr);
  }
  return found;
}

/**
 * What checkIssueFacts lets through for a donor's own work: the issue may be
 * assigned to them, as a maintainer does for someone on it, and to no one
 * else. `next` says what the agent does when the issue fails.
 */
function ownIssue(donor: Donor, next: string): IssueRules {
  return { assignee: donor.login, next };
}

const NOT_TAKEN = 'Nothing was taken. Stop with release_claim and a reason.';
const NOT_CLEARED = "The work stays on its branch, and isn't cleared to open. Stop with release_claim and a reason.";

/** The code repo on GitHub as the donor sees it, or the refusal when it has no default branch to aim a PR at. */
async function codeRepo(reads: BranchReader, project: ProjectRecord): Promise<(RepoFacts & { defaultBranch: string }) | Refusal> {
  const facts = await readRepoFacts(reads.reader, project.repo);
  if (facts === null || facts.defaultBranch === null) {
    return refusal('project_not_open', `GitHub shows you no public repo named ${project.repo} with a branch to aim a PR at, so nothing was sent.`);
  }
  return { ...facts, defaultBranch: facts.defaultBranch };
}

/**
 * The refusal for a submit with files, which older skills sent: the server
 * takes a pushed branch alone, so the agent updates the skill, pushes the
 * claim's branch, and submits with branch.
 */
function skillOutdated(branch: string): Refusal {
  return refusal(
    'skill_outdated',
    `submit_work takes the branch you pushed, and no longer takes files, so nothing was taken. The skill you follow is older than Good First Token's server. Update it: in Claude Code, update the goodfirsttoken plugin, and elsewhere run npx skills add meanwhileso/goodfirsttoken. Then commit the work on the claim's branch, ${branch}, with the project's trailer on each commit, push the branch to the code repo or the donor's fork, and call submit_work with branch.`,
  );
}

export async function submitWork(
  caller: Caller,
  input: ToolInput<'submit_work'>,
  now: number,
): Promise<Answer> {
  const work = await workOn(caller, input.claimId, { kind: 'submit' }, now);
  if (isRefusal(work)) return refuse(work);
  const { claim, project, donor } = work;
  const earlier = await getSubmission(env.DB, claim.id);
  // Nothing an older skill sent with files is read, and nothing reaches GitHub.
  if (input.files !== undefined || input.branch === undefined) return refuse(skillOutdated(earlier?.branch ?? branchFor(claim)));
  const reads = new BranchReader(await tokenOf(caller));
  const facts = await codeRepo(reads, project);
  if (isRefusal(facts)) return refuse(facts);
  // The issue is checked on GitHub as a claim checks it: GitHub shows it, it
  // is open, it carries a tag and no excluded tag, and no one else is
  // assigned. A claim whose PR is open is past that: the PR is the
  // maintainers' to take or close, and they often relabel or assign an issue
  // once a PR is on it.
  let issue: GitHubIssue | null;
  if (claim.pr === null) {
    const checked = await checkIssueFacts(env.DB, reads.reader, project, claim.issue, ownIssue(donor, NOT_TAKEN));
    if (!checked.ok) return refuse(checked.refusal);
    issue = checked.issue;
  } else {
    issue = await readIssue(reads.reader, claim.issue);
  }
  // The issue's title takes the agent's rules for one, so a line break in
  // it can't start a line of the PR's title.
  const titled = prTitle.safeParse(input.title ?? issue?.title ?? (await getIssue(env.DB, project.repo, claim.issue))?.title);
  const title = redacted(titled.success ? titled.data : claim.issue, MAX_PR_TITLE);
  const summary = redacted(input.summary);
  const checks = redacted(input.checks);
  const model = redacted(input.model, 100);
  return submitPushed(reads, work, facts, issue, earlier, input, input.branch, { title, summary, checks, model }, now);
}

/** The submit's notes, with keys and tokens replaced. */
interface Notes {
  title: string;
  summary: string;
  checks: string;
  model: string;
}

/**
 * Takes a branch the donor's agent pushed with the donor's own tools
 * (docs/specs/agent-submits.md), checked with GitHub reads alone: it is the
 * claim's branch, in the code repo or a fork of it, at the head the agent
 * named, it comes from the start commit, it has commits past the default
 * branch, and each commit of the donor's but a merge carries the project's
 * trailer. Then the work goes to the review queue, or onto the claim's PR
 * when one is open. Nothing is written to GitHub.
 */
async function submitPushed(
  reads: BranchReader,
  work: Work,
  facts: RepoFacts & { defaultBranch: string },
  issue: GitHubIssue | null,
  earlier: SubmissionRecord | null,
  input: ToolInput<'submit_work'>,
  pushed: { repo: string; name: string; head: string },
  notes: Notes,
  now: number,
): Promise<Answer> {
  const { claim, project, donor } = work;
  const branch = earlier?.branch ?? branchFor(claim);
  if (pushed.name !== branch) {
    return refuse(
      refusal('branch_not_found', `Claim ${claim.id}'s branch is ${branch}, and ${pushed.name} isn't it, so nothing was taken. Push your work to ${branch}, and submit again.`),
    );
  }
  // A claim's branch stays in the repo its first submit named.
  if (earlier !== null && lower(earlier.repo) !== lower(pushed.repo)) {
    return refuse(
      refusal('branch_elsewhere', `Claim ${claim.id}'s branch is in ${earlier.repo}, so nothing was taken from ${pushed.repo}. Push your work to ${earlier.repo}:${branch}, and submit again.`),
    );
  }
  let repo = facts.name;
  if (lower(pushed.repo) !== lower(facts.name)) {
    const found = await reads.repoOf(pushed.repo);
    // The code repo's old name, after a rename, finds the code repo itself.
    const forked =
      found !== null && [found.name, found.parent, found.source].some((from) => from !== null && lower(from) === lower(facts.name));
    if (found === null || !forked) {
      return refuse(
        refusal('branch_elsewhere', `GitHub shows ${pushed.repo} as no fork of ${facts.name}, so nothing was taken. Push the branch to ${facts.name}, or to the donor's fork of it, and submit again.`),
      );
    }
    repo = found.name;
  }
  const head = await reads.branchHead(repo, branch);
  if (typeof head !== 'string') {
    return refuse(refusal('branch_not_found', `GitHub shows no branch ${branch} in ${repo}, so nothing was taken. Push it, and submit again.`));
  }
  if (head !== pushed.head) {
    return refuse(
      refusal('branch_not_found', `${repo}:${branch} is at ${head}, and not at ${pushed.head}, so nothing was taken. Push your work, and submit with the head GitHub shows.`),
    );
  }
  if (claim.pr !== null && earlier?.commit === head) {
    return refuse(refusal('no_changes', `${repo}:${branch} is still at ${head}, the last submit's head, so nothing was taken. Push the fixes, and submit again.`));
  }
  const fromStart = await reads.comparison(repo, claim.startCommit, head);
  if (fromStart === null) {
    return refuse(refusal('github_refused', `GitHub gave no comparison of ${repo}:${branch} with the start commit, so nothing was taken. Submit again.`));
  }
  if (fromStart.status !== 'ahead' && fromStart.status !== 'identical') {
    return refuse(
      refusal('not_from_start', `The start commit, ${claim.startCommit}, isn't an ancestor of ${repo}:${branch}, so nothing was taken. Build the branch on the start commit, or on the default branch, push it, and submit again.`),
    );
  }
  // The PR's own change: from where the branch parts from the default
  // branch, so main's changes merged into it don't count.
  const diffFrom = facts.head ?? claim.startCommit;
  const own = await reads.comparison(repo, diffFrom, head);
  // A fix after the PR opens is checked against the last submit's head.
  const fixing = claim.pr !== null && earlier !== null;
  const since = fixing ? await reads.comparison(repo, earlier.commit, head) : own;
  if (own === null || since === null) {
    return refuse(refusal('github_refused', `GitHub gave no comparison of ${repo}:${branch}, so its commits couldn't be checked, and nothing was taken. Submit again.`));
  }
  if (own.aheadBy === 0 || own.files === 0) {
    return refuse(refusal('no_changes', `${repo}:${branch} changes no file from ${facts.defaultBranch}, so nothing was taken. Commit your work on the branch, push it, and submit again.`));
  }
  // Until the PR opens, every commit of the branch's own change. After it,
  // the commits since the last submit, apart from those GitHub names
  // another person as the author of, since maintainers may push to it.
  // A commit GitHub links to no account may be a maintainer's whose email
  // GitHub doesn't know, so after the PR opens it isn't the agent's to fix.
  const trailer = project.settings.disclosure.trailer;
  if (trailer !== null) {
    const mine = fixing
      ? since.commits.filter((commit) => commit.author !== null && lower(commit.author) === lower(donor.login))
      : since.commits;
    const missing = mine.filter((commit) => commit.parents < 2 && !hasTrailer(commit.message, trailer));
    if (missing.length > 0) {
      const named = missing.map((commit) => commit.sha.slice(0, 7)).join(', ');
      return refuse(
        refusal('trailer_missing', `${project.repo} asks for the trailer ${trailer} on each commit, and ${named} on ${repo}:${branch} ${missing.length === 1 ? 'lacks' : 'lack'} it, so nothing was taken. Add "${trailer}: ${input.agent} (${notes.model})" to each commit's message, push the branch, and submit again.`),
      );
    }
  }

  // Every read comes before the room records the submit. A PR already open
  // from the claim's own branch isn't another PR on the issue.
  const others: PrRef[] = [];
  if (claim.pr === null) {
    for (const pr of await otherPrs(reads, work, issue?.repo ? [facts.name, issue.repo] : [facts.name])) {
      const from = await reads.pullHead(pr.repo, pr.number);
      if (from?.ref === branch && from.repo !== null && lower(from.repo) === lower(repo)) continue;
      others.push(pr);
    }
  }
  // Claims cleared to open, with no PR yet, count as open PRs.
  const openPrs =
    ((await countOpenPrsByProject(env.DB, donor.githubId)).get(lower(project.repo)) ?? 0) +
    ((await countClearedByProject(env.DB, donor.githubId, now, claim.id)).get(lower(project.repo)) ?? 0);
  const room = issueRoom(env.ISSUE_ROOM, claim.issue);
  const recorded = await room.submit({ claimId: claim.id, githubId: donor.githubId, tokenEstimate: input.tokenEstimate ?? null });
  if (!recorded.ok) return refuse(recorded.refusal);
  const listed = own.commits.length >= own.aheadBy && own.files < COMPARE_FILES;
  const reason =
    recorded.claim.state === 'pr_opened'
      ? null
      : (reviewReason({
          prOnIssue: others.length > 0,
          workflowFiles: own.paths.some(isWorkflowPath),
          tooManyFiles: !listed,
          prMode: project.settings.prMode,
          personWrittenDescription: project.settings.personWrittenDescription,
          atOpenPrCap: openPrRefusal(project, openPrs) !== null,
        }) ?? 'ready_to_open');
  const saved = await saveSubmission(env.DB, {
    claimId: claim.id,
    source: 'branch',
    repo,
    branch,
    commit: head,
    base: claim.startCommit,
    diffFrom,
    paths: own.paths.slice(0, COMPARE_FILES),
    ...notes,
    agent: input.agent,
    additions: own.additions,
    deletions: own.deletions,
    reviewReason: reason,
    submittedAt: now,
    clearance: null,
  });
  // In automatic mode, work with nothing to hold it is cleared to open now.
  const toOpen = reason === 'ready_to_open' ? await clear(saved, work, facts, undefined, now) : null;
  const urls = branchUrls(repo, branch, diffFrom);
  const result = (state: ClaimRecord['state'], pr: PrRef | null, why: ReviewReason | null) =>
    answer(
      toolResult('submit_work', {
        claimId: claim.id,
        issue: claim.issue,
        state,
        commit: { sha: head, url: commitUrl(repo, head) },
        branch: { repo, name: branch, url: urls.branch },
        diffUrl: urls.diff,
        pr,
        reviewReason: why,
        toOpen,
      }),
    );
  // A claim whose PR is open takes the fixes on that PR's branch, which
  // answers the follow-ups on it a tool showed before this submit.
  if (recorded.claim.state === 'pr_opened') {
    await answerFollowUps(env.DB, claim.id, now);
    return result('pr_opened', recorded.claim.pr, null);
  }
  return result(recorded.claim.state, null, reason);
}

/** How the agent opens a cleared PR, as open_pr and submit_work answer with it. */
type PrToOpen = ToolOutput<'open_pr'>['toOpen'];

/** A path's parts, each encoded for a URL. */
function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** Text as one shell word, in single quotes. */
function shellWord(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * The longest compare page link the server gives out, in characters. GitHub
 * doesn't say how long a link it takes (open question 4 in
 * docs/specs/agent-submits.md). Browsers take far longer ones, but web
 * servers and the proxies in front of them commonly refuse a request line
 * over 8 KB, so a link stays under that. A body that would make the link
 * longer is left out of it, for the donor to paste.
 */
export const MAX_COMPARE_URL = 8000;

/**
 * How the donor opens the PR for cleared work: its head and base, its title
 * and body, the GitHub CLI command, and GitHub's form for it with the title
 * filled in, and the body too when the link stays under MAX_COMPARE_URL.
 * https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/using-query-parameters-to-create-a-pull-request
 */
function prToOpen(facts: RepoFacts & { defaultBranch: string }, submission: SubmissionRecord, body: string): PrToOpen {
  const owner = submission.repo.slice(0, submission.repo.indexOf('/'));
  const head = `${owner}:${submission.branch}`;
  const form = `${gitHubUrls().web}/${facts.name}/compare/${encodePath(facts.defaultBranch)}...${owner}:${encodePath(submission.branch)}`;
  const filled = `${form}?${new URLSearchParams({ quick_pull: '1', title: submission.title, body }).toString()}`;
  const bodyInLink = filled.length <= MAX_COMPARE_URL;
  return {
    repo: facts.name,
    head,
    base: facts.defaultBranch,
    title: submission.title,
    body,
    command: `gh pr create --repo ${facts.name} --head ${head} --base ${shellWord(facts.defaultBranch)} --title ${shellWord(submission.title)} --body-file -`,
    compareUrl: bodyInLink ? filled : `${form}?${new URLSearchParams({ quick_pull: '1', title: submission.title }).toString()}`,
    bodyInLink,
  };
}

/**
 * Clears work to open as a PR: saves the head it may open from and
 * the PR's body, and answers with how to open it. A PR counts only from
 * that head (docs/specs/agent-submits.md).
 */
async function clear(
  submission: SubmissionRecord,
  work: Work,
  facts: RepoFacts & { defaultBranch: string },
  description: string | undefined,
  now: number,
): Promise<PrToOpen> {
  const { claim, project } = work;
  const body = prBody({
    description,
    summary: submission.summary,
    checks: submission.checks,
    agent: submission.agent,
    model: submission.model,
    issue: claim.issue,
    codeRepo: facts.name,
    disclosure: project.settings.disclosure,
  });
  await setClearance(env.DB, claim.id, submission.commit, { commit: submission.commit, body, at: now });
  return prToOpen(facts, submission, body);
}

/** What clearing a claim's work did: how to open its PR, as open_pr answers with it, or why it wasn't cleared. */
export type Opened = { ok: true; value: ToolOutput<'open_pr'> } | { ok: false; refusal: Refusal };

/**
 * Clears the caller's work in their review queue to open as a PR, by
 * open_pr's rules, with the caller's own GitHub token, and answers with how
 * to open it. Nothing is written to GitHub: the donor opens the PR with
 * their own tools. Older work submitted with files keeps the branch the
 * server made, and clears the same way. The MCP tool and the Open PR button on /me both call it: the
 * tool with the token of the donor's agent, the page with the one from
 * their sign-in on the site. A claim that isn't the caller's throws
 * PermissionRefused, as every donor's tool does.
 */
export async function openPrAs(caller: Caller, input: ToolInput<'open_pr'>, now: number): Promise<Opened> {
  const refused = (why: Refusal): Opened => ({ ok: false, refusal: why });
  // Any PR will do to ask the claim whether it can take one now.
  const probe = { repo: 'goodfirsttoken/goodfirsttoken', number: 1, url: 'https://github.com/' };
  const work = await workOn(caller, input.claimId, { kind: 'open_pr', pr: probe }, now);
  if (isRefusal(work)) return refused(work);
  const { claim, project, donor } = work;
  const submission = await getSubmission(env.DB, claim.id);
  if (submission === null) {
    return refused(refusal('not_submitted', `Claim ${claim.id} has no submitted work to open a PR for. Submit it with submit_work.`));
  }
  if (project.settings.personWrittenDescription && input.description === undefined) {
    return refused(
      refusal(
        'description_required',
        `${project.repo} asks the donor to write the PR description. Ask them to write it, and pass it as description, word for word. Don't draft it.`,
      ),
    );
  }
  // Claims cleared to open, with no PR yet, count as open PRs.
  const openPrs =
    ((await countOpenPrsByProject(env.DB, donor.githubId)).get(lower(project.repo)) ?? 0) +
    ((await countClearedByProject(env.DB, donor.githubId, now, claim.id)).get(lower(project.repo)) ?? 0);
  const capped = openPrRefusal(project, openPrs);
  if (capped) return refused(capped);

  const reads = new BranchReader(await tokenOf(caller));
  const facts = await codeRepo(reads, project);
  if (isRefusal(facts)) return refused(facts);
  // The issue is checked on GitHub as submit_work checks it, and a failing
  // one clears nothing. GitHub is checked for a PR on the issue too, but the
  // donor decides whether a second one helps, so that doesn't stop them.
  const checked = await checkIssueFacts(env.DB, reads.reader, project, claim.issue, ownIssue(donor, NOT_CLEARED));
  if (!checked.ok) return refused(checked.refusal);
  const names = checked.issue.repo === null ? [facts.name] : [facts.name, checked.issue.repo];
  const [prOnIssue = null] = await otherPrs(reads, work, names);
  // The PR is public, so a key or token in the donor's words goes to it only
  // as [redacted], as in the rest of the PR's body.
  const description = input.description === undefined ? undefined : stripSecretsFromText(input.description);
  // The branch clears only at the head its submit checked.
  const head = await reads.branchHead(submission.repo, submission.branch);
  if (head !== submission.commit) {
    const at = typeof head === 'string' ? `is at ${head}` : 'is gone';
    return refused(
      refusal('branch_moved', `${submission.repo}:${submission.branch} ${at}, and its submit checked ${submission.commit}, so nothing was cleared. Submit the branch again, then clear it with open_pr.`),
    );
  }
  const toOpen = await clear(submission, work, facts, description, now);
  return { ok: true, value: { claimId: claim.id, issue: claim.issue, state: claim.state, toOpen, prOnIssue } };
}

export async function openPr(caller: Caller, input: ToolInput<'open_pr'>, now: number): Promise<Answer> {
  const opened = await openPrAs(caller, input, now);
  return opened.ok ? answer(toolResult('open_pr', opened.value)) : refuse(opened.refusal);
}

/**
 * Records a PR the agent opened for cleared work on the claim: its room
 * first, with when GitHub made it, so a PR made before the claim expired
 * counts, then the PRs table, whose job follows it. A second record of the
 * same PR changes nothing.
 */
export async function recordPull(claim: ClaimRecord, pull: PullFacts): Promise<{ claim: ClaimRecord; pr: PrRef } | Refusal> {
  const pr: PrRef = { repo: pull.baseRepo, number: pull.number, url: pull.url };
  const room = issueRoom(env.ISSUE_ROOM, claim.issue);
  const opened = await room.openPr({ claimId: claim.id, githubId: claim.githubId, pr, madeAt: pull.createdAt });
  if (opened.ok) {
    await addPr(env.DB, { claimId: claim.id, pr, openedAt: pull.createdAt });
    return { claim: opened.claim, pr };
  }
  const held = (await room.snapshot()).claims.find((c) => c.id === claim.id);
  if (opened.refusal.code === 'pr_already_opened' && held?.pr != null && samePr(held.pr, pr)) {
    await addPr(env.DB, { claimId: claim.id, pr, openedAt: pull.createdAt });
    return { claim: held, pr };
  }
  return opened.refusal;
}

/**
 * What a PR must be to count for the cleared claim: from its branch at the
 * cleared head, into the code repo's default branch, by the claimant, with
 * the closing line, the disclosure, and a description the donor wrote.
 * record_pr and the job that records cleared PRs (src/sync/cleared.ts)
 * check with it.
 */
export function clearedPrOf(
  claim: ClaimRecord,
  project: ProjectRecord,
  submission: SubmissionRecord,
  clearance: NonNullable<SubmissionRecord['clearance']>,
  codeRepo: string,
  defaultBranch: string,
): ClearedPr {
  return {
    codeRepo,
    defaultBranch,
    repo: submission.repo,
    branch: submission.branch,
    commit: clearance.commit,
    githubId: claim.githubId,
    issue: claim.issue,
    disclosure: project.settings.disclosure,
    description: project.settings.personWrittenDescription ? openingOf(clearance.body, closingLine(claim.issue, codeRepo)) : null,
  };
}

/** The part of a PR body `prBody` wrote before its closing line: the description. */
function openingOf(body: string, closing: string): string {
  const at = body.indexOf(`\n\n${closing}`);
  return at === -1 ? body : body.slice(0, at);
}

/** A PR's repo and number from its link on GitHub, or null for another link. */
function pullOf(url: string): { repo: string; number: number } | null {
  const web = gitHubUrls().web.replace(/\/+$/, '');
  if (!url.startsWith(`${web}/`)) return null;
  const match = /^([^/]+)\/([^/]+)\/pull\/([0-9]+)\/?$/.exec(url.slice(web.length + 1));
  if (match === null) return null;
  return { repo: `${match[1] ?? ''}/${match[2] ?? ''}`, number: Number(match[3]) };
}

/**
 * record_pr: the PR the agent opened for work open_pr cleared, read with the
 * donor's token and checked against the clearance before it is recorded.
 */
export async function recordPr(caller: Caller, input: ToolInput<'record_pr'>): Promise<Answer> {
  const found = await ownClaim(caller, input.claimId);
  if (isRefusal(found)) return refuse(found);
  const donor = await donorOf(caller);
  const blocked = await blockedRefusal(env.DB, donor);
  if (blocked) return refuse(blocked);
  const project = await getProject(env.DB, found.project);
  if (project === null) return refuse(refusal('not_found', `${found.project} is no longer a project.`));
  const claim = (await issueRoom(env.ISSUE_ROOM, found.issue).snapshot()).claims.find((held) => held.id === found.id) ?? found;
  const result = (recorded: { claim: ClaimRecord; pr: PrRef }) =>
    answer(toolResult('record_pr', { claimId: claim.id, issue: claim.issue, state: recorded.claim.state, pr: recorded.pr }));
  const named = pullOf(input.pr);
  if (named === null) {
    return refuse(refusal('pr_mismatch', `${input.pr} isn't a link to a PR on GitHub, so nothing was recorded. Send the PR's link, like ${gitHubUrls().web}/owner/repo/pull/12.`));
  }
  if (claim.pr !== null) {
    if (lower(claim.pr.repo) !== lower(named.repo) || claim.pr.number !== named.number) {
      return refuse(refusal('pr_already_opened', `Claim ${claim.id} already has its PR, ${claim.pr.url}.`));
    }
    // A record the PRs table missed, as when a call died after the room took it, is added now.
    if ((await getPr(env.DB, claim.id)) === null) await addPr(env.DB, { claimId: claim.id, pr: claim.pr, openedAt: Date.now() });
    return result({ claim, pr: claim.pr });
  }
  const submission = await getSubmission(env.DB, claim.id);
  // Older work submitted with files records the same way once open_pr
  // clears it.
  if (submission === null || submission.clearance === null) {
    return refuse(refusal('not_cleared', `Claim ${claim.id}'s work isn't cleared to open, so nothing was recorded. Submit the pushed branch with submit_work, then clear it with open_pr.`));
  }
  const reads = new BranchReader(await tokenOf(caller));
  const facts = await codeRepo(reads, project);
  if (isRefusal(facts)) return refuse(facts);
  const pull = await reads.pull(named.repo, named.number);
  if (pull === null) return refuse(refusal('pr_mismatch', `GitHub shows no PR at ${input.pr}, so nothing was recorded.`));
  const mismatch = pullMismatch(pull, clearedPrOf(claim, project, submission, submission.clearance, facts.name, facts.defaultBranch));
  if (mismatch !== null) return refuse(refusal('pr_mismatch', `${mismatch} Nothing was recorded.`));
  const recorded = await recordPull(claim, pull);
  return isRefusal(recorded) ? refuse(recorded) : result(recorded);
}

/** Work in the donor's review queue, as my_work lists it and /me shows it. */
export type ReviewItem = ToolOutput<'my_work'>['readyToOpen'][number];

/**
 * How cleared work opens now: GitHub's form for its PR, aimed at the code
 * repo's default branch as it is now, or the donor's own PR, open from the
 * claim's branch and not recorded yet, kept apart from the other PRs on the
 * issue. A branch whose head moved from the cleared commit is refused, as
 * record_pr would refuse its PR.
 */
async function clearedToOpen(
  reads: BranchReader,
  project: ProjectRecord,
  submission: SubmissionRecord,
  clearance: NonNullable<SubmissionRecord['clearance']>,
  prs: PrRef[],
): Promise<{ toOpen: PrToOpen | null; prFromBranch: PrRef | null; prs: PrRef[] } | Refusal> {
  const facts = await codeRepo(reads, project);
  if (isRefusal(facts)) return facts;
  const head = await reads.branchHead(submission.repo, submission.branch);
  if (head !== clearance.commit) {
    const at = typeof head === 'string' ? `is at ${head.slice(0, 7)}` : 'is gone';
    return refusal(
      'branch_moved',
      `${submission.repo}:${submission.branch} ${at}, and open_pr cleared ${clearance.commit.slice(0, 7)}, so a PR from it wouldn't be recorded. Submit the branch again.`,
    );
  }
  const others: PrRef[] = [];
  let own: PrRef | null = null;
  for (const pr of prs) {
    const from = await reads.pullHead(pr.repo, pr.number);
    if (own === null && from?.ref === submission.branch && from.repo !== null && lower(from.repo) === lower(submission.repo)) own = pr;
    else others.push(pr);
  }
  return { toOpen: own === null ? prToOpen(facts, submission, clearance.body) : null, prFromBranch: own, prs: others };
}

/**
 * The donor's submitted work waiting for them to open its PR: their claims
 * awaiting review, as each one's room holds it now, with their latest
 * submits. Each names a PR open on the issue, from its room or, read with
 * the donor's token, from GitHub. Work open_pr cleared waits as
 * `ready_to_open`, with how to open its PR and the compare page link. One
 * whose PR can't be opened now says why, and nothing about it is read from
 * GitHub. my_work lists it with the token
 * of the donor's agent, and /me with the one from their sign-in on the site.
 */
export async function readyToOpen(caller: Caller, origin: string, now: number): Promise<ReviewItem[]> {
  const listed = (await listPersonClaims(env.DB, caller.githubId)).filter((claim) => holdsSlot(claim, now));
  const held = await Promise.all(
    listed.map(async (listedClaim) => {
      const snapshot = await issueRoom(env.ISSUE_ROOM, listedClaim.issue).snapshot();
      const claim = snapshot.claims.find((c) => c.id === listedClaim.id) ?? listedClaim;
      return { claim, roomPrs: snapshot.prs.filter((pr) => claim.pr === null || !samePr(pr, claim.pr)) };
    }),
  );
  const waiting = held.filter(({ claim }) => stateAt(claim, now) === 'awaiting_review');
  if (waiting.length === 0) return [];
  const submissions = await getSubmissions(
    env.DB,
    waiting.map(({ claim }) => claim.id),
  );
  const donor = await donorOf(caller);
  const blocked = await blockedRefusal(env.DB, donor);
  const reads = new BranchReader(await tokenOf(caller));
  const items: ReviewItem[] = [];
  for (const { claim, roomPrs } of waiting) {
    const submission = submissions.get(claim.id);
    if (submission === undefined) continue;
    const project = await getProject(env.DB, claim.project);
    let closed = blocked ?? (await projectClosedRefusal(env.DB, project, claim.project));
    let prs = roomPrs;
    let toOpen: PrToOpen | null = null;
    let prFromBranch: PrRef | null = null;
    // Older work submitted with files has the branch the server made, and
    // shows its link the same way.
    const cleared = submission.clearance;
    // The issue is checked on GitHub as open_pr checks it, so a failing one
    // says why it can't open. For cleared work, open_pr's check of its labels
    // and assignees stands, as record_pr takes its PR once maintainers
    // relabel or assign the issue (docs/specs/agent-submits.md). A read
    // GitHub refuses leaves work that isn't cleared openable, with the PRs
    // its room knows of. Cleared work then shows no link, and says to try
    // again. A refused token still ends the connection.
    if (closed === null && project !== null) {
      try {
        const rules = { ...ownIssue(donor, NOT_CLEARED), labelsAndAssigneesStand: cleared !== null };
        const checked = await checkIssueFacts(env.DB, reads.reader, project, claim.issue, rules);
        if (checked.ok) {
          prs = await otherPrs(reads, { claim, project, donor, roomPrs }, checked.issue.repo === null ? [] : [checked.issue.repo]);
        } else {
          closed = checked.refusal;
        }
        if (closed === null && cleared !== null) {
          const ready = await clearedToOpen(reads, project, submission, cleared, prs);
          if (isRefusal(ready)) closed = ready;
          else ({ toOpen, prFromBranch, prs } = ready);
        }
      } catch (error) {
        if (error instanceof GitHubError && error.status === 401) throw error;
        console.warn(`my_work could not read ${claim.issue} from GitHub.`, error);
        if (cleared !== null) {
          closed = refusal('github_refused', "GitHub couldn't be read for this work just now, so its link isn't shown. Try again in a minute.");
        }
      }
    }
    const copy = await getIssue(env.DB, claim.project, claim.issue);
    const expiresAt = claimDeadlines(claim).expiresAt;
    items.push({
      claimId: claim.id,
      issue: claim.issue,
      title: copy?.title ?? foldIssueTitle(submission.title),
      url: gitHubIssueUrl(claim.issue),
      liveUrl: liveUrl(origin, claim.issue),
      diffUrl: branchUrls(submission.repo, submission.branch, submission.diffFrom).diff,
      additions: submission.additions,
      deletions: submission.deletions,
      agent: submission.agent,
      model: submission.model,
      summary: submission.summary,
      checks: submission.checks,
      // Work open_pr cleared waits for its PR to open, whatever held it before.
      reviewReason: submission.clearance === null ? (submission.reviewReason ?? 'pr_refused') : 'ready_to_open',
      toOpen,
      prFromBranch,
      prOnIssue: prs[0] ?? null,
      expiresAt: new Date(expiresAt ?? now).toISOString(),
      personWrittenDescription: project?.settings.personWrittenDescription ?? false,
      openable: closed === null,
      reason: closed === null ? null : closed.message.slice(0, 500),
    });
  }
  return items;
}
