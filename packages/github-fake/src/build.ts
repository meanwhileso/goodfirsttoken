// Turns the sample data into the fake's state, through the same functions a
// request would use: each repo gets a first commit with its files, then its
// issues, then its pull requests in number order, each on a branch or a
// fork, with their reviews and merges.

import { writeBlob, writeCommit, writeTree, type Oid } from './git.ts';
import type { Ago, SampleData, SampleRepo } from './sample-data.ts';
import {
  addReview,
  canPush,
  commitOnBranch,
  forkRepo,
  fullName,
  gitPerson,
  key,
  mergePull,
  newId,
  openPull,
  roleOf,
  webFlow,
  type FakeState,
  type IssueRecord,
  type RepoRecord,
} from './state.ts';

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, y: 365 * 86_400_000 };

export function ago(value: Ago, now: Date): string {
  const unit = value.slice(-1) as keyof typeof UNIT_MS;
  return new Date(now.getTime() - Number(value.slice(0, -1)) * UNIT_MS[unit]).toISOString();
}

export function buildState(sample: SampleData, now: Date): FakeState {
  const state: FakeState = {
    version: 1,
    nextId: 5_000_000,
    accounts: {},
    repos: {},
    objects: {},
    tokens: {},
    oauthApps: {},
    oauthCodes: {},
  };
  for (const person of sample.people) {
    state.accounts[key(person.login)] = { ...person, type: 'User', createdAt: ago(person.created, now) };
  }
  for (const org of sample.orgs) {
    state.accounts[key(org.login)] = { ...org, type: 'Organization', createdAt: ago(org.created, now) };
  }
  for (const app of sample.oauthApps) state.oauthApps[app.clientId] = { ...app };
  for (const repo of sample.repos) addRepo(state, repo, now);
  return state;
}

// A sample maintainer of the repo, if it has one.
function firstAdmin(repo: SampleRepo): string | undefined {
  return Object.entries(repo.collaborators ?? {}).find(([, role]) => role === 'admin')?.[0];
}

function addRepo(state: FakeState, sample: SampleRepo, now: Date): void {
  const created = ago(sample.created, now);
  const pushed = ago(sample.pushed, now);
  const branch = sample.defaultBranch ?? 'main';
  const files = new Map<string, Oid>();
  for (const [path, text] of Object.entries(sample.files)) files.set(path, writeBlob(state.objects, text));
  const first = writeCommit(state.objects, {
    tree: writeTree(state.objects, files),
    parents: [],
    message: 'Initial commit',
    author: gitPerson(state, firstAdmin(sample) ?? sample.owner, created),
    committer: webFlow(created),
    signedByGitHub: true,
  });
  const repo: RepoRecord = {
    id: newId(state),
    owner: sample.owner,
    name: sample.name,
    description: sample.description,
    homepage: null,
    language: sample.language,
    topics: [],
    license: sample.license ? { key: 'mit', name: 'MIT License', spdx_id: 'MIT' } : null,
    stars: sample.stars,
    createdAt: created,
    updatedAt: pushed,
    pushedAt: pushed,
    defaultBranch: branch,
    private: sample.private ?? false,
    archived: sample.archived ?? false,
    hasIssues: true,
    hasPullRequests: sample.hasPullRequests ?? true,
    pullRequestCreationPolicy: sample.pullRequestCreationPolicy ?? 'all',
    forkOf: null,
    collaborators: Object.fromEntries(
      Object.entries(sample.collaborators ?? {}).map(([login, role]) => [key(login), role]),
    ),
    branches: { [branch]: first },
    labels: sample.labels.map((label) => ({ id: newId(state), ...label, default: label.default ?? false })),
    issues: {},
    nextNumber: 1,
  };
  state.repos[key(fullName(repo))] = repo;

  for (const sampleIssue of sample.issues ?? []) {
    const at = ago(sampleIssue.created, now);
    const labeler = firstAdmin(sample) ?? sampleIssue.author;
    const issue: IssueRecord = {
      id: newId(state),
      number: sampleIssue.number,
      title: sampleIssue.title,
      body: sampleIssue.body,
      user: sampleIssue.author,
      labels: sampleIssue.labels,
      assignees: [],
      state: 'open',
      stateReason: null,
      createdAt: at,
      updatedAt: at,
      closedAt: null,
      closedBy: null,
      comments: 0,
      timeline: sampleIssue.labels.map((name) => ({
        id: newId(state),
        event: 'labeled' as const,
        actor: labeler,
        createdAt: at,
        label: { name, color: repo.labels.find((l) => l.name === name)?.color ?? 'ededed' },
      })),
      pull: null,
    };
    repo.issues[String(issue.number)] = issue;
  }

  const pulls = [...(sample.pulls ?? [])].sort((a, b) => a.number - b.number);
  for (const pull of pulls) {
    const at = ago(pull.created, now);
    const author = pull.author;
    const target = canPush(roleOf(repo, author))
      ? repo
      : forkRepo(state, repo, author, { defaultBranchOnly: true }, at);
    const base = repo.branches[repo.defaultBranch] as Oid;
    target.branches[pull.branch] = base;
    commitOnBranch(
      state,
      target,
      pull.branch,
      {
        additions: Object.entries(pull.files).map(([path, contents]) => ({ path, contents })),
        deletions: [],
        headline: pull.title,
        login: author,
      },
      at,
    );
    const head = target === repo ? pull.branch : `${author}:${pull.branch}`;
    openPull(
      state,
      repo,
      { title: pull.title, body: pull.body, head, base: repo.defaultBranch, login: author, number: pull.number },
      at,
    );
    for (const review of pull.reviews ?? []) {
      const { author: login, state: verdict, body, comments } = review;
      addReview(state, repo, pull.number, { login, state: verdict, body, comments }, ago(review.submitted, now));
    }
    if (pull.merged) {
      mergePull(state, repo, pull.number, pull.merged.by, ago(pull.merged.at, now));
      // GitHub offers to delete a merged branch, and most people do.
      Reflect.deleteProperty(target.branches, pull.branch);
    }
  }
  repo.nextNumber = Math.max(0, ...Object.keys(repo.issues).map(Number)) + 1;
  repo.pushedAt = pushed;
  repo.updatedAt = pushed;
}
