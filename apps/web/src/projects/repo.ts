import { GitHubError, gitHubGraphQL, gitHubRest } from '../github';

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
  /** Whether the repo takes pull requests at all. */
  hasPullRequests: boolean;
  /** Who can open a pull request: `all` or `collaborators_only`. */
  pullRequestCreationPolicy: string | null;
}

interface RepoResponse {
  full_name: string;
  private: boolean;
  visibility?: string;
  archived: boolean;
  has_pull_requests?: boolean;
  pull_request_creation_policy?: string;
}

// https://docs.github.com/en/rest/repos/repos#get-a-repository
export async function readRepo(token: string, repo: string): Promise<RepoFacts> {
  const found = await gitHubRest<RepoResponse>(token, 'GET', `/repos/${repo}`);
  return {
    fullName: found.full_name,
    private: found.private,
    visibility: found.visibility ?? null,
    archived: found.archived,
    hasPullRequests: found.has_pull_requests === true,
    pullRequestCreationPolicy: found.pull_request_creation_policy ?? null,
  };
}

/**
 * Why the repo can't be registered, or null when it can: it must be public,
 * not archived, and take pull requests from anyone. A setting GitHub leaves
 * out counts against the repo, so a repo is never let in on a guess.
 */
export function whyNotEligible(facts: RepoFacts): string | null {
  const name = facts.fullName;
  if (facts.private || (facts.visibility !== null && facts.visibility !== 'public')) {
    return `${name} is not public. Only public repos can be registered.`;
  }
  if (facts.archived) return `${name} is archived on GitHub. Only a repo that takes changes can be registered.`;
  if (!facts.hasPullRequests) return `${name} has pull requests turned off on GitHub. Turn them on to register it.`;
  if (facts.pullRequestCreationPolicy !== 'all') {
    return `${name} lets only collaborators open pull requests. Let anyone open them on GitHub to register it.`;
  }
  return null;
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

/** A file read from the repo's default branch. */
export interface RepoFile {
  /** The path in the repo, like `.github/CONTRIBUTING.md`. */
  path: string;
  text: string;
}

/** The files a proposal reads. Each is null when the repo has none. */
export interface RepoDocs {
  contributing: RepoFile | null;
  aiPolicy: RepoFile | null;
  agents: RepoFile | null;
  prTemplate: RepoFile | null;
}

type DocKind = keyof RepoDocs;

/** Where each file is looked for, in order, and the names it goes by, without case. */
const DOC_FILES: Record<DocKind, { folders: string[]; name: RegExp }> = {
  contributing: { folders: ['', '.github', 'docs'], name: /^contributing(\.(md|markdown|rst|txt|adoc))?$/i },
  aiPolicy: { folders: ['', '.github', 'docs'], name: /^ai[-_]?policy(\.(md|markdown|rst|txt))?$/i },
  agents: { folders: [''], name: /^agents\.md$/i },
  prTemplate: { folders: ['', '.github', 'docs'], name: /^pull_request_template(\.(md|markdown|txt))?$/i },
};

/** Files larger than this are left unread. */
export const MAX_DOC_BYTES = 100_000;

const FOLDER_ALIASES: Record<string, string> = { '': 'root', '.github': 'dotGithub', docs: 'docs' };

interface TreeEntry {
  name: string;
  type: string;
  size: number;
}

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
        root: object(expression: "HEAD:") { ... on Tree { entries { name type size } } }
        dotGithub: object(expression: "HEAD:.github") { ... on Tree { entries { name type size } } }
        docs: object(expression: "HEAD:docs") { ... on Tree { entries { name type size } } }
      }
    }`,
    { owner, name },
  );
  if (listing.errors.length > 0) throw graphQLFailure(repo, listing.errors);
  const folders = listing.data?.repository ?? {};

  const paths: Partial<Record<DocKind, string>> = {};
  for (const [kind, { folders: where, name: pattern }] of Object.entries(DOC_FILES) as [DocKind, (typeof DOC_FILES)[DocKind]][]) {
    for (const folder of where) {
      const entry = folders[FOLDER_ALIASES[folder] ?? '']?.entries?.find(
        (e) => e.type === 'blob' && pattern.test(e.name) && e.size <= MAX_DOC_BYTES,
      );
      if (entry) {
        paths[kind] = folder ? `${folder}/${entry.name}` : entry.name;
        break;
      }
    }
  }

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

/** The label Good First Token creates when a maintainer picks the tag. */
export const OUR_LABEL = {
  name: 'goodfirsttoken',
  color: '7057ff',
  description: 'Tagged for outside help through Good First Token',
};

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
