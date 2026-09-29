import {
  MAX_PR_TITLE,
  claimDeadlines,
  holdsSlot,
  nextClaimState,
  prTitle,
  toolResult,
  utf8Length,
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
  getSubmissions,
  listPersonClaims,
  saveSubmission,
  setReviewReason,
} from '../db';
import { checkIssueFacts, linkedPrs, readIssue, readRepoFacts, type GitHubIssue, type IssueRules, type RepoFacts } from '../donor/github';
import { GitHubError } from '../github';
import { blockedRefusal, openPrRefusal, projectClosedRefusal, type Donor } from '../donor/rules';
import { branchFor, commitMessage, isWorkflowPath, prBody, redacted, reviewReason } from '../donor/work';
import {
  DonorWriter,
  NOT_READY,
  WriteRefused,
  branchUrls,
  commitUrl,
  textBase64,
  type Addition,
  type Entry,
  type PathFacts,
} from '../donor/writes';
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

// submit_work and open_pr: finished work becomes a signed commit on the
// claim's branch, and then a PR, or waits in the donor's review queue for
// open_pr, or for the Open PR button on /me (src/me/page.ts), which opens it
// by the same rules. Every GitHub call runs with the donor's own token, for
// their own claim. The claim changes only in its issue's room, so the live
// feeds and the issue page see each submit and each PR. The rules are in
// docs/how-it-works.md, under The donor's tools.

/**
 * How long to wait between reads of a new fork, which GitHub makes in the
 * background. After the last wait, a fork still not ready refuses the
 * submit with fork_not_ready, and the agent calls again.
 */
export const FORK_WAITS_MS = [500, 1000, 2000] as const;

/** The most files GitHub lists in a comparison. */
const COMPARE_FILES = 300;

/** How many times a commit is tried when the branch moved since it was read. */
const COMMIT_TRIES = 3;

function samePr(a: PrRef, b: PrRef): boolean {
  return lower(a.repo) === lower(b.repo) && a.number === b.number;
}

/** Reads again after each wait while GitHub is still making the repo. */
async function whenReady<T>(read: () => Promise<T | typeof NOT_READY>): Promise<T | typeof NOT_READY> {
  let got = await read();
  for (const wait of FORK_WAITS_MS) {
    if (got !== NOT_READY) return got;
    await new Promise((resolve) => setTimeout(resolve, wait));
    got = await read();
  }
  return got;
}

