// A slice of GitHub's GraphQL API: reading files from many repos in one
// query, a repo's labels with the open issues that carry each, issues with
// the open PRs that close them, pull requests, and
// createCommitOnBranch. The schema below copies the names and
// types of GitHub's own, so a query that works here works on GitHub. Queries
// run through graphql-js, so aliases, fragments, variables, and validation
// errors behave as they do on GitHub.
//
// https://docs.github.com/en/graphql/reference/repos#query-repository
// https://docs.github.com/en/graphql/reference/repos#object-repository
// https://docs.github.com/en/graphql/reference/users#query-viewer
// https://docs.github.com/en/graphql/reference/git#object-blob
// https://docs.github.com/en/graphql/reference/git#object-tree
// https://docs.github.com/en/graphql/reference/git#object-ref
// https://docs.github.com/en/graphql/reference/commits#object-commit
// https://docs.github.com/en/graphql/reference/commits#mutation-createcommitonbranch
// https://docs.github.com/en/graphql/reference/issues#object-issue
// https://docs.github.com/en/graphql/reference/labels#object-label
// https://docs.github.com/en/graphql/reference/pulls#object-pullrequest

import { GraphQLError, Kind, buildSchema, getOperationAST, graphql, parse, type DocumentNode } from 'graphql';
import { base64ToBytes, blobText, bytesToBase64, lookupPath, type GitPerson, type Oid } from './git.ts';
import { avatarUrl, nodeId, type Ctx } from './shapes.ts';
import { own } from './own.ts';
import {
  FakeError,
  canPush,
  canSee,
  closingPulls,
  commitOnBranch,
  findAccount,
  findIssue,
  findRepo,
  findRepoByFullName,
  fullName,
  key,
  roleOf,
  type IssueRecord,
  type LabelRecord,
  type PullData,
  type RepoRecord,
} from './state.ts';

