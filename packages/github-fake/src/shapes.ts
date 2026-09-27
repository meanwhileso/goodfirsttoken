// GitHub's REST response shapes, built from the fake's state. Each function
// names the docs page its shape comes from. Every URL in a response points
// at the fake's own base URLs, so nothing that follows one leaves the
// machine. Only documentation_url links point at docs.github.com.

import { blobText, bytesToBase64, listFiles, readObject, type Blob, type Oid, type Tree } from './git.ts';
import { own } from './own.ts';
import {
  findAccount,
  findRepoByFullName,
  fullName,
  key,
  mergeBase,
  permissions,
  roleOf,
  type FakeState,
  type IssueRecord,
  type LabelRecord,
  type PullData,
  type RepoRecord,
  type ReviewCommentRecord,
  type ReviewRecord,
  type TimelineEvent,
} from './state.ts';

export interface Ctx {
  state: FakeState;
  apiUrl: string;
  webUrl: string;
  // The login of the person whose token made the call, or null for none.
  viewer: string | null;
  // The OAuth scopes of that token. A private repo needs `repo` to be seen.
  scopes: readonly string[];
}

const encoder = new TextEncoder();

// Node IDs look like GitHub's newer ones: a type prefix, then an opaque part.
export function nodeId(prefix: string, ...parts: (string | number)[]): string {
  return `${prefix}_${bytesToBase64(encoder.encode(['fake', ...parts].join(':'))).replace(/=+$/, '')}`;
}

export function avatarUrl(ctx: Ctx, id: number): string {
  return `${ctx.webUrl}/avatars/u/${String(id)}?v=4`;
}

// https://docs.github.com/en/rest/users/users#get-a-user (the simple user in every other response)
export function userShape(ctx: Ctx, login: string) {
  const account = findAccount(ctx.state, login);
  const name = account?.login ?? login;
  const id = account?.id ?? 0;
  const api = `${ctx.apiUrl}/users/${name}`;
  return {
    login: name,
    id,
    node_id: nodeId(account?.type === 'Organization' ? 'O' : 'U', id),
    avatar_url: avatarUrl(ctx, id),
    gravatar_id: '',
    url: api,
    html_url: `${ctx.webUrl}/${name}`,
    followers_url: `${api}/followers`,
    following_url: `${api}/following{/other_user}`,
    gists_url: `${api}/gists{/gist_id}`,
    starred_url: `${api}/starred{/owner}{/repo}`,
    subscriptions_url: `${api}/subscriptions`,
    organizations_url: `${api}/orgs`,
    repos_url: `${api}/repos`,
    events_url: `${api}/events{/privacy}`,
    received_events_url: `${api}/received_events`,
    type: account?.type ?? 'User',
    user_view_type: 'public',
    site_admin: false,
  };
}

// https://docs.github.com/en/rest/users/users#get-a-user
// https://docs.github.com/en/rest/users/users#get-the-authenticated-user
export function fullUserShape(ctx: Ctx, login: string, self: boolean) {
  const account = findAccount(ctx.state, login);
  if (!account) return null;
  const repos = Object.values(ctx.state.repos).filter((r) => key(r.owner) === key(login) && r.private !== true);
  const user = {
    ...userShape(ctx, login),
    name: account.name,
    company: null,
    blog: '',
    location: null,
    email: null,
    hireable: null,
    bio: null,
    twitter_username: null,
    public_repos: repos.length,
    public_gists: 0,
    followers: 0,
    following: 0,
    created_at: account.createdAt,
    updated_at: account.createdAt,
  };
  if (!self) return user;
  return {
    ...user,
    private_gists: 0,
    total_private_repos: 0,
    owned_private_repos: 0,
    disk_usage: 0,
    collaborators: 0,
    two_factor_authentication: true,
  };
}

function openIssueCount(repo: RepoRecord): number {
  return Object.values(repo.issues).filter((i) => i.state === 'open').length;
}

function forkCount(ctx: Ctx, repo: RepoRecord): number {
  return Object.values(ctx.state.repos).filter((r) => r.forkOf !== null && key(r.forkOf) === key(fullName(repo)))
    .length;
}

