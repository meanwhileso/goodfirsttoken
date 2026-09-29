import type { ManagedRepo } from '../auth/permissions';
import { GitHubError, gitHubGraphQL, gitHubRest } from '../github';
import { docFolderFields, findDocs, type DocKind, type RepoDocs, type TreeEntry } from './docs';
import { OUR_LABEL } from './rules';

// What registering a project reads from GitHub, and the one thing it writes
// there: the goodfirsttoken label. Every call runs with the maintainer's own
// token, passed in. The rules these reads feed are in docs/how-it-works.md,
// under Registering a project.

/** A repo as GitHub describes it, with what registration checks. */
export interface RepoFacts {
  /** The repo as GitHub names it, `owner/name`, which can differ in case from what was asked. */
  fullName: string;
  private: boolean;
  /** `public`, `private`, or `internal`, when GitHub says. */
  visibility: string | null;
  archived: boolean;
  /** Whether the repo takes pull requests at all, or null when GitHub didn't say. */
  hasPullRequests: boolean | null;
  /** Who can open a pull request, `all` or `collaborators_only`, or null when GitHub didn't say. */
  pullRequestCreationPolicy: string | null;
}

/**
 * The facts registration checks, from the repo the `manage_project`
 * permission read with the caller's token.
 */
export function repoFacts(found: ManagedRepo): RepoFacts {
  return {
    fullName: found.full_name,
    private: found.private,
    visibility: found.visibility ?? null,
    archived: found.archived,
    hasPullRequests: typeof found.has_pull_requests === 'boolean' ? found.has_pull_requests : null,
    pullRequestCreationPolicy: found.pull_request_creation_policy ?? null,
  };
}

/**
 * Why the repo can't be registered, or null when it can: it must be public,
 * not archived, and take pull requests from anyone. GitHub documents both
 * pull request fields for a repo, but its schema doesn't promise them, so a
 * repo GitHub says nothing about on either is refused. A repo is never let in
 * on a guess.
 */
export function whyNotEligible(facts: RepoFacts, action: 'register' | 'list' = 'register'): string | null {
  const name = facts.fullName;
  const done = action === 'register' ? 'registered' : 'listed';
  const fromAnyone = `Only a repo that takes pull requests from anyone can be ${done}.`;
  if (facts.private || (facts.visibility !== null && facts.visibility !== 'public')) {
    return `${name} is not public. Only public repos can be ${done}.`;
  }
  if (facts.archived) return `${name} is archived on GitHub. Only a repo that takes changes can be ${done}.`;
  if (facts.hasPullRequests === null) return `GitHub didn't say whether ${name} takes pull requests. ${fromAnyone}`;
  // A maintainer can change the repo's settings on GitHub. An admin can't.
  const fix = (what: string) => (action === 'register' ? `${what} on GitHub to register it.` : fromAnyone);
  if (!facts.hasPullRequests) return `${name} has pull requests turned off on GitHub. ${fix('Turn them on')}`;
  if (facts.pullRequestCreationPolicy === null) {
    return `GitHub didn't say who can open pull requests on ${name}. ${fromAnyone}`;
  }
  if (facts.pullRequestCreationPolicy !== 'all') {
    return `${name} lets only collaborators open pull requests. ${fix('Let anyone open them')}`;
  }
  return null;
}

/**
 * Why a repo can't hold a project's tagged issues, or null when it can: it
 * must be public and not archived. Pull requests go to the code repo, so the
 * issue repo's pull request settings don't count.
 */
export function whyNotIssueRepo(facts: RepoFacts): string | null {
  const name = facts.fullName;
  if (facts.private || (facts.visibility !== null && facts.visibility !== 'public')) {
    return `The issue repo ${name} is not public. Keep this project's issues in a public repo.`;
  }
  if (facts.archived) {
    return `The issue repo ${name} is archived on GitHub. Keep this project's issues in a repo that takes changes.`;
  }
  return null;
}

/** A repo as GitHub describes it, with what an admin weighs. */
// https://docs.github.com/en/rest/repos/repos#get-a-repository
export interface ListedRepo extends ManagedRepo {
  stargazers_count: number;
  created_at: string;
  /** GitHub's docs allow null. */
  pushed_at: string | null;
  owner: { login: string };
}

/** What GitHub says about a repo, for an admin to weigh, with times in milliseconds. */
export interface Standing {
  stars: number;
  createdAt: number;
  pushedAt: number;
  ownerCreatedAt: number;
}

/**
 * Reads a public repo with the token given, or null when GitHub shows none
 * by that name, as it answers for a private repo to a token with only
 * `public_repo`. Other refusals go on up.
 */
export async function readRepo(token: string, repo: string): Promise<ListedRepo | null> {
  try {
    return await gitHubRest<ListedRepo>(token, 'GET', `/repos/${repo}`);
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return null;
    throw error;
  }
}

/**
 * The repo's stars, when it was made, its last push, and when its owner's
 * account was made, from two reads with the token given: the repo, and its
 * owner. Null when GitHub shows no public repo by that name. Every other
 * failure goes on up, even a 404 for the owner the repo named, so a read
 * that failed never passes for a repo that isn't public.
 */