const schema = buildSchema(/* GraphQL */ `
  scalar Base64String
  scalar DateTime
  scalar GitObjectID
  scalar GitTimestamp
  scalar URI

  enum RepositoryPermission {
    ADMIN
    MAINTAIN
    WRITE
    TRIAGE
    READ
  }

  enum GitSignatureState {
    VALID
    INVALID
  }

  enum IssueState {
    OPEN
    CLOSED
  }

  enum PullRequestState {
    OPEN
    CLOSED
    MERGED
  }

  type PageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
  }

  interface Node {
    id: ID!
  }

  interface RepositoryOwner {
    id: ID!
    login: String!
    url: URI!
    avatarUrl(size: Int): URI!
  }

  type User implements Node & RepositoryOwner {
    id: ID!
    databaseId: Int
    login: String!
    name: String
    url: URI!
    avatarUrl(size: Int): URI!
    createdAt: DateTime!
  }

  type Organization implements Node & RepositoryOwner {
    id: ID!
    databaseId: Int
    login: String!
    name: String
    url: URI!
    avatarUrl(size: Int): URI!
    createdAt: DateTime!
  }

  type Repository implements Node {
    id: ID!
    databaseId: Int
    name: String!
    nameWithOwner: String!
    url: URI!
    description: String
    owner: RepositoryOwner!
    isPrivate: Boolean!
    isArchived: Boolean!
    isFork: Boolean!
    stargazerCount: Int!
    createdAt: DateTime!
    updatedAt: DateTime!
    pushedAt: DateTime
    viewerPermission: RepositoryPermission
    defaultBranchRef: Ref
    ref(qualifiedName: String!): Ref
    object(expression: String, oid: GitObjectID): GitObject
    issue(number: Int!): Issue
    pullRequest(number: Int!): PullRequest
    labels(after: String, before: String, first: Int, last: Int, query: String): LabelConnection
  }

  type Label implements Node {
    id: ID!
    name: String!
    color: String!
    description: String
    isDefault: Boolean!
    url: URI!
    repository: Repository!
    issues(after: String, before: String, first: Int, last: Int, states: [IssueState!]): IssueConnection!
  }

  type LabelConnection {
    totalCount: Int!
    nodes: [Label]
    pageInfo: PageInfo!
  }

  type IssueConnection {
    totalCount: Int!
    nodes: [Issue]
    pageInfo: PageInfo!
  }

  type Issue implements Node {
    id: ID!
    databaseId: Int
    number: Int!
    title: String!
    url: URI!
    state: IssueState!
    createdAt: DateTime!
    repository: Repository!
    closedByPullRequestsReferences(
      after: String
      before: String
      first: Int
      last: Int
      includeClosedPrs: Boolean = false
      orderByState: Boolean = false
      userLinkedOnly: Boolean = false
      excludeUserLinked: Boolean = false
    ): PullRequestConnection
  }

  type PullRequest implements Node {
    id: ID!
    databaseId: Int
    number: Int!
    title: String!
    url: URI!
    state: PullRequestState!
    isDraft: Boolean!
    merged: Boolean!
    mergedAt: DateTime
    closedAt: DateTime
    createdAt: DateTime!
    baseRefName: String!
    repository: Repository!
  }

  type PullRequestConnection {
    totalCount: Int!
    nodes: [PullRequest]
    pageInfo: PageInfo!
  }

  type Ref implements Node {
    id: ID!
    name: String!
    prefix: String!
    target: GitObject
    repository: Repository!
  }

  interface GitObject {
    id: ID!
    oid: GitObjectID!
    abbreviatedOid: String!
    commitUrl: URI!
    repository: Repository!
  }

  type Blob implements Node & GitObject {
    id: ID!
    oid: GitObjectID!
    abbreviatedOid: String!
    commitUrl: URI!
    repository: Repository!
    byteSize: Int!
    isBinary: Boolean
    isTruncated: Boolean!
    text: String
  }

  type TreeEntry {
    name: String!
    path: String
    type: String!
    mode: Int!
    oid: GitObjectID!
    size: Int!
    object: GitObject
    repository: Repository!
  }

  type Tree implements Node & GitObject {
    id: ID!
    oid: GitObjectID!
    abbreviatedOid: String!
    commitUrl: URI!
    repository: Repository!
    entries: [TreeEntry!]
  }

  type GitActor {
    name: String
    email: String
    date: GitTimestamp
    user: User
  }

  interface GitSignature {
    email: String!
    isValid: Boolean!
    payload: String!
    signature: String!
    signer: User
    state: GitSignatureState!
    wasSignedByGitHub: Boolean!
  }

  type GpgSignature implements GitSignature {
    email: String!
    isValid: Boolean!
    keyId: String
    payload: String!
    signature: String!
    signer: User
    state: GitSignatureState!
    wasSignedByGitHub: Boolean!
  }

  type CommitConnection {
    totalCount: Int!
    nodes: [Commit]
  }

  type Commit implements Node & GitObject {
    id: ID!
    oid: GitObjectID!
    abbreviatedOid: String!
    commitUrl: URI!
    repository: Repository!
    message: String!
    messageHeadline: String!
    messageBody: String!
    url: URI!
    authoredDate: DateTime!
    committedDate: DateTime!
    author: GitActor
    committer: GitActor
    signature: GitSignature
    tree: Tree!
    parents(first: Int, after: String, last: Int, before: String): CommitConnection!
  }

  type Query {
    repository(owner: String!, name: String!, followRenames: Boolean = true): Repository
    viewer: User!
  }

  input CommittableBranch {
    branchName: String
    id: ID
    repositoryNameWithOwner: String
  }

  input FileAddition {
    contents: Base64String!
    path: String!
  }

  input FileDeletion {
    path: String!
  }

  input FileChanges {
    additions: [FileAddition!] = []
    deletions: [FileDeletion!] = []
  }

  input CommitMessage {
    body: String
    headline: String!
  }

  input CreateCommitOnBranchInput {
    branch: CommittableBranch!
    clientMutationId: String
    expectedHeadOid: GitObjectID!
    fileChanges: FileChanges
    message: CommitMessage!
  }

  type CreateCommitOnBranchPayload {
    clientMutationId: String
    commit: Commit
    ref: Ref
  }

  type Mutation {
    createCommitOnBranch(input: CreateCommitOnBranchInput!): CreateCommitOnBranchPayload
  }
`);

function fail(type: string, message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { type } });
}

function ownerNode(ctx: Ctx, login: string) {
  const account = findAccount(ctx.state, login);
  if (!account) return null;
  const org = account.type === 'Organization';
  return {
    __typename: org ? 'Organization' : 'User',
    id: nodeId(org ? 'O' : 'U', account.id),
    databaseId: account.id,
    login: account.login,
    name: account.name,
    url: `${ctx.webUrl}/${account.login}`,
    avatarUrl: () => avatarUrl(ctx, account.id),
    createdAt: account.createdAt,
  };
}