// https://docs.github.com/en/rest/repos/repos#get-a-repository
// Lists and search results use the shorter shape, without `full`.
export function repoShape(ctx: Ctx, repo: RepoRecord, full = false): Record<string, unknown> {
  const name = fullName(repo);
  const api = `${ctx.apiUrl}/repos/${name}`;
  const host = new URL(ctx.webUrl).host;
  const role = roleOf(repo, ctx.viewer);
  const forks = forkCount(ctx, repo);
  const open = openIssueCount(repo);
  const head = repo.branches[repo.defaultBranch];
  const size = head
    ? [...listFiles(ctx.state.objects, readObject(ctx.state.objects, head, 'commit').tree).values()].reduce(
        (sum, oid) => sum + readObject(ctx.state.objects, oid, 'blob').size,
        0,
      )
    : 0;
  const shape: Record<string, unknown> = {
    id: repo.id,
    node_id: nodeId('R', repo.id),
    name: repo.name,
    full_name: name,
    owner: userShape(ctx, repo.owner),
    private: repo.private === true,
    html_url: `${ctx.webUrl}/${name}`,
    description: repo.description,
    fork: repo.forkOf !== null,
    url: api,
    archive_url: `${api}/{archive_format}{/ref}`,
    assignees_url: `${api}/assignees{/user}`,
    blobs_url: `${api}/git/blobs{/sha}`,
    branches_url: `${api}/branches{/branch}`,
    collaborators_url: `${api}/collaborators{/collaborator}`,
    comments_url: `${api}/comments{/number}`,
    commits_url: `${api}/commits{/sha}`,
    compare_url: `${api}/compare/{base}...{head}`,
    contents_url: `${api}/contents/{+path}`,
    contributors_url: `${api}/contributors`,
    deployments_url: `${api}/deployments`,
    downloads_url: `${api}/downloads`,
    events_url: `${api}/events`,
    forks_url: `${api}/forks`,
    git_commits_url: `${api}/git/commits{/sha}`,
    git_refs_url: `${api}/git/refs{/sha}`,
    git_tags_url: `${api}/git/tags{/sha}`,
    git_url: `git://${host}/${name}.git`,
    issue_comment_url: `${api}/issues/comments{/number}`,
    issue_events_url: `${api}/issues/events{/number}`,
    issues_url: `${api}/issues{/number}`,
    keys_url: `${api}/keys{/key_id}`,
    labels_url: `${api}/labels{/name}`,
    languages_url: `${api}/languages`,
    merges_url: `${api}/merges`,
    milestones_url: `${api}/milestones{/number}`,
    notifications_url: `${api}/notifications{?since,all,participating}`,
    pulls_url: `${api}/pulls{/number}`,
    releases_url: `${api}/releases{/id}`,
    ssh_url: `git@${host}:${name}.git`,
    stargazers_url: `${api}/stargazers`,
    statuses_url: `${api}/statuses/{sha}`,
    subscribers_url: `${api}/subscribers`,
    subscription_url: `${api}/subscription`,
    tags_url: `${api}/tags`,
    teams_url: `${api}/teams`,
    trees_url: `${api}/git/trees{/sha}`,
    clone_url: `${ctx.webUrl}/${name}.git`,
    mirror_url: null,
    hooks_url: `${api}/hooks`,
    svn_url: `${ctx.webUrl}/${name}`,
    homepage: repo.homepage,
    language: repo.language,
    forks_count: forks,
    stargazers_count: repo.stars,
    watchers_count: repo.stars,
    size: Math.ceil(size / 1024),
    default_branch: repo.defaultBranch,
    open_issues_count: open,
    is_template: false,
    topics: repo.topics,
    has_issues: repo.hasIssues,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    has_discussions: false,
    has_pull_requests: repo.hasPullRequests,
    pull_request_creation_policy: repo.pullRequestCreationPolicy,
    archived: repo.archived,
    disabled: false,
    visibility: repo.private === true ? 'private' : 'public',
    pushed_at: repo.pushedAt,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    allow_forking: true,
    web_commit_signoff_required: false,
    license: repo.license && {
      ...repo.license,
      url: `${ctx.apiUrl}/licenses/${repo.license.key}`,
      node_id: nodeId('L', repo.license.key),
    },
    forks,
    open_issues: open,
    watchers: repo.stars,
  };
  if (role) shape.permissions = permissions(role);
  if (!full) return shape;
  shape.allow_rebase_merge = true;
  shape.allow_squash_merge = true;
  shape.allow_auto_merge = false;
  shape.allow_merge_commit = true;
  shape.delete_branch_on_merge = false;
  shape.temp_clone_token = '';
  shape.network_count = forks;
  shape.subscribers_count = 0;
  if (findAccount(ctx.state, repo.owner)?.type === 'Organization') shape.organization = userShape(ctx, repo.owner);
  const parent = repo.forkOf ? findRepoByFullName(ctx.state, repo.forkOf) : null;
  if (parent) {
    let source = parent;
    while (source.forkOf) source = findRepoByFullName(ctx.state, source.forkOf) ?? source;
    shape.parent = repoShape(ctx, parent);
    shape.source = repoShape(ctx, source);
  }
  return shape;
}

