// The fake's data and the GitHub behaviors that change it. REST, GraphQL,
// and the sample data all go through these functions, so a fork or a
// commit behaves the same whichever way it was made.
//
// The state is plain JSON, so the local server can save it to disk and a
// test can read or change any part of it.

import {
  isAncestor,
  listFiles,
  readObject,
  writeBlob,
  writeCommit,
  writeTree,
  type GitPerson,
  type ObjectStore,
  type Oid,
} from './git.ts';

export type Role = 'admin' | 'maintain' | 'write' | 'triage' | 'read';

export interface Account {
  login: string;
  id: number;
  type: 'User' | 'Organization';
  name: string;
  createdAt: string;
}

export interface LabelRecord {
  id: number;
  name: string;
  color: string;
  description: string | null;
  default: boolean;
}

export interface TimelineEvent {
  id: number;
  event: 'labeled' | 'unlabeled' | 'assigned' | 'cross-referenced' | 'closed' | 'reopened' | 'merged';
  actor: string;
  createdAt: string;
  label?: { name: string; color: string };
  assignee?: string;
  source?: { repo: string; number: number };
  stateReason?: string | null;
  commitId?: Oid;
}

export type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED';

export interface ReviewRecord {
  id: number;
  user: string;
  state: ReviewState;
  body: string;
  submittedAt: string;
  commitId: Oid;
}

export interface ReviewCommentRecord {
  id: number;
  reviewId: number;
  user: string;
  body: string;
  path: string;
  line: number;
  commitId: Oid;
  createdAt: string;
}

export interface PullData {
  id: number;
  head: { repo: string | null; ref: string; sha: Oid; owner: string };
  base: { ref: string; sha: Oid };
  draft: boolean;
  mergedAt: string | null;
  mergedBy: string | null;
  mergeCommitSha: Oid | null;
  maintainerCanModify: boolean;
  reviews: ReviewRecord[];
  reviewComments: ReviewCommentRecord[];
}

export interface IssueRecord {
  id: number;
  number: number;
  title: string;
  body: string | null;
  user: string;
  labels: string[];
  assignees: string[];
  state: 'open' | 'closed';
  stateReason: 'completed' | 'not_planned' | 'reopened' | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  closedBy: string | null;
  comments: number;
  timeline: TimelineEvent[];
  pull: PullData | null;
}

export interface RepoRecord {
  id: number;
  owner: string;
  name: string;
  description: string | null;
  homepage: string | null;
  language: string | null;
  topics: string[];
  license: { key: string; name: string; spdx_id: string } | null;
  stars: number;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
  defaultBranch: string;
  archived: boolean;
  hasIssues: boolean;
  hasPullRequests: boolean;
  pullRequestCreationPolicy: 'all' | 'collaborators_only';
  forkOf: string | null;
  collaborators: Record<string, Role>;
  branches: Record<string, Oid>;
  labels: LabelRecord[];
  issues: Record<string, IssueRecord>;
  nextNumber: number;
}

export interface TokenRecord {
  login: string;
  scopes: string[];
  clientId: string | null;
}

export interface OAuthAppRecord {
  name: string;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

export interface OAuthCodeRecord {
  clientId: string;
  login: string;
  redirectUri: string | null;
  scopes: string[];
  codeChallenge: string | null;
  expiresAt: string;
}

export interface FakeState {
  version: 1;
  nextId: number;
  accounts: Record<string, Account>;
  repos: Record<string, RepoRecord>;
  objects: ObjectStore;
  tokens: Record<string, TokenRecord>;
  oauthApps: Record<string, OAuthAppRecord>;
  oauthCodes: Record<string, OAuthCodeRecord>;
}

export interface ValidationError {
  resource: string;
  code: string;
  field?: string;
  message?: string;
}

// A refusal, in terms both the REST and GraphQL layers can report.
export class FakeError extends Error {
  kind: 'not_found' | 'forbidden' | 'invalid' | 'stale';
  errors: ValidationError[];