function forkNotReady(repo: string): Refusal {
  return refusal(
    'fork_not_ready',
    `GitHub is still making ${repo}, the donor's fork, so nothing was committed. Call submit_work again in a minute, with the same files.`,
  );
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
async function otherPrs(writer: DonorWriter, work: Work, names: readonly string[]): Promise<PrRef[]> {
  const links = (await linkedPrs(writer.reader, work.project, work.claim.issue, names)) ?? [];
  const own = work.claim.pr;
  const found: PrRef[] = [];
  for (const pr of [...links.map((link) => link.pr), ...work.roomPrs]) {
    if (own !== null && samePr(pr, own)) continue;
    if (!found.some((known) => samePr(known, pr))) found.push(pr);
  }
  return found;
}

interface Change {
  additions: Addition[];
  deletions: string[];
}

/**
 * What a mode other than a plain file's makes a path. createCommitOnBranch
 * writes every file as a plain file, 100644, so a change to one of these
 * would lose what it is. Each is known by the number its octal mode reads
 * as, and by its digits read in decimal, since GitHub doesn't say which it
 * gives.
 */
const KEPT_MODES = new Map<number, string>([
  [0o100755, 'an executable file'],
  [100755, 'an executable file'],
  [0o120000, 'a symbolic link'],
  [120000, 'a symbolic link'],
  [0o160000, 'a submodule'],
  [160000, 'a submodule'],
]);

/** The refusal for a change to a path whose mode a commit would lose, or null. `where` is where the entry is. */
function modeRefusal(path: string, entry: Entry | null, where: string): Refusal | null {
  const kind = entry === null ? undefined : KEPT_MODES.get(entry.mode);
  if (kind === undefined) return null;
  return refusal(
    'file_mode',
    `${path} is ${kind} in ${where}, and submit_work changes only plain files, so nothing was committed. Tell the donor, who can change it with Git themselves, and submit the rest without it.`,
  );
}

/**
 * The refusal for a path the commit can't write as a plain file, whatever
 * its text, or null: one under a file, a symbolic link, or a submodule, a
 * folder, or a new path that differs from one there only in case or
 * accents. `adding` is true when the path would get text.
 */
function pathRefusal(path: string, facts: PathFacts | undefined, where: string, adding: boolean): Refusal | null {
  if (facts === undefined) return null;
  const { under, entry, twin } = facts;
  if (under !== null && adding) {
    const kept = KEPT_MODES.get(under.entry.mode);
    const kind = kept === undefined || kept === 'an executable file' ? 'a file' : kept;
    return refusal(
      kind === 'a file' ? 'path_conflict' : 'file_mode',
      `${under.path} is ${kind} in ${where}, so ${path} can't go under it, and nothing was committed. Send ${path} somewhere else, or leave it out.`,
    );
  }
  if (entry !== null && !entry.file) {
    return refusal(
      'path_conflict',
      `${path} is a folder in ${where}, and submit_work takes files, so nothing was committed. Send each file under it that changed, by its own path.`,
    );
  }
  if (twin !== null && entry === null && adding) {
    return refusal(
      'path_conflict',
      `${twin.path} differs only in case or accents from ${twin.twin} in ${where}, and on macOS and Windows the two are one name, which breaks a checkout there, so nothing was committed. Use ${twin.twin}, or another name.`,
    );
  }
  return null;
}

/**
 * What the commit changes so the branch holds each file as submitted, and
 * each file an earlier submit sent and this one leaves out as it was at the
 * base. A file the branch already holds as submitted, and a deletion of a
 * file the branch doesn't have, change nothing and are left out. `at` is
 * the branch now, and `base` the commit the files are read against. A
 * change to an executable file, a symbolic link, or a submodule is
 * refused, since the commit would make it a plain file.
 */
async function planChange(
  writer: DonorWriter,
  at: { repo: string; rev: string; where: string },
  base: { repo: string; rev: string; where: string },
  files: readonly { path: string; content: string | null }[],
  putBack: readonly string[],
  /** The branch before a push that `at` holds and onto built on, or null. */
  pushedOver: { repo: string; rev: string } | null = null,
): Promise<Change | Refusal> {
  const facts = await writer.entries(at.repo, at.rev, [...files.map((file) => file.path), ...putBack]);
  for (const file of files) {
    const blocked = pathRefusal(file.path, facts.get(file.path), at.where, file.content !== null);
    if (blocked) return blocked;
  }
  if (pushedOver !== null) {
    const undone = await undoingPush(writer, pushedOver, facts, files);
    if (undone.reverted.length + undone.restored.length > 0) return undoesPush(at.where, at.rev, undone);
  }
  const entries = new Map([...facts].map(([path, found]) => [path, found.entry]));
  // A file whose text may be the one submitted: one of the same size.
  const sameSize = files.filter((file) => {
    const entry = entries.get(file.path);
    return file.content !== null && entry?.file === true && entry.byteSize === utf8Length(file.content);
  });
  const texts = sameSize.length === 0 ? new Map<string, string | null>() : await writer.texts(at.repo, at.rev, sameSize.map((file) => file.path));
  const change: Change = { additions: [], deletions: [] };
  for (const file of files) {
    const entry = entries.get(file.path) ?? null;
    const changes = file.content === null ? entry?.file === true : texts.get(file.path) !== file.content;
    if (!changes) continue;
    const kept = modeRefusal(file.path, entry, at.where);
    if (kept) return kept;
    if (file.content === null) change.deletions.push(file.path);
    else change.additions.push({ path: file.path, contents: textBase64(file.content) });
  }
  if (putBack.length > 0) {
    const atBase = await writer.entries(base.repo, base.rev, putBack);
    for (const path of putBack) {
      const now = entries.get(path) ?? null;
      const was = atBase.get(path)?.entry ?? null;
      if (was?.oid === now?.oid) continue;
      const kept =
        pathRefusal(path, facts.get(path), at.where, was?.file === true) ??
        modeRefusal(path, now, at.where) ??
        modeRefusal(path, was, base.where);
      if (kept) return kept;
      if (was?.file === true) change.additions.push({ path, contents: await writer.blob(base.repo, was.oid) });
      else if (now?.file === true) change.deletions.push(path);
    }
  }
  return change;
}

/** What a submit would undo of a push, by path, in the order the paths were sent. */
interface Undone {
  /** Paths the push changed that go back to how they were before it: sent with their text from then, or deleted when the push added them. */
  reverted: string[];
  /** Paths the push deleted, or moved away as in a rename, that come back with any text. */
  restored: string[];
}

/**
 * The submitted paths a commit would undo a push with. `before` is the
 * branch before the push, and `now` what each path is at the head the push
 * left. A path there before and gone now was deleted or moved by the push,
 * whatever the comparison calls it.
 */
async function undoingPush(
  writer: DonorWriter,
  before: { repo: string; rev: string },
  now: Map<string, PathFacts>,
  files: readonly { path: string; content: string | null }[],
): Promise<Undone> {
  const was = await writer.entries(before.repo, before.rev, files.map((file) => file.path));
  const pushed = files.filter((file) => (was.get(file.path)?.entry?.oid ?? null) !== (now.get(file.path)?.entry?.oid ?? null));
  const gone = (path: string) => (was.get(path)?.entry ?? null) !== null && (now.get(path)?.entry ?? null) === null;
  const restored = new Set(pushed.filter((file) => file.content !== null && gone(file.path)).map((file) => file.path));
  const reverted = new Set(
    pushed.filter((file) => file.content === null && (was.get(file.path)?.entry ?? null) === null).map((file) => file.path),
  );
  const sameSize = pushed.filter((file) => {
    const entry = was.get(file.path)?.entry;
    return file.content !== null && !restored.has(file.path) && entry?.file === true && entry.byteSize === utf8Length(file.content);
  });
  if (sameSize.length > 0) {
    const texts = await writer.texts(before.repo, before.rev, sameSize.map((file) => file.path));
    for (const file of sameSize) if (texts.get(file.path) === file.content) reverted.add(file.path);
  }
  const paths = files.map((file) => file.path);
  return { reverted: paths.filter((path) => reverted.has(path)), restored: paths.filter((path) => restored.has(path)) };
}

/** Paths as a list in words: `a`, `a and b`, or `a, b and c`. */
function named(paths: readonly string[]): string {
  return paths.length === 1 ? paths.join('') : `${paths.slice(0, -1).join(', ')} and ${paths.slice(-1).join('')}`;
}

/** `where` is the branch, as `owner/repo:branch`, and `head` the head the push left. */
function undoesPush(where: string, head: string, { reverted, restored }: Undone): Refusal {
  const it = (paths: readonly string[]) => (paths.length === 1 ? 'it' : 'them');
  const clauses = [
    reverted.length > 0 && `${named(reverted)} would go back to how ${reverted.length === 1 ? 'it was' : 'they were'} before the push`,
    restored.length > 0 && `${named(restored)} would come back, though the push deleted or moved ${it(restored)}`,
  ].filter((clause) => clause !== false);
  const again = reverted.length > 0 ? `, or send new text for ${named(reverted)}` : '';
  return refusal(
    'branch_moved',
    `Someone pushed to ${where}, whose head is ${head}, and this submit would undo it: ${clauses.join(', and ')}. Nothing was committed. Leave ${it([...reverted, ...restored])} out, so the push's change stays${again}.`,
  );
}

function branchMoved(repo: string, branch: string, head: string): Refusal {
  return refusal(
    'branch_moved',
    `${repo}:${branch} is at ${head}, a commit the claim's submits didn't make, so someone pushed to the branch since the last submit. Nothing was committed, so that work stays. Fetch the branch, bring your work onto ${head}, and submit again with onto set to ${head}, sending every file changed from it.`,
  );
}

function noBranchForOnto(repo: string, branch: string): Refusal {
  return refusal(
    'branch_moved',
    `onto names the head of the claim's branch, and ${repo}:${branch} isn't there, so there is no head to build on, and nothing was committed. Submit again without onto.`,
  );
}

/**
 * Whether `head` is a commit the donor made on `expected`, as a submit that
 * died after its commit leaves one: its one parent is `expected`, and GitHub
 * names the donor its author.
 */
async function ownCommitOn(writer: DonorWriter, repo: string, head: string, expected: string, donor: string): Promise<boolean> {
  const facts = await writer.commitFacts(repo, head);
  return (
    facts !== null &&
    facts.parents.length === 1 &&
    facts.parents[0] === expected &&
    facts.author !== null &&
    lower(facts.author) === lower(donor)
  );
}

/**
 * Commits the files to the claim's branch, making the branch at the base
 * first when it isn't there, and waiting for a new fork. A commit the claim's
 * submits didn't make at the branch's head stops the submit, so no one
 * else's work is written over. The one exception is a commit of the donor's
 * own on the expected head that already holds the files, as a submit that
 * died after its commit leaves: that commit is the submit's, and none is
 * made. When the branch moves between the read and the commit, the branch
 * is read again.
 */
async function commitWork(
  writer: DonorWriter,
  input: {
    target: string;
    branch: string;
    /** The commit the files are read against, and where a branch not made yet starts. */
    base: { repo: string; rev: string; where: string };
    /** Where the branch should be: the last submit's commit, the head the agent named with onto, or the base. */
    expected: string;
    /** The head the agent built on, which the branch must be at, or undefined. */
    onto: string | undefined;
    /** The branch before the push onto built on, or null when onto names no one else's push. */
    pushedOver: { repo: string; rev: string } | null;
    donor: string;
    files: readonly { path: string; content: string | null }[];
    putBack: readonly string[];
    message: { headline: string; body: string };
  },
): Promise<{ sha: string; recovered: boolean } | Refusal> {
  const { target, branch, base, expected } = input;
  for (let tries = 0; tries < COMMIT_TRIES; tries++) {
    const head = await whenReady(() => writer.branchHead(target, branch));
    if (head === NOT_READY) return forkNotReady(target);
    // onto names a head of the branch, so with no branch there is nothing to
    // build on. A branch made at it would carry whatever commit it names.
    if (input.onto !== undefined && head === null) return noBranchForOnto(target, branch);
    const moved = head !== null && head !== expected;
    if (moved && !(await ownCommitOn(writer, target, head, expected, input.donor))) return branchMoved(target, branch, head);
    const at = head === null ? base : { repo: target, rev: head, where: `${target}:${branch}` };
    const change = await planChange(writer, at, base, input.files, input.putBack, moved ? null : input.pushedOver);
    if (isRefusal(change)) return change;
    if (change.additions.length + change.deletions.length === 0) {
      if (moved) return { sha: head, recovered: true };
      const same = head === null ? `are as they were at ${base.where}` : `are as ${target}:${branch} holds them`;
      return refusal(
        'no_changes',
        `The files ${same}, so nothing was committed. Send every file changed from ${base.where}, with its full new text.`,
      );
    }
    // The donor's own commit, with other files than these: a push of theirs, which a commit would write over.
    if (moved) return branchMoved(target, branch, head);
    if (head === null) {
      const made = await whenReady(() => writer.createBranch(target, branch, base.rev));
      if (made === NOT_READY) return forkNotReady(target);
      // Made meanwhile, as by another submit of the claim: read it again.
      if (made === 'exists') continue;
    }
    const commit = await writer.commit({ repo: target, branch, expectedHead: head ?? base.rev, ...change, ...input.message });
    if (commit !== 'stale') return { ...commit, recovered: false };
  }
  return refusal('github_refused', `${target}:${branch} kept moving while the commit was made, so nothing was committed. Submit again.`);
}

/** Where a PR comes from: the branch in the repo, or `owner:branch` in the donor's fork. */
function pullHead(submission: SubmissionRecord, upstream: string): string {
  if (lower(submission.repo) === lower(upstream)) return submission.branch;
  return `${submission.repo.slice(0, submission.repo.indexOf('/'))}:${submission.branch}`;
}

/**
 * Opens the claim's PR as the donor, and records it: the claim's room first,
 * so the issue takes no new claims, then the PRs table, whose job follows it
 * until it merges or closes.
 */
async function openFor(
  writer: DonorWriter,
  work: Work,
  facts: RepoFacts & { defaultBranch: string },
  submission: SubmissionRecord,
  description: string | undefined,
): Promise<{ claim: ClaimRecord; pr: PrRef } | Refusal> {
  const { claim, project } = work;
  let pr: PrRef;
  try {
    pr = await writer.openPull(facts.name, {
      title: submission.title,
      body: prBody({
        description,
        summary: submission.summary,
        checks: submission.checks,
        agent: submission.agent,
        model: submission.model,
        issue: claim.issue,
        codeRepo: facts.name,
        disclosure: project.settings.disclosure,
      }),
      head: pullHead(submission, facts.name),
      base: facts.defaultBranch,
    });
  } catch (error) {
    if (error instanceof WriteRefused) return refusal('github_refused', `${error.message} The work stays on its branch.`);
    throw error;
  }
  const room = issueRoom(env.ISSUE_ROOM, claim.issue);
  const opened = await room.openPr({ claimId: claim.id, githubId: claim.githubId, pr });
  if (opened.ok) {
    await addPr(env.DB, { claimId: claim.id, pr, openedAt: Date.now() });
    return { claim: opened.claim, pr };
  }
  // A call at the same moment opened the same PR from the same branch, and
  // GitHub gave it to both.
  const held = (await room.snapshot()).claims.find((c) => c.id === claim.id);
  if (opened.refusal.code === 'pr_already_opened' && held?.pr != null && samePr(held.pr, pr)) {
    await addPr(env.DB, { claimId: claim.id, pr, openedAt: Date.now() });
    return { claim: held, pr };
  }
  return { ...opened.refusal, message: `${opened.refusal.message} GitHub opened ${pr.url} all the same.` };
}

/**
 * What checkIssueFacts lets through for a donor's own work: the issue may be
 * assigned to them, as a maintainer does for someone on it, and to no one
 * else. `next` says what the agent does when the issue fails.
 */
function ownIssue(donor: Donor, next: string): IssueRules {
  return { assignee: donor.login, next };
}

const NOT_COMMITTED = 'Nothing was committed. Stop with release_claim and a reason.';
const NOT_OPENED = 'The work stays on its branch, and no PR opened. Stop with release_claim and a reason.';

/** The code repo on GitHub as the donor sees it, or the refusal when it has no default branch to aim a PR at. */
async function codeRepo(writer: DonorWriter, project: ProjectRecord): Promise<(RepoFacts & { defaultBranch: string }) | Refusal> {
  const facts = await readRepoFacts(writer.reader, project.repo);
  if (facts === null || facts.defaultBranch === null) {
    return refusal('project_not_open', `GitHub shows you no public repo named ${project.repo} with a branch to aim a PR at, so nothing was sent.`);
  }
  return { ...facts, defaultBranch: facts.defaultBranch };
}

export async function submitWork(
  caller: Caller,
  input: ToolInput<'submit_work'>,
  now: number,
): Promise<Answer> {
  const work = await workOn(caller, input.claimId, { kind: 'submit' }, now);
  if (isRefusal(work)) return refuse(work);
  const { claim, project, donor } = work;
  const writer = new DonorWriter(await tokenOf(caller));
  const facts = await codeRepo(writer, project);
  if (isRefusal(facts)) return refuse(facts);
  // Before anything is written, the issue is checked on GitHub as a claim
  // checks it: GitHub shows it, it is open, it carries a tag and no
  // excluded tag, and no one else is assigned. A claim whose PR is open is
  // past that: the PR is the maintainers' to take or close, and they often
  // relabel or assign an issue once a PR is on it.
  let issue: GitHubIssue | null;
  if (claim.pr === null) {
    const checked = await checkIssueFacts(env.DB, writer.reader, project, claim.issue, ownIssue(donor, NOT_COMMITTED));
    if (!checked.ok) return refuse(checked.refusal);
    issue = checked.issue;
  } else {
    issue = await readIssue(writer.reader, claim.issue);
  }
  const earlier = await getSubmission(env.DB, claim.id);
  const branch = earlier?.branch ?? branchFor(claim);
  // The issue's title takes the agent's rules for one, so a line break in
  // it can't start a line of the commit message.
  const titled = prTitle.safeParse(input.title ?? issue?.title ?? (await getIssue(env.DB, project.repo, claim.issue))?.title);
  const title = redacted(titled.success ? titled.data : claim.issue, MAX_PR_TITLE);
  const summary = redacted(input.summary);
  const checks = redacted(input.checks);
  const model = redacted(input.model, 100);
  // Paths in a repo compare with case, as Git compares them.
  const submitted = new Set(input.files.map((file) => file.path));
  // The files are read against the start commit, or against the head a
  // submit built on with onto, after someone else pushed to the branch.
  const base = input.onto ?? earlier?.base ?? claim.startCommit;

  let committed: { sha: string; recovered: boolean } | Refusal;
  let target: string;
  try {
    // A claim's branch stays where its first submit put it. Otherwise it goes
    // in the code repo when the donor can push there, and in their fork when
    // they can't, each by their own permission.
    target = earlier?.repo ?? (facts.writer ? facts.name : await writer.fork(facts.name));
    committed = await commitWork(writer, {
      target,
      branch,
      // The code repo has the start commit. A head someone pushed is in the branch's repo.
      base:
        base === claim.startCommit
          ? { repo: facts.name, rev: base, where: 'the start commit' }
          : { repo: target, rev: base, where: `the commit ${base}` },
      expected: input.onto ?? earlier?.commit ?? claim.startCommit,
      onto: input.onto,
      // Where the branch was before the push onto names: the last submit's
      // commit, or the start commit before the first.
      pushedOver:
        input.onto === undefined || input.onto === (earlier?.commit ?? claim.startCommit)
          ? null
          : earlier === null
            ? { repo: facts.name, rev: claim.startCommit }
            : { repo: target, rev: earlier.commit },
      donor: donor.login,
      files: input.files,
      // A file goes back to the base. After onto, that is the head the branch is at.
      putBack: (earlier?.paths ?? []).filter((path) => !submitted.has(path)),
      message: commitMessage({ title, summary, agent: input.agent, model, disclosure: project.settings.disclosure }),
    });
  } catch (error) {
    if (!(error instanceof WriteRefused)) throw error;
    const workflows = input.files.some((file) => isWorkflowPath(file.path))
      ? " GitHub takes a change to a file under .github/workflows/ only from a token with the workflow scope, which Good First Token doesn't ask for. Leave that change out, and tell the donor to make it on GitHub themselves."
      : '';
    return refuse(refusal('github_refused', `${error.message} Nothing was committed.${workflows}`));
  }
  if (isRefusal(committed)) return refuse(committed);

  const room = issueRoom(env.ISSUE_ROOM, claim.issue);
  // A first submit its room recorded and the database didn't, as when a
  // call died between the two, is recorded once.
  const inRoom = committed.recovered && earlier === null && claim.submittedAt !== null;
  const recorded = inRoom
    ? ({ ok: true, claim } as const)
    : await room.submit({ claimId: claim.id, githubId: donor.githubId, tokenEstimate: input.tokenEstimate ?? null });
  if (!recorded.ok) {
    return refuse({
      ...recorded.refusal,
      message: `${recorded.refusal.message} The commit ${committed.sha.slice(0, 7)} is on ${target}:${branch} all the same.`,
    });
  }
  // The PR's own change: from where the branch parts from the default
  // branch, so main's changes an Update branch merged in don't count.
  const diffFrom = facts.head ?? claim.startCommit;
  const lines = await writer.lineCounts(target, diffFrom, committed.sha);
  const prs = await otherPrs(writer, work, issue?.repo ? [facts.name, issue.repo] : [facts.name]);
  const openPrs = (await countOpenPrsByProject(env.DB, donor.githubId)).get(lower(project.repo)) ?? 0;
  // Until onto builds on someone else's push, the branch holds only the
  // claim's submits, which change the submitted paths and no others. After
  // it, only GitHub's comparison names what the branch changes, so one too
  // long to list every file, or none at all, leaves the check undone.
  const pushedIn = base !== claim.startCommit;
  const unchecked = !pushedIn ? null : lines === null ? 'comparison_unread' : lines.files >= COMPARE_FILES ? 'too_many_files' : null;
  const reason =
    recorded.claim.state === 'pr_opened'
      ? null
      : reviewReason({
          prOnIssue: prs.length > 0,
          workflowFiles: input.files.some((file) => isWorkflowPath(file.path)) || (lines?.paths.some(isWorkflowPath) ?? false),
          unchecked,
          prMode: project.settings.prMode,
          personWrittenDescription: project.settings.personWrittenDescription,
          atOpenPrCap: openPrRefusal(project, openPrs) !== null,
        });
  const submission = await saveSubmission(env.DB, {
    claimId: claim.id,
    repo: target,
    branch,
    commit: committed.sha,
    base,
    diffFrom,
    paths: input.files.map((file) => file.path),
    title,
    summary,
    checks,
    agent: input.agent,
    model,
    additions: lines?.additions ?? null,
    deletions: lines?.deletions ?? null,
    reviewReason: reason,
    submittedAt: now,
  });

  const urls = branchUrls(target, branch, diffFrom);
  const result = (state: ClaimRecord['state'], pr: PrRef | null, why: ReviewReason | null) =>
    answer(
      toolResult('submit_work', {
        claimId: claim.id,
        issue: claim.issue,
        state,
        commit: { sha: committed.sha, url: commitUrl(target, committed.sha) },
        branch: { repo: target, name: branch, url: urls.branch },
        diffUrl: urls.diff,
        pr,
        reviewReason: why,
      }),
    );
  // A claim whose PR is open takes the commit on that PR's branch, which
  // answers the follow-ups on it a tool showed before this submit.
  if (recorded.claim.state === 'pr_opened') {
    await answerFollowUps(env.DB, claim.id, now);
    return result('pr_opened', recorded.claim.pr, null);
  }
  if (reason !== null) return result(recorded.claim.state, null, reason);
  const opened = await openFor(writer, { ...work, claim: recorded.claim }, facts, submission, undefined);
  if (!isRefusal(opened)) return result(opened.claim.state, opened.pr, null);
  console.warn(`Claim ${claim.id}'s PR didn't open by itself.`, opened.message);
  await setReviewReason(env.DB, claim.id, 'pr_refused');
  return result(recorded.claim.state, null, 'pr_refused');
}

/** What opening a claim's PR did: the PR, as open_pr answers with it, or why none opened. */
export type Opened = { ok: true; value: ToolOutput<'open_pr'> } | { ok: false; refusal: Refusal };

/**
 * Opens the PR for the caller's work in their review queue, by open_pr's
 * rules, with the caller's own GitHub token. The MCP tool and the Open PR
 * button on /me both call it: the tool with the token of the donor's agent,
 * the page with the one from their sign-in on the site. A claim that isn't
 * the caller's throws PermissionRefused, as every donor's tool does.
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
  const openPrs = (await countOpenPrsByProject(env.DB, donor.githubId)).get(lower(project.repo)) ?? 0;
  const capped = openPrRefusal(project, openPrs);
  if (capped) return refused(capped);

  const writer = new DonorWriter(await tokenOf(caller));
  const facts = await codeRepo(writer, project);
  if (isRefusal(facts)) return refused(facts);
  // The issue is checked on GitHub as submit_work checks it, and a failing
  // one opens no PR. GitHub is checked for a PR on the issue too, but the
  // donor decides whether a second one helps, so that doesn't stop them.
  const checked = await checkIssueFacts(env.DB, writer.reader, project, claim.issue, ownIssue(donor, NOT_OPENED));
  if (!checked.ok) return refused(checked.refusal);
  const names = checked.issue.repo === null ? [facts.name] : [facts.name, checked.issue.repo];
  const [prOnIssue = null] = await otherPrs(writer, work, names);
  const opened = await openFor(writer, work, facts, submission, input.description);
  if (isRefusal(opened)) return refused(opened);
  return { ok: true, value: { claimId: claim.id, issue: claim.issue, state: opened.claim.state, pr: opened.pr, prOnIssue } };
}

export async function openPr(caller: Caller, input: ToolInput<'open_pr'>, now: number): Promise<Answer> {
  const opened = await openPrAs(caller, input, now);
  return opened.ok ? answer(toolResult('open_pr', opened.value)) : refuse(opened.refusal);
}

/** Work in the donor's review queue, as my_work lists it and /me shows it. */
export type ReviewItem = ToolOutput<'my_work'>['readyToOpen'][number];

/**
 * The donor's submitted work waiting for them to open its PR: their claims
 * awaiting review, as each one's room holds it now, with their latest
 * submits. Each names a PR open on the issue, from its room or, read with
 * the donor's token, from GitHub. One whose PR can't be opened now says why,
 * and nothing about it is read from GitHub. my_work lists it with the token
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
  const writer = new DonorWriter(await tokenOf(caller));
  const items: ReviewItem[] = [];
  for (const { claim, roomPrs } of waiting) {
    const submission = submissions.get(claim.id);
    if (submission === undefined) continue;
    const project = await getProject(env.DB, claim.project);
    let closed = blocked ?? (await projectClosedRefusal(env.DB, project, claim.project));
    let prs = roomPrs;
    // The issue is checked on GitHub as open_pr checks it, so a failing one
    // says why it can't open. A read GitHub refuses leaves the item openable,
    // with the PRs its room knows of. A refused token still ends the
    // connection.
    if (closed === null && project !== null) {
      try {
        const checked = await checkIssueFacts(env.DB, writer.reader, project, claim.issue, ownIssue(donor, NOT_OPENED));
        if (checked.ok) {
          prs = await otherPrs(writer, { claim, project, donor, roomPrs }, checked.issue.repo === null ? [] : [checked.issue.repo]);
        } else {
          closed = checked.refusal;
        }
      } catch (error) {
        if (error instanceof GitHubError && error.status === 401) throw error;
        console.warn(`my_work could not read ${claim.issue} from GitHub.`, error);
      }
    }
    const copy = await getIssue(env.DB, claim.project, claim.issue);
    const expiresAt = claimDeadlines(claim).expiresAt;
    items.push({
      claimId: claim.id,
      issue: claim.issue,
      title: copy?.title ?? submission.title,
      url: gitHubIssueUrl(claim.issue),
      liveUrl: liveUrl(origin, claim.issue),
      diffUrl: branchUrls(submission.repo, submission.branch, submission.diffFrom).diff,
      additions: submission.additions,
      deletions: submission.deletions,
      agent: submission.agent,
      model: submission.model,
      summary: submission.summary,
      checks: submission.checks,
      reviewReason: submission.reviewReason ?? 'pr_refused',
      prOnIssue: prs[0] ?? null,
      expiresAt: new Date(expiresAt ?? now).toISOString(),
      personWrittenDescription: project?.settings.personWrittenDescription ?? false,
      openable: closed === null,
      reason: closed === null ? null : closed.message.slice(0, 500),
    });
  }
  return items;
}