// https://docs.github.com/en/rest/issues/labels#get-a-label
export function labelShape(ctx: Ctx, repo: RepoRecord, label: LabelRecord) {
  return {
    id: label.id,
    node_id: nodeId('LA', label.id),
    url: `${ctx.apiUrl}/repos/${fullName(repo)}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: label.default,
    description: label.description,
  };
}

// How the author relates to the repo, as GitHub reports it.
function authorAssociation(repo: RepoRecord, login: string): string {
  if (key(repo.owner) === key(login)) return 'OWNER';
  if (own(repo.collaborators, key(login))) return 'COLLABORATOR';
  const merged = Object.values(repo.issues).some((i) => key(i.user) === key(login) && i.pull?.mergedAt);
  return merged ? 'CONTRIBUTOR' : 'NONE';
}

function issueLabels(ctx: Ctx, repo: RepoRecord, issue: IssueRecord) {
  return issue.labels.flatMap((name) => {
    const label = repo.labels.find((l) => key(l.name) === key(name));
    return label ? [labelShape(ctx, repo, label)] : [];
  });
}

// https://docs.github.com/en/rest/issues/issues#get-an-issue
// Lists leave out closed_by. A pull request is an issue with pull_request.
export function issueShape(ctx: Ctx, repo: RepoRecord, issue: IssueRecord, single = false) {
  const name = fullName(repo);
  const api = `${ctx.apiUrl}/repos/${name}`;
  const n = String(issue.number);
  const shape: Record<string, unknown> = {
    url: `${api}/issues/${n}`,
    repository_url: api,
    labels_url: `${api}/issues/${n}/labels{/name}`,
    comments_url: `${api}/issues/${n}/comments`,
    events_url: `${api}/issues/${n}/events`,
    html_url: `${ctx.webUrl}/${name}/${issue.pull ? 'pull' : 'issues'}/${n}`,
    id: issue.id,
    node_id: nodeId('I', issue.id),
    number: issue.number,
    title: issue.title,
    user: userShape(ctx, issue.user),
    labels: issueLabels(ctx, repo, issue),
    state: issue.state,
    locked: false,
    assignee: issue.assignees[0] ? userShape(ctx, issue.assignees[0]) : null,
    assignees: issue.assignees.map((login) => userShape(ctx, login)),
    milestone: null,
    comments: issue.comments,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: authorAssociation(repo, issue.user),
    type: null,
    active_lock_reason: null,
    body: issue.body,
    timeline_url: `${api}/issues/${n}/timeline`,
    performed_via_github_app: null,
    state_reason: issue.stateReason,
  };
  if (issue.pull) {
    shape.draft = issue.pull.draft;
    shape.pull_request = {
      url: `${api}/pulls/${n}`,
      html_url: `${ctx.webUrl}/${name}/pull/${n}`,
      diff_url: `${ctx.webUrl}/${name}/pull/${n}.diff`,
      patch_url: `${ctx.webUrl}/${name}/pull/${n}.patch`,
      merged_at: issue.pull.mergedAt,
    };
  }
  if (single) shape.closed_by = issue.closedBy ? userShape(ctx, issue.closedBy) : null;
  return shape;
}

// https://docs.github.com/en/rest/issues/timeline#list-timeline-events-for-an-issue
export function timelineEventShape(ctx: Ctx, repo: RepoRecord, event: TimelineEvent) {
  if (event.event === 'cross-referenced' && event.source) {
    const source = findRepoByFullName(ctx.state, event.source.repo);
    const issue = source?.issues[String(event.source.number)];
    return {
      actor: userShape(ctx, event.actor),
      created_at: event.createdAt,
      updated_at: event.createdAt,
      source: {
        type: 'issue',
        issue: source && issue ? { ...issueShape(ctx, source, issue), repository: repoShape(ctx, source) } : null,
      },
      event: event.event,
    };
  }
  const prefix = { labeled: 'LE', unlabeled: 'UNLE', assigned: 'AE', closed: 'CE', reopened: 'REE', merged: 'ME' };
  const shape: Record<string, unknown> = {
    id: event.id,
    node_id: nodeId(prefix[event.event as keyof typeof prefix], event.id),
    url: `${ctx.apiUrl}/repos/${fullName(repo)}/issues/events/${String(event.id)}`,
    actor: userShape(ctx, event.actor),
    event: event.event,
    commit_id: event.commitId ?? null,
    commit_url: event.commitId ? `${ctx.apiUrl}/repos/${fullName(repo)}/commits/${event.commitId}` : null,
    created_at: event.createdAt,
    performed_via_github_app: null,
  };
  if (event.label) shape.label = event.label;
  if (event.assignee) shape.assignee = userShape(ctx, event.assignee);
  if (event.event === 'closed') shape.state_reason = event.stateReason ?? null;
  return shape;
}

function diffStats(ctx: Ctx, repo: RepoRecord, pull: PullData) {
  const store = ctx.state.objects;
  // From where the PR branched off, which stays put after it merges.
  const since = mergeBase(store, pull.base.sha, pull.head.sha) ?? pull.base.sha;
  const before = listFiles(store, readObject(store, since, 'commit').tree);
  const after = listFiles(store, readObject(store, pull.head.sha, 'commit').tree);
  const lines = (oid: Oid | undefined) =>
    oid ? (blobText(readObject(store, oid, 'blob')) ?? '').split('\n').filter(Boolean) : [];
  let additions = 0;
  let deletions = 0;
  let changed = 0;
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(path) === after.get(path)) continue;
    changed++;
    const old = lines(before.get(path));
    const next = lines(after.get(path));
    additions += next.filter((line) => !old.includes(line)).length;
    deletions += old.filter((line) => !next.includes(line)).length;
  }
  let commits = 0;
  for (let oid: Oid | undefined = pull.head.sha; oid && oid !== since; ) {
    commits++;
    oid = readObject(store, oid, 'commit').parents[0];
  }
  return { commits, additions, deletions, changed_files: changed };
}

// https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request
// Lists use the shorter shape, without `full`.
export function pullShape(ctx: Ctx, repo: RepoRecord, issue: IssueRecord & { pull: PullData }, full = false) {
  const name = fullName(repo);
  const api = `${ctx.apiUrl}/repos/${name}`;
  const n = String(issue.number);
  const { pull } = issue;
  const headRepo = pull.head.repo ? findRepoByFullName(ctx.state, pull.head.repo) : null;
  const html = `${ctx.webUrl}/${name}/pull/${n}`;
  const shape: Record<string, unknown> = {
    url: `${api}/pulls/${n}`,
    id: pull.id,
    node_id: nodeId('PR', pull.id),
    html_url: html,
    diff_url: `${html}.diff`,
    patch_url: `${html}.patch`,
    issue_url: `${api}/issues/${n}`,
    commits_url: `${api}/pulls/${n}/commits`,
    review_comments_url: `${api}/pulls/${n}/comments`,
    review_comment_url: `${api}/pulls/comments{/number}`,
    comments_url: `${api}/issues/${n}/comments`,
    statuses_url: `${api}/statuses/${pull.head.sha}`,
    number: issue.number,
    state: issue.state,
    locked: false,
    title: issue.title,
    user: userShape(ctx, issue.user),
    body: issue.body,
    labels: issueLabels(ctx, repo, issue),
    milestone: null,
    active_lock_reason: null,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    assignee: issue.assignees[0] ? userShape(ctx, issue.assignees[0]) : null,
    assignees: issue.assignees.map((login) => userShape(ctx, login)),
    requested_reviewers: [],
    requested_teams: [],
    head: {
      label: `${pull.head.owner}:${pull.head.ref}`,
      ref: pull.head.ref,
      sha: pull.head.sha,
      user: userShape(ctx, pull.head.owner),
      repo: headRepo ? repoShape(ctx, headRepo) : null,
    },
    base: {
      label: `${repo.owner}:${pull.base.ref}`,
      ref: pull.base.ref,
      sha: pull.base.sha,
      user: userShape(ctx, repo.owner),
      repo: repoShape(ctx, repo),
    },
    _links: {
      self: { href: `${api}/pulls/${n}` },
      html: { href: html },
      issue: { href: `${api}/issues/${n}` },
      comments: { href: `${api}/issues/${n}/comments` },
      review_comments: { href: `${api}/pulls/${n}/comments` },
      review_comment: { href: `${api}/pulls/comments{/number}` },
      commits: { href: `${api}/pulls/${n}/commits` },
      statuses: { href: `${api}/statuses/${pull.head.sha}` },
    },
    author_association: authorAssociation(repo, issue.user),
    auto_merge: null,
    draft: pull.draft,
  };
  if (!full) return shape;
  const open = issue.state === 'open';
  return {
    ...shape,
    merged: pull.mergedAt !== null,
    mergeable: open ? true : null,
    rebaseable: open ? true : null,
    mergeable_state: open ? 'clean' : 'unknown',
    merged_by: pull.mergedBy ? userShape(ctx, pull.mergedBy) : null,
    comments: issue.comments,
    review_comments: pull.reviewComments.length,
    maintainer_can_modify: pull.maintainerCanModify,
    ...diffStats(ctx, repo, pull),
  };
}

// https://docs.github.com/en/rest/pulls/reviews#get-a-review-for-a-pull-request
export function reviewShape(ctx: Ctx, repo: RepoRecord, number: number, review: ReviewRecord) {
  const name = fullName(repo);
  const html = `${ctx.webUrl}/${name}/pull/${String(number)}#pullrequestreview-${String(review.id)}`;
  const pullUrl = `${ctx.apiUrl}/repos/${name}/pulls/${String(number)}`;
  return {
    id: review.id,
    node_id: nodeId('PRR', review.id),
    user: userShape(ctx, review.user),
    body: review.body,
    state: review.state,
    html_url: html,
    pull_request_url: pullUrl,
    author_association: authorAssociation(repo, review.user),
    _links: { html: { href: html }, pull_request: { href: pullUrl } },
    submitted_at: review.submittedAt,
    commit_id: review.commitId,
  };
}

function diffHunk(ctx: Ctx, comment: ReviewCommentRecord): string {
  const store = ctx.state.objects;
  const tree = readObject(store, comment.commitId, 'commit').tree;
  const oid = listFiles(store, tree).get(comment.path);
  const text = oid ? (blobText(readObject(store, oid, 'blob')) ?? '') : '';
  const lines = text.split('\n').slice(0, comment.line);
  return [`@@ -0,0 +1,${String(lines.length)} @@`, ...lines.map((line) => `+${line}`)].join('\n');
}

// https://docs.github.com/en/rest/pulls/comments#get-a-review-comment-for-a-pull-request
export function reviewCommentShape(ctx: Ctx, repo: RepoRecord, number: number, comment: ReviewCommentRecord) {
  const name = fullName(repo);
  const url = `${ctx.apiUrl}/repos/${name}/pulls/comments/${String(comment.id)}`;
  const html = `${ctx.webUrl}/${name}/pull/${String(number)}#discussion_r${String(comment.id)}`;
  const pullUrl = `${ctx.apiUrl}/repos/${name}/pulls/${String(number)}`;
  return {
    url,
    pull_request_review_id: comment.reviewId,
    id: comment.id,
    node_id: nodeId('PRRC', comment.id),
    diff_hunk: diffHunk(ctx, comment),
    path: comment.path,
    position: comment.line,
    original_position: comment.line,
    commit_id: comment.commitId,
    original_commit_id: comment.commitId,
    user: userShape(ctx, comment.user),
    body: comment.body,
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: html,
    pull_request_url: pullUrl,
    author_association: authorAssociation(repo, comment.user),
    _links: { self: { href: url }, html: { href: html }, pull_request: { href: pullUrl } },
    start_line: null,
    original_start_line: null,
    start_side: null,
    line: comment.line,
    original_line: comment.line,
    side: 'RIGHT',
    subject_type: 'line',
  };
}

// https://docs.github.com/en/rest/repos/contents#get-repository-content
export function contentShape(
  ctx: Ctx,
  repo: RepoRecord,
  ref: string,
  path: string,
  oid: Oid,
  object: Blob | Tree,
  withContent: boolean,
) {
  const name = fullName(repo);
  const url = `${ctx.apiUrl}/repos/${name}/contents/${path}?ref=${encodeURIComponent(ref)}`;
  const file = object.type === 'blob';
  const gitUrl = `${ctx.apiUrl}/repos/${name}/git/${file ? 'blobs' : 'trees'}/${oid}`;
  const htmlUrl = `${ctx.webUrl}/${name}/${file ? 'blob' : 'tree'}/${ref}/${path}`;
  const shape: Record<string, unknown> = {
    type: file ? 'file' : 'dir',
    size: file ? object.size : 0,
    name: path.split('/').pop() ?? path,
    path,
    sha: oid,
    url,
    git_url: gitUrl,
    html_url: htmlUrl,
    download_url: file ? `${ctx.webUrl}/${name}/raw/${ref}/${path}` : null,
    _links: { self: url, git: gitUrl, html: htmlUrl },
  };
  if (file && withContent) {
    shape.encoding = 'base64';
    shape.content = (object.base64.match(/.{1,60}/g) ?? []).join('\n') + '\n';
  }
  return shape;
}

// https://docs.github.com/en/rest/commits/commits#get-a-commit (the commit inside a branch)
export function commitShape(ctx: Ctx, repo: RepoRecord, sha: Oid) {
  const name = fullName(repo);
  const api = `${ctx.apiUrl}/repos/${name}`;
  const commit = readObject(ctx.state.objects, sha, 'commit');
  const person = ({ name: n, email, date }: { name: string; email: string; date: string }) => ({ name: n, email, date });
  const account = (login: string | null) => (login && findAccount(ctx.state, login) ? userShape(ctx, login) : null);
  return {
    sha,
    node_id: nodeId('C', repo.id, sha),
    commit: {
      author: person(commit.author),
      committer: person(commit.committer),
      message: commit.message,
      tree: { sha: commit.tree, url: `${api}/git/trees/${commit.tree}` },
      url: `${api}/git/commits/${sha}`,
      comment_count: 0,
      verification: {
        verified: commit.signedByGitHub,
        reason: commit.signedByGitHub ? 'valid' : 'unsigned',
        signature: null,
        payload: null,
        verified_at: commit.signedByGitHub ? commit.committer.date : null,
      },
    },
    url: `${api}/commits/${sha}`,
    html_url: `${ctx.webUrl}/${name}/commit/${sha}`,
    comments_url: `${api}/commits/${sha}/comments`,
    author: account(commit.author.login),
    committer: account(commit.committer.login),
    parents: commit.parents.map((p) => ({
      sha: p,
      url: `${api}/commits/${p}`,
      html_url: `${ctx.webUrl}/${name}/commit/${p}`,
    })),
  };
}

// https://docs.github.com/en/rest/branches/branches#get-a-branch
export function branchShape(ctx: Ctx, repo: RepoRecord, branch: string, sha: Oid) {
  const api = `${ctx.apiUrl}/repos/${fullName(repo)}/branches/${branch}`;
  return {
    name: branch,
    commit: commitShape(ctx, repo, sha),
    _links: { self: api, html: `${ctx.webUrl}/${fullName(repo)}/tree/${branch}` },
    protected: false,
    protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] } },
    protection_url: `${api}/protection`,
  };
}

// https://docs.github.com/en/rest/git/refs#get-a-reference
export function refShape(ctx: Ctx, repo: RepoRecord, branch: string, sha: Oid) {
  const api = `${ctx.apiUrl}/repos/${fullName(repo)}`;
  return {
    ref: `refs/heads/${branch}`,
    node_id: nodeId('REF', repo.id, `refs/heads/${branch}`),
    url: `${api}/git/refs/heads/${branch}`,
    object: { type: 'commit', sha, url: `${api}/git/commits/${sha}` },
  };
}