  constructor(kind: FakeError['kind'], message: string, errors: ValidationError[] = []) {
    super(message);
    this.kind = kind;
    this.errors = errors;
  }
}

export const key = (name: string) => name.toLowerCase();

export function newId(state: FakeState): number {
  return state.nextId++;
}

export function fullName(repo: RepoRecord): string {
  return `${repo.owner}/${repo.name}`;
}

export function findAccount(state: FakeState, login: string): Account | null {
  return state.accounts[key(login)] ?? null;
}

export function getAccount(state: FakeState, login: string): Account {
  const account = findAccount(state, login);
  if (!account) throw new Error(`the fake has no account ${login}`);
  return account;
}

export function findRepo(state: FakeState, owner: string, name: string): RepoRecord | null {
  return state.repos[key(`${owner}/${name}`)] ?? null;
}

export function findRepoByFullName(state: FakeState, name: string): RepoRecord | null {
  return state.repos[key(name)] ?? null;
}

export function findIssue(repo: RepoRecord, number: number): IssueRecord | null {
  return repo.issues[String(number)] ?? null;
}

// The person's role on a repo. Anyone signed in can read a public repo. A
// repo's owner is its admin. Everyone else gets the role they were given.
export function roleOf(repo: RepoRecord, login: string | null): Role | null {
  if (login === null) return null;
  if (key(repo.owner) === key(login)) return 'admin';
  return repo.collaborators[key(login)] ?? 'read';
}

export function canPush(role: Role | null): boolean {
  return role === 'admin' || role === 'maintain' || role === 'write';
}

export function permissions(role: Role) {
  return {
    admin: role === 'admin',
    maintain: role === 'admin' || role === 'maintain',
    push: canPush(role),
    triage: role !== 'read',
    pull: true,
  };
}

export function requirePush(repo: RepoRecord, login: string | null): void {
  if (!canPush(roleOf(repo, login))) throw new FakeError('not_found', 'Not Found');
}

// GitHub keeps a person's email private behind a noreply address.
export function gitPerson(state: FakeState, login: string, date: string): GitPerson {
  const account = getAccount(state, login);
  return {
    name: account.name,
    email: `${String(account.id)}+${account.login}@users.noreply.github.com`,
    date,
    login: account.login,
  };
}

// Commits made through the API are committed and signed by GitHub itself.
export function webFlow(date: string): GitPerson {
  return { name: 'GitHub', email: 'noreply@github.com', date, login: 'web-flow' };
}

export function networkRoot(state: FakeState, repo: RepoRecord): RepoRecord {
  let root = repo;
  while (root.forkOf) {
    const parent = findRepoByFullName(state, root.forkOf);
    if (!parent) break;
    root = parent;
  }
  return root;
}

export function forkOf(state: FakeState, repo: RepoRecord, login: string): RepoRecord | null {
  const root = networkRoot(state, repo);
  return (
    Object.values(state.repos).find(
      (r) => key(r.owner) === key(login) && r.forkOf !== null && networkRoot(state, r) === root,
    ) ?? null
  );
}

// Forks a repo into the person's account. A person who already has a fork
// of the repo gets that fork back, as on GitHub.
export function forkRepo(
  state: FakeState,
  parent: RepoRecord,
  login: string,
  options: { name?: string; defaultBranchOnly?: boolean },
  now: string,
): RepoRecord {
  const existing = forkOf(state, parent, login);
  if (existing) return existing;
  const owner = getAccount(state, login).login;
  let name = options.name ?? parent.name;
  for (let n = 1; findRepo(state, owner, name); n++) name = `${options.name ?? parent.name}-${String(n)}`;
  const branches = options.defaultBranchOnly
    ? { [parent.defaultBranch]: parent.branches[parent.defaultBranch] as Oid }
    : { ...parent.branches };
  const fork: RepoRecord = {
    ...parent,
    id: newId(state),
    owner,
    name,
    topics: [],
    stars: 0,
    createdAt: now,
    updatedAt: now,
    hasIssues: false,
    hasPullRequests: true,
    pullRequestCreationPolicy: 'all',
    forkOf: fullName(parent),
    collaborators: {},
    branches,
    labels: [],
    issues: {},
    nextNumber: 1,
  };
  state.repos[key(fullName(fork))] = fork;
  return fork;
}

export interface FileChanges {
  additions: { path: string; contents: string | Uint8Array }[];
  deletions: string[];
}

// Adds a commit to a branch as the person, the way createCommitOnBranch
// does: the person is the author, and GitHub commits and signs it.
export function commitOnBranch(
  state: FakeState,
  repo: RepoRecord,
  branch: string,
  change: FileChanges & { headline: string; body?: string | null; login: string; expectedHeadOid?: Oid },
  now: string,
): Oid {
  const head = repo.branches[branch];
  if (head === undefined) {
    throw new FakeError('not_found', `A ref named "refs/heads/${branch}" does not exist in ${fullName(repo)}.`);
  }
  if (change.expectedHeadOid !== undefined && change.expectedHeadOid !== head) {
    throw new FakeError(
      'stale',
      `Expected branch to point to "${change.expectedHeadOid}" but it did not. Pull and try again.`,
    );
  }
  const files = listFiles(state.objects, readObject(state.objects, head, 'commit').tree);
  for (const path of change.deletions) {
    if (!files.delete(path)) {
      throw new FakeError(
        'invalid',
        `A path was requested for deletion which does not exist as of commit oid \`${head}\``,
      );
    }
  }
  for (const { path, contents } of change.additions) files.set(path, writeBlob(state.objects, contents));
  const message = change.body ? `${change.headline}\n\n${change.body}` : change.headline;
  const oid = writeCommit(state.objects, {
    tree: writeTree(state.objects, files),
    parents: [head],
    message,
    author: gitPerson(state, change.login, now),
    committer: webFlow(now),
    signedByGitHub: true,
  });
  repo.branches[branch] = oid;
  repo.pushedAt = now;
  repo.updatedAt = now;
  return oid;
}

const MENTION = /(?:^|[^\w/.-])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g;
const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/gi;

function references(pattern: RegExp, text: string, repo: string) {
  return [...text.matchAll(pattern)].map((m) => ({ repo: m[1] ?? repo, number: Number(m[2]) }));
}

// Issues a PR says it closes, with GitHub's closing keywords.
export function closingReferences(text: string, repo: string) {
  return references(CLOSING, text, repo);
}

export interface OpenPullInput {
  title: string;
  body: string | null;
  head: string;
  headRepo?: string;
  base: string;
  draft?: boolean;
  maintainerCanModify?: boolean;
  login: string;
  number?: number;
}

function invalid(errors: ValidationError[]): FakeError {
  return new FakeError('invalid', 'Validation Failed', errors);
}

// Opens a pull request the way GitHub checks one: the head branch has
// commits the base lacks, and no open PR already comes from it. Every issue
// the PR mentions gets a cross-referenced event on its timeline.
export function openPull(state: FakeState, base: RepoRecord, input: OpenPullInput, now: string): IssueRecord {
  if (!base.hasPullRequests) throw new FakeError('forbidden', 'Pull requests are disabled for this repository.');
  if (base.pullRequestCreationPolicy === 'collaborators_only' && !canPush(roleOf(base, input.login))) {
    throw new FakeError('forbidden', 'Only collaborators can create pull requests in this repository.');
  }
  if (!input.title) throw invalid([{ resource: 'PullRequest', code: 'missing_field', field: 'title' }]);
  const colon = input.head.indexOf(':');
  const headOwner = colon === -1 ? base.owner : input.head.slice(0, colon);
  const branch = colon === -1 ? input.head : input.head.slice(colon + 1);
  const headRepo = input.headRepo
    ? findRepoByFullName(state, input.headRepo)
    : key(headOwner) === key(base.owner)
      ? base
      : forkOf(state, base, headOwner);
  // The head must be the base repo or a fork in the same network.
  if (input.headRepo && (!headRepo || networkRoot(state, headRepo) !== networkRoot(state, base))) {
    throw invalid([{ resource: 'PullRequest', code: 'invalid', field: 'head_repo' }]);
  }
  const headSha = headRepo?.branches[branch];
  if (!headRepo || headSha === undefined) {
    throw invalid([{ resource: 'PullRequest', code: 'invalid', field: 'head' }]);
  }
  const baseSha = base.branches[input.base];
  if (baseSha === undefined) throw invalid([{ resource: 'PullRequest', code: 'invalid', field: 'base' }]);
  const label = `${headRepo.owner}:${branch}`;
  if (isAncestor(state.objects, headSha, baseSha)) {
    throw invalid([{ resource: 'PullRequest', code: 'custom', message: `No commits between ${input.base} and ${label}` }]);
  }
  const duplicate = Object.values(base.issues).some(
    (i) =>
      i.state === 'open' &&
      i.pull?.head.repo === fullName(headRepo) &&
      i.pull.head.ref === branch &&
      i.pull.base.ref === input.base,
  );
  if (duplicate) {
    throw invalid([{ resource: 'PullRequest', code: 'custom', message: `A pull request already exists for ${label}.` }]);
  }
  const number = input.number ?? base.nextNumber;
  base.nextNumber = Math.max(base.nextNumber, number + 1);
  const issue: IssueRecord = {
    id: newId(state),
    number,
    title: input.title,
    body: input.body,
    user: getAccount(state, input.login).login,
    labels: [],
    assignees: [],
    state: 'open',
    stateReason: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    closedBy: null,
    comments: 0,
    timeline: [],
    pull: {
      id: newId(state),
      head: { repo: fullName(headRepo), ref: branch, sha: headSha, owner: headRepo.owner },
      base: { ref: input.base, sha: baseSha },
      draft: input.draft ?? false,
      mergedAt: null,
      mergedBy: null,
      mergeCommitSha: null,
      maintainerCanModify: input.maintainerCanModify ?? true,
      reviews: [],
      reviewComments: [],
    },
  };
  base.issues[String(number)] = issue;
  crossReference(state, base, issue, now);
  return issue;
}

function crossReference(state: FakeState, repo: RepoRecord, from: IssueRecord, now: string): void {
  const seen = new Set<string>();
  for (const ref of references(MENTION, `${from.title}\n${from.body ?? ''}`, fullName(repo))) {
    const target = findRepoByFullName(state, ref.repo);
    const issue = target ? findIssue(target, ref.number) : null;
    const id = `${ref.repo}#${String(ref.number)}`.toLowerCase();
    if (!issue || issue === from || seen.has(id)) continue;
    seen.add(id);
    issue.timeline.push({
      id: newId(state),
      event: 'cross-referenced',
      actor: from.user,
      createdAt: now,
      source: { repo: fullName(repo), number: from.number },
    });
  }
}

export function getPull(repo: RepoRecord, number: number): IssueRecord & { pull: PullData } {
  const issue = findIssue(repo, number);
  if (!issue?.pull) throw new FakeError('not_found', 'Not Found');
  return issue as IssueRecord & { pull: PullData };
}

export function closeIssue(
  state: FakeState,
  issue: IssueRecord,
  login: string,
  reason: 'completed' | 'not_planned' | null,
  now: string,
): void {
  if (issue.state === 'closed') return;
  issue.state = 'closed';
  issue.stateReason = reason;
  issue.closedAt = now;
  issue.closedBy = getAccount(state, login).login;
  issue.updatedAt = now;
  issue.timeline.push({ id: newId(state), event: 'closed', actor: issue.closedBy, createdAt: now, stateReason: reason });
}

// The newest commit both branches share.
export function mergeBase(store: ObjectStore, a: Oid, b: Oid): Oid | null {
  const queue = [b];
  const seen = new Set<Oid>();
  while (queue.length > 0) {
    const oid = queue.shift() as Oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (isAncestor(store, oid, a)) return oid;
    queue.push(...readObject(store, oid, 'commit').parents);
  }
  return null;
}

// Merges a pull request as a maintainer would on GitHub: the PR's changes
// land on the base branch in a merge commit, and the issues it closes close.
export function mergePull(state: FakeState, repo: RepoRecord, number: number, login: string, now: string): Oid {
  const issue = getPull(repo, number);
  if (issue.state !== 'open') throw new FakeError('invalid', 'Pull Request is not mergeable');
  const { pull } = issue;
  const baseHead = repo.branches[pull.base.ref];
  if (baseHead === undefined) throw new FakeError('invalid', 'Base branch was deleted');
  const store = state.objects;
  const files = listFiles(store, readObject(store, baseHead, 'commit').tree);
  const since = mergeBase(store, baseHead, pull.head.sha);
  const before = since ? listFiles(store, readObject(store, since, 'commit').tree) : new Map<string, Oid>();
  const after = listFiles(store, readObject(store, pull.head.sha, 'commit').tree);
  for (const path of before.keys()) if (!after.has(path)) files.delete(path);
  for (const [path, oid] of after) if (before.get(path) !== oid) files.set(path, oid);
  const oid = writeCommit(store, {
    tree: writeTree(store, files),
    parents: [baseHead, pull.head.sha],
    message: `Merge pull request #${String(number)} from ${pull.head.owner}/${pull.head.ref}\n\n${issue.title}`,
    author: gitPerson(state, login, now),
    committer: webFlow(now),
    signedByGitHub: true,
  });
  repo.branches[pull.base.ref] = oid;
  repo.pushedAt = now;
  pull.mergedAt = now;
  pull.mergedBy = getAccount(state, login).login;
  pull.mergeCommitSha = oid;
  issue.timeline.push({ id: newId(state), event: 'merged', actor: pull.mergedBy, createdAt: now, commitId: oid });
  closeIssue(state, issue, login, null, now);
  for (const ref of closingReferences(issue.body ?? '', fullName(repo))) {
    const target = findRepoByFullName(state, ref.repo);
    const closed = target ? findIssue(target, ref.number) : null;
    if (closed && !closed.pull) closeIssue(state, closed, login, 'completed', now);
  }
  return oid;
}

export interface ReviewInput {
  login: string;
  state: ReviewState;
  body: string;
  comments?: { path: string; line: number; body: string }[];
}

export function addReview(state: FakeState, repo: RepoRecord, number: number, input: ReviewInput, now: string) {
  const { pull } = getPull(repo, number);
  const review: ReviewRecord = {
    id: newId(state),
    user: getAccount(state, input.login).login,
    state: input.state,
    body: input.body,
    submittedAt: now,
    commitId: pull.head.sha,
  };
  pull.reviews.push(review);
  for (const comment of input.comments ?? []) {
    pull.reviewComments.push({
      id: newId(state),
      reviewId: review.id,
      user: review.user,
      body: comment.body,
      path: comment.path,
      line: comment.line,
      commitId: pull.head.sha,
      createdAt: now,
    });
  }
  return review;
}