// https://docs.github.com/en/rest/users/users#get-a-user
export async function readStanding(token: string, repo: string): Promise<{ repo: ListedRepo; standing: Standing } | null> {
  const found = await readRepo(token, repo);
  if (found === null) return null;
  const owner = await gitHubRest<{ created_at: string }>(token, 'GET', `/users/${encodeURIComponent(found.owner.login)}`);
  const createdAt = Date.parse(found.created_at);
  const pushedAt = found.pushed_at === null ? createdAt : Date.parse(found.pushed_at);
  const standing = { stars: found.stargazers_count, createdAt, pushedAt, ownerCreatedAt: Date.parse(owner.created_at) };
  if (!Object.values(standing).every(Number.isFinite)) {
    throw new Error(`GitHub described ${found.full_name} in a shape it doesn't document.`);
  }
  return { repo: found, standing };
}

const LABEL_PAGE = 100;
const LABEL_PAGES = 10;

/** The names of the repo's labels, the first 1,000. */
// https://docs.github.com/en/rest/issues/labels#list-labels-for-a-repository
export async function readLabels(token: string, repo: string): Promise<string[]> {
  const names: string[] = [];
  for (let page = 1; page <= LABEL_PAGES; page++) {
    const labels = await gitHubRest<{ name: string }[]>(
      token,
      'GET',
      `/repos/${repo}/labels?per_page=${String(LABEL_PAGE)}&page=${String(page)}`,
    );
    names.push(...labels.map((label) => label.name));
    if (labels.length < LABEL_PAGE) break;
  }
  return names;
}

export { MAX_DOC_BYTES, type RepoDocs, type RepoFile } from './docs';

type Tree = { entries?: TreeEntry[] } | null;

function graphQLFailure(repo: string, errors: { message: string }[]): Error {
  return new Error(`GitHub could not read the files in ${repo}: ${errors.map((e) => e.message).join(' ')}`);
}

/**
 * Reads CONTRIBUTING, the AI policy file, AGENTS.md, and the PR template from
 * the repo's default branch, in two GraphQL queries: one lists the root,
 * `.github/`, and `docs/`, and one reads the files found there. Each file is
 * the first whose name matches, looking in the root, then `.github/`, then
 * `docs/`.
 */
// https://docs.github.com/en/graphql/reference/repos#object-repository
export async function readDocs(token: string, repo: string): Promise<RepoDocs> {
  const [owner = '', name = ''] = repo.split('/');
  const listing = await gitHubGraphQL<{ repository: Record<string, Tree> | null }>(
    token,
    `query ($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        ${docFolderFields()}
      }
    }`,
    { owner, name },
  );
  if (listing.errors.length > 0) throw graphQLFailure(repo, listing.errors);
  const folders = listing.data?.repository ?? {};
  const paths = findDocs((alias) => folders[alias]?.entries);

  const docs: RepoDocs = { contributing: null, aiPolicy: null, agents: null, prTemplate: null };
  const kinds = Object.keys(paths) as DocKind[];
  if (kinds.length === 0) return docs;
  // The paths go in as variables, so a file's name is never read as part of the query.
  const variables: Record<string, string> = { owner, name };
  kinds.forEach((kind, i) => (variables[`f${String(i)}`] = `HEAD:${paths[kind] ?? ''}`));
  const read = await gitHubGraphQL<{ repository: Record<string, { text?: string | null } | null> | null }>(
    token,
    `query ($owner: String!, $name: String!, ${kinds.map((_, i) => `$f${String(i)}: String!`).join(', ')}) {
      repository(owner: $owner, name: $name) {
        ${kinds.map((_, i) => `f${String(i)}: object(expression: $f${String(i)}) { ... on Blob { text } }`).join('\n')}
      }
    }`,
    variables,
  );
  if (read.errors.length > 0) throw graphQLFailure(repo, read.errors);
  kinds.forEach((kind, i) => {
    const text = read.data?.repository?.[`f${String(i)}`]?.text;
    const path = paths[kind];
    if (typeof text === 'string' && path !== undefined) docs[kind] = { path, text };
  });
  return docs;
}

export { OUR_LABEL };

/**
 * Makes sure the repo has the goodfirsttoken label, creating it with the
 * maintainer's token when it doesn't. True when this call created it. A label
 * of that name in any case already counts. Throws a GitHubError when GitHub
 * refuses.
 */
// https://docs.github.com/en/rest/issues/labels#get-a-label
// https://docs.github.com/en/rest/issues/labels#create-a-label
export async function createOurLabel(token: string, repo: string): Promise<boolean> {
  const path = `/repos/${repo}/labels/${encodeURIComponent(OUR_LABEL.name)}`;
  const exists = async () => {
    try {
      await gitHubRest(token, 'GET', path);
      return true;
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return false;
      throw error;
    }
  };
  if (await exists()) return false;
  try {
    await gitHubRest(token, 'POST', `/repos/${repo}/labels`, OUR_LABEL);
    return true;
  } catch (error) {
    // GitHub answers 422 when a label of that name was made in the meantime.
    if (error instanceof GitHubError && error.status === 422 && (await exists())) return false;
    throw error;
  }
}