const PERMISSION = { admin: 'ADMIN', maintain: 'MAINTAIN', write: 'WRITE', triage: 'TRIAGE', read: 'READ' };

function repositoryNode(ctx: Ctx, repo: RepoRecord) {
  const name = fullName(repo);
  return {
    __typename: 'Repository',
    id: nodeId('R', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: name,
    url: `${ctx.webUrl}/${name}`,
    description: repo.description,
    owner: () => ownerNode(ctx, repo.owner),
    isPrivate: repo.private === true,
    isArchived: repo.archived,
    isFork: repo.forkOf !== null,
    stargazerCount: repo.stars,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    pushedAt: repo.pushedAt,
    viewerPermission: () => {
      const role = roleOf(repo, ctx.viewer);
      return role ? PERMISSION[role] : null;
    },
    defaultBranchRef: () => refNode(ctx, repo, repo.defaultBranch),
    ref: ({ qualifiedName }: { qualifiedName: string }) => refNode(ctx, repo, qualifiedName.replace(/^refs\/heads\//, '')),
    object: ({ expression, oid }: { expression?: string; oid?: string }) =>
      oid !== undefined ? objectNode(ctx, repo, resolveRev(ctx, repo, oid), '') : objectAt(ctx, repo, expression ?? ''),
    // A number that belongs to a PR is no issue, and one that belongs to an
    // issue is no PR, as on GitHub.
    issue: ({ number }: { number: number }) => {
      const issue = findIssue(repo, number);
      if (!issue || issue.pull) throw fail('NOT_FOUND', `Could not resolve to an Issue with the number of ${String(number)}.`);
      return issueNode(ctx, repo, issue);
    },
    pullRequest: ({ number }: { number: number }) => {
      const issue = findIssue(repo, number);
      if (!issue?.pull) throw fail('NOT_FOUND', `Could not resolve to a PullRequest with the number of ${String(number)}.`);
      return pullRequestNode(ctx, repo, issue as IssueRecord & { pull: PullData });
    },
    // In the order they were made. `query` finds labels by name or
    // description, without case.
    labels: (args: PageArgs & { query?: string | null }) => {
      const query = args.query?.toLowerCase() ?? null;
      const found = repo.labels.filter(
        (label) =>
          query === null ||
          label.name.toLowerCase().includes(query) ||
          (label.description ?? '').toLowerCase().includes(query),
      );
      return pageOf(
        found.map((label) => labelNode(ctx, repo, label)),
        args,
        'labels',
      );
    },
  };
}

type PageArgs = { first?: number | null; last?: number | null; after?: string | null; before?: string | null };

// A label, with the issues that carry it. An issue connection asked for its
// totalCount alone needs no first or last, as on GitHub. Pull requests
// aren't issues here, as on GitHub, where a label's pull requests are a
// connection of their own.
function labelNode(ctx: Ctx, repo: RepoRecord, label: LabelRecord) {
  return {
    __typename: 'Label',
    id: nodeId('LA', label.id),
    name: label.name,
    color: label.color,
    description: label.description,
    isDefault: label.default,
    url: `${ctx.webUrl}/${fullName(repo)}/labels/${encodeURIComponent(label.name)}`,
    repository: () => repositoryNode(ctx, repo),
    issues: (args: PageArgs & { states?: string[] | null }) => {
      const issues = Object.values(repo.issues)
        .filter((issue) => issue.pull === null && issue.labels.some((name) => key(name) === key(label.name)))
        .filter((issue) => !args.states || args.states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'))
        .sort((a, b) => a.number - b.number);
      const page = () => pageOf(issues.map((issue) => issueNode(ctx, repo, issue)), args, 'issues');
      return { totalCount: issues.length, nodes: () => page().nodes, pageInfo: () => page().pageInfo };
    },
  };
}

// GitHub asks for first or last on every connection, at most 100.
function pageOf<T>(items: T[], args: { first?: number | null; last?: number | null; after?: string | null; before?: string | null }, field: string) {
  if (args.last != null || args.before != null) {
    throw fail('UNPROCESSABLE', `The GitHub fake pages ${field} with first and after only.`);
  }
  if (args.first == null) {
    throw fail('MISSING_PAGINATION_BOUNDARIES', `You must provide a \`first\` or \`last\` value to properly paginate the \`${field}\` connection.`);
  }
  if (args.first < 0 || args.first > 100) {
    throw fail('EXCESSIVE_PAGINATION', `Requesting ${String(args.first)} records on the \`${field}\` connection exceeds the \`first\` limit of 100 records.`);
  }
  const start = args.after == null ? 0 : Number(new TextDecoder().decode(base64ToBytes(args.after)).replace(/^cursor:/, ''));
  const page = items.slice(start, start + args.first);
  const cursor = (index: number) => bytesToBase64(new TextEncoder().encode(`cursor:${String(index)}`));
  return {
    totalCount: items.length,
    nodes: page,
    pageInfo: {
      hasNextPage: start + page.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? cursor(start) : null,
      endCursor: page.length > 0 ? cursor(start + page.length) : null,
    },
  };
}

function issueNode(ctx: Ctx, repo: RepoRecord, issue: IssueRecord) {
  return {
    __typename: 'Issue',
    id: nodeId('I', issue.id),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    url: `${ctx.webUrl}/${fullName(repo)}/issues/${String(issue.number)}`,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    createdAt: issue.createdAt,
    repository: () => repositoryNode(ctx, repo),
    // The PRs a closing keyword links to the issue. The fake has no PRs
    // linked by hand, so userLinkedOnly finds none.
    closedByPullRequestsReferences: (args: {
      first?: number | null;
      last?: number | null;
      after?: string | null;
      before?: string | null;
      includeClosedPrs?: boolean;
      userLinkedOnly?: boolean;
    }) => {
      const pulls = args.userLinkedOnly
        ? []
        : closingPulls(ctx.state, repo, issue, {
            includeClosed: args.includeClosedPrs === true,
            visible: (r) => canSee(r, ctx.viewer, ctx.scopes),
          });
      return pageOf(
        pulls.map((found) => pullRequestNode(ctx, found.repo, found.pull)),
        args,
        'closedByPullRequestsReferences',
      );
    },
  };
}

function pullRequestNode(ctx: Ctx, repo: RepoRecord, issue: IssueRecord & { pull: PullData }) {
  const merged = issue.pull.mergedAt !== null;
  return {
    __typename: 'PullRequest',
    id: nodeId('PR', issue.pull.id),
    databaseId: issue.pull.id,
    number: issue.number,
    title: issue.title,
    url: `${ctx.webUrl}/${fullName(repo)}/pull/${String(issue.number)}`,
    state: merged ? 'MERGED' : issue.state === 'open' ? 'OPEN' : 'CLOSED',
    isDraft: issue.pull.draft,
    merged,
    mergedAt: issue.pull.mergedAt,
    closedAt: issue.closedAt,
    createdAt: issue.createdAt,
    baseRefName: issue.pull.base.ref,
    repository: () => repositoryNode(ctx, repo),
  };
}

function refNode(ctx: Ctx, repo: RepoRecord, branch: string) {
  const oid = own(repo.branches, branch);
  if (oid === undefined) return null;
  return {
    __typename: 'Ref',
    id: nodeId('REF', repo.id, `refs/heads/${branch}`),
    name: branch,
    prefix: 'refs/heads/',
    target: () => objectNode(ctx, repo, oid, ''),
    repository: () => repositoryNode(ctx, repo),
  };
}

// A revision: HEAD, a branch name, or a full or abbreviated commit ID.
function resolveRev(ctx: Ctx, repo: RepoRecord, rev: string): Oid | null {
  if (rev === '' || rev === 'HEAD') return own(repo.branches, repo.defaultBranch) ?? null;
  const branch = own(repo.branches, rev.replace(/^refs\/heads\//, ''));
  if (branch !== undefined) return branch;
  if (!/^[0-9a-f]{4,40}$/.test(rev)) return null;
  return Object.keys(ctx.state.objects).find((oid) => oid.startsWith(rev)) ?? null;
}

// GitHub's object(expression:) takes "<rev>" or "<rev>:<path>", like
// "HEAD:CONTRIBUTING.md" or "main:.github/".
function objectAt(ctx: Ctx, repo: RepoRecord, expression: string) {
  const colon = expression.indexOf(':');
  const rev = resolveRev(ctx, repo, colon === -1 ? expression : expression.slice(0, colon));
  if (rev === null) return null;
  if (colon === -1) return objectNode(ctx, repo, rev, '');
  const commit = own(ctx.state.objects, rev);
  if (commit?.type !== 'commit') return null;
  const path = expression.slice(colon + 1).replace(/\/+$/, '');
  const found = lookupPath(ctx.state.objects, commit.tree, path);
  return found ? objectNode(ctx, repo, found.oid, path) : null;
}

function gitActor(ctx: Ctx, person: GitPerson) {
  return {
    name: person.name,
    email: person.email,
    date: person.date,
    user: () => (person.login ? ownerNode(ctx, person.login) : null),
  };
}

function objectNode(ctx: Ctx, repo: RepoRecord, oid: Oid | null, path: string): Record<string, unknown> | null {
  const object = oid === null ? undefined : own(ctx.state.objects, oid);
  if (oid === null || object === undefined) return null;
  const common = {
    oid,
    abbreviatedOid: oid.slice(0, 7),
    commitUrl: `${ctx.webUrl}/${fullName(repo)}/commit/${oid}`,
    repository: () => repositoryNode(ctx, repo),
  };
  switch (object.type) {
    case 'blob': {
      const text = blobText(object);
      return {
        ...common,
        __typename: 'Blob',
        id: nodeId('B', repo.id, oid),
        byteSize: object.size,
        isBinary: text === null,
        isTruncated: false,
        text,
      };
    }
    case 'tree':
      return {
        ...common,
        __typename: 'Tree',
        id: nodeId('T', repo.id, oid),
        entries: object.entries.map((entry) => {
          const entryPath = path ? `${path}/${entry.name}` : entry.name;
          const target = ctx.state.objects[entry.oid];
          return {
            name: entry.name,
            path: entryPath,
            type: entry.type,
            mode: entry.type === 'blob' ? 0o100644 : 0o40000,
            oid: entry.oid,
            size: target?.type === 'blob' ? target.size : 0,
            object: () => objectNode(ctx, repo, entry.oid, entryPath),
            repository: () => repositoryNode(ctx, repo),
          };
        }),
      };
    case 'commit': {
      const [headline = '', ...rest] = object.message.split('\n');
      return {
        ...common,
        __typename: 'Commit',
        id: nodeId('C', repo.id, oid),
        message: object.message,
        messageHeadline: headline,
        messageBody: rest.join('\n').trim(),
        url: common.commitUrl,
        authoredDate: object.author.date,
        committedDate: object.committer.date,
        author: gitActor(ctx, object.author),
        committer: gitActor(ctx, object.committer),
        signature: object.signedByGitHub
          ? {
              __typename: 'GpgSignature',
              email: object.committer.email,
              isValid: true,
              keyId: null,
              payload: '',
              signature: '',
              signer: null,
              state: 'VALID',
              wasSignedByGitHub: true,
            }
          : null,
        tree: () => objectNode(ctx, repo, object.tree, ''),
        parents: ({ first }: { first?: number }) => ({
          totalCount: object.parents.length,
          nodes: object.parents.slice(0, first ?? object.parents.length).map((p) => objectNode(ctx, repo, p, '')),
        }),
      };
    }
  }
}

// The repo and branch a CommittableBranch names, by node ID or by name.
function committableBranch(ctx: Ctx, branch: { id?: string; repositoryNameWithOwner?: string; branchName?: string }) {
  if (branch.id !== undefined) {
    const [, id, ref] = (() => {
      try {
        return new TextDecoder().decode(base64ToBytes(branch.id.replace(/^REF_/, ''))).split(':');
      } catch {
        return [];
      }
    })();
    const repo = Object.values(ctx.state.repos).find((r) => String(r.id) === id && canSee(r, ctx.viewer, ctx.scopes));
    if (!repo || !ref?.startsWith('refs/heads/')) throw fail('NOT_FOUND', `Could not resolve to a node with the global id of '${branch.id}'`);
    return { repo, name: ref.slice('refs/heads/'.length) };
  }
  if (branch.repositoryNameWithOwner === undefined || branch.branchName === undefined) {
    throw fail('UNPROCESSABLE', 'Either branch.id or both branch.repositoryNameWithOwner and branch.branchName are required.');
  }
  const repo = findRepoByFullName(ctx.state, branch.repositoryNameWithOwner);
  if (!repo || !canSee(repo, ctx.viewer, ctx.scopes)) {
    throw fail('NOT_FOUND', `Could not resolve to a Repository with the name '${branch.repositoryNameWithOwner}'.`);
  }
  return { repo, name: branch.branchName };
}

interface CreateCommitInput {
  branch: { id?: string; repositoryNameWithOwner?: string; branchName?: string };
  clientMutationId?: string;
  expectedHeadOid: string;
  fileChanges?: { additions?: { path: string; contents: string }[]; deletions?: { path: string }[] };
  message: { headline: string; body?: string };
}

const KIND_TYPE = { not_found: 'NOT_FOUND', forbidden: 'FORBIDDEN', invalid: 'UNPROCESSABLE', stale: 'STALE_DATA' };

function rootValue(ctx: Ctx, now: string) {
  return {
    repository: ({ owner, name }: { owner: string; name: string }) => {
      // A repo the caller can't see is not found, like one that isn't there.
      const repo = findRepo(ctx.state, owner, name);
      if (!repo || !canSee(repo, ctx.viewer, ctx.scopes)) throw fail('NOT_FOUND', `Could not resolve to a Repository with the name '${owner}/${name}'.`);
      return repositoryNode(ctx, repo);
    },
    viewer: () => ownerNode(ctx, ctx.viewer ?? ''),
    // Appends a commit to the branch as the person whose token made the
    // call. GitHub commits and signs it.
    createCommitOnBranch: ({ input }: { input: CreateCommitInput }) => {
      const { repo, name } = committableBranch(ctx, input.branch);
      const login = ctx.viewer ?? '';
      if (!canPush(roleOf(repo, login))) {
        throw fail('FORBIDDEN', `${login} does not have the correct permissions to execute \`CreateCommitOnBranch\``);
      }
      try {
        const oid = commitOnBranch(
          ctx.state,
          repo,
          name,
          {
            additions: (input.fileChanges?.additions ?? []).map((a) => ({
              path: a.path,
              contents: base64ToBytes(a.contents),
            })),
            deletions: (input.fileChanges?.deletions ?? []).map((d) => d.path),
            headline: input.message.headline,
            body: input.message.body ?? null,
            login,
            expectedHeadOid: input.expectedHeadOid,
          },
          now,
        );
        return {
          clientMutationId: input.clientMutationId ?? null,
          commit: objectNode(ctx, repo, oid, ''),
          ref: refNode(ctx, repo, name),
        };
      } catch (error) {
        if (error instanceof FakeError) throw fail(KIND_TYPE[error.kind], error.message);
        throw error;
      }
    },
  };
}

// "query repository" or "mutation createCommitOnBranch": the operation type
// and its top-level fields, for the call log.
export function describeOperation(query: string, operationName?: string | null): string {
  let document: DocumentNode;
  try {
    document = parse(query);
  } catch {
    return 'graphql (unparsable)';
  }
  const operation = getOperationAST(document, operationName ?? undefined);
  if (!operation) return 'graphql';
  const fields = new Set<string>();
  for (const selection of operation.selectionSet.selections) {
    if (selection.kind === Kind.FIELD) fields.add(selection.name.value);
  }
  return `${operation.operation} ${[...fields].join(', ')}`.trim();
}

// https://docs.github.com/en/graphql/guides/forming-calls-with-graphql
// Errors come back with status 200 in GitHub's shape: type, path,
// locations, and message.
export async function runGraphQL(ctx: Ctx, body: unknown, now: string): Promise<Record<string, unknown>> {
  const request = (body ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof request.query !== 'string') {
    return { errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
  }
  const result = await graphql({
    schema,
    source: request.query,
    rootValue: rootValue(ctx, now),
    variableValues: (request.variables ?? undefined) as Record<string, unknown> | undefined,
    operationName: typeof request.operationName === 'string' ? request.operationName : undefined,
  });
  const out: Record<string, unknown> = {};
  if (result.data !== undefined) out.data = result.data;
  if (result.errors) {
    out.errors = result.errors.map((error) => {
      const { type, ...extensions } = error.extensions as { type?: string };
      return {
        ...(type ? { type } : {}),
        ...(error.path ? { path: error.path } : {}),
        ...(error.locations ? { locations: error.locations } : {}),
        message: error.message,
        ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
      };
    });
  }
  return out;
}
