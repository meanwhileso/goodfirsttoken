import { labelName, type ProjectRecord, type Refusal } from '@goodfirsttoken/core';
import { judgeLabels } from '../db';
import { GitHubError, gitHubQuery, gitHubRead, type GitHubPage, type GraphQLResult } from '../github';
import { limitsRate, type GitHubReader } from '../sync/github';
import { chooseLink, closingReferences, crossReferences, linksOf, type Link } from '../sync/issues';

// What the donor's tools read from GitHub, all with the donor's own token:
// the facts about a project's repo a claim needs, and each issue as it is
// now. The linked PRs are read the way the sync reads them
// (src/sync/issues.ts), with the donor's token in place of the service
// token. The rules are in docs/how-it-works.md, under The donor's tools.

/**
 * Reads GitHub as the donor. A refusal comes back as GitHub's error, so a
 * 401 ends the agent's connection (src/mcp/server.ts). A GraphQL answer that
 * says the donor's budget ran out is a refusal too, since it carries no
 * data to read.
 */
export function donorReader(token: string): GitHubReader {
  return new DonorGitHub(token);
}

class DonorGitHub implements GitHubReader {
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  read<T>(path: string): Promise<GitHubPage<T>> {
    return gitHubRead<T>(this.token, path);
  }

  async query<T>(query: string, variables: Record<string, unknown>): Promise<GraphQLResult<T>> {
    const { data, errors } = await gitHubQuery<T>(this.token, query, variables);
    const limited = errors.find(limitsRate);
    if (limited) throw new GitHubError(403, `GitHub refused a query for the rate limit: ${limited.message}`);
    return { data, errors };
  }
}

/** What a claim needs to know about a project's code repo. */
export interface RepoFacts {
  /** The repo as GitHub names it now. */
  name: string;
  /** The default branch, which a PR goes into, or null for an empty repo. */
  defaultBranch: string | null;
  /** The head commit of the default branch, where a claim's work starts, or null for an empty repo. */
  head: string | null;
  /** The donor is an admin or maintainer of the repo, so the work is on their own project. */
  managed: boolean;
  /** The donor is a collaborator with write access or more: write, maintain, or admin. */
  writer: boolean;
  /** The vouch file, or null when the repo has none. */
  vouchFile: { path: string; text: string } | null;
}

interface VouchBlob {
  text?: string | null;
}

interface RepoAnswer {
  repository: {
    nameWithOwner: string;
    viewerPermission: string | null;
    defaultBranchRef: { name: string; target: { oid: string } | null } | null;
    dotGithub: VouchBlob | null;
    root: VouchBlob | null;
  } | null;
}

/**
 * Where the vouch file is read from, in order: .github/, which vouch's
 * GitHub checks read and Ghostty keeps it in, then the repo's root, which
 * vouch's command line also looks in.
 */
export const VOUCH_PATHS = ['.github/VOUCHED.td', 'VOUCHED.td'] as const;

const REPO_FACTS = `query ($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    viewerPermission
    defaultBranchRef { name target { oid } }
    dotGithub: object(expression: "HEAD:${VOUCH_PATHS[0]}") { ... on Blob { text } }
    root: object(expression: "HEAD:${VOUCH_PATHS[1]}") { ... on Blob { text } }
  }
}`;

/** GitHub's names for a permission of write access or more. */
const WRITE_OR_MORE = new Set(['WRITE', 'MAINTAIN', 'ADMIN']);

/**
 * The facts about a code repo that a claim needs, in one GraphQL query with
 * the donor's token. Null when GitHub shows the donor no such repo.
 */
export async function readRepoFacts(reader: GitHubReader, repo: string): Promise<RepoFacts | null> {
  const [owner = '', name = ''] = repo.split('/');
  const { data, errors } = await reader.query<RepoAnswer>(REPO_FACTS, { owner, name });
  const found = data?.repository ?? null;
  const other = errors.find((error) => error.type !== 'NOT_FOUND');
  if (other !== undefined) throw new Error(`GitHub could not read ${repo}: ${other.message}`);
  if (found === null) return null;
  const files = [
    { path: VOUCH_PATHS[0], text: found.dotGithub?.text },
    { path: VOUCH_PATHS[1], text: found.root?.text },
  ];
  const file = files.find((f): f is { path: (typeof VOUCH_PATHS)[number]; text: string } => typeof f.text === 'string');
  return {
    name: found.nameWithOwner,
    defaultBranch: found.defaultBranchRef?.name ?? null,
    head: found.defaultBranchRef?.target?.oid ?? null,
    managed: found.viewerPermission === 'ADMIN' || found.viewerPermission === 'MAINTAIN',
    writer: WRITE_OR_MORE.has(found.viewerPermission ?? ''),
    vouchFile: file ?? null,
  };
}

// https://docs.github.com/en/rest/issues/issues#get-an-issue
interface RestIssue {
  title?: unknown;
  body?: unknown;
  state?: unknown;
  html_url?: unknown;
  repository_url?: unknown;
  labels?: (string | { name?: unknown })[];
  assignees?: unknown[] | null;
  assignee?: unknown;
  pull_request?: unknown;
}

/** An issue as GitHub shows it to the donor now. */
export interface GitHubIssue {
  title: string;
  body: string;
  /** The issue on GitHub. */
  url: string;
  open: boolean;
  labels: string[];
  assigned: boolean;
  /** GitHub keeps pull requests and issues under the same numbers. */
  isPullRequest: boolean;
  /** The repo GitHub names the issue's repo now, or null when it doesn't say. */
  repo: string | null;
}

function splitIssue(issue: string): { repo: string; number: number } {
  const hash = issue.lastIndexOf('#');
  return { repo: issue.slice(0, hash), number: Number(issue.slice(hash + 1)) };
}

/** The issue as GitHub shows it to the donor, or null when GitHub shows no such issue. */
export async function readIssue(reader: GitHubReader, issue: string): Promise<GitHubIssue | null> {
  const { repo, number } = splitIssue(issue);
  let found: RestIssue;
  try {
    found = (await reader.read<RestIssue>(`/repos/${repo}/issues/${String(number)}`)).data;
  } catch (error) {
    if (error instanceof GitHubError && (error.status === 404 || error.status === 410)) return null;
    throw error;
  }
  const labels = (found.labels ?? []).flatMap((label) => {
    const checked = labelName.safeParse(typeof label === 'string' ? label : label.name);
    return checked.success ? [checked.data] : [];
  });
  const repoMatch = /\/repos\/([^/]+\/[^/]+)$/.exec(typeof found.repository_url === 'string' ? found.repository_url : '');
  return {
    title: typeof found.title === 'string' ? found.title : issue,
    body: typeof found.body === 'string' ? found.body : '',
    url: typeof found.html_url === 'string' ? found.html_url : '',
    open: found.state === 'open',
    labels,
    assigned: (found.assignees?.length ?? 0) > 0 || (found.assignee ?? null) !== null,
    isPullRequest: found.pull_request !== undefined && found.pull_request !== null,
    repo: repoMatch?.[1] ?? null,
  };
}

/**
 * The open PRs GitHub links to the issue now, read with the donor's token,
 * by the sync's rule under Linked PRs: a closing reference or a mention, from
 * a PR open in the project's code repo or issue repo. `names` are other names
 * GitHub gives the project's repos now, as after a rename. Null when GitHub
 * shows the donor no such issue.
 */
export async function linkedPrs(
  reader: GitHubReader,
  project: ProjectRecord,
  issue: string,
  names: readonly string[] = [],
): Promise<Link[] | null> {
  const { repo: issueRepo, number } = splitIssue(issue);
  const closes = (await closingReferences(reader, issueRepo, [number])).get(number);
  const mentions = await crossReferences(reader, issueRepo, number);
  if (closes === undefined || mentions === null) return null;
  // A PR counts only in the project's code repo or issue repo, as the sync
  // counts it, by the names the project keeps and the names GitHub gives.
  const ours = new Set(
    [project.repo, project.settings.issueRepo ?? project.repo, issueRepo, ...names].map((name) => name.toLowerCase()),
  );
  return linksOf(closes, mentions).filter((link) => ours.has(link.pr.repo.toLowerCase()));
}

export type IssueCheck = { ok: true; issue: GitHubIssue } | { ok: false; refusal: Refusal };

function notEligible(message: string): IssueCheck {
  return { ok: false, refusal: { code: 'issue_not_eligible', message } };
}

/**
 * Checks the issue on GitHub with the donor's token, as spec section 6
 * asks before suggesting and before claiming: it is still open, carries one
 * of the project's tags and none of its excluded tags, by the rule the
 * homepage counts with (src/db/waiting.ts), has no assignee, and has no open
 * PR linked to it in the project's code repo or issue repo, by the sync's
 * rule. `names` are other names GitHub gives the project's repos now, as
 * after a rename.
 */
export async function checkIssueOnGitHub(
  db: D1Database,
  reader: GitHubReader,
  project: ProjectRecord,
  issue: string,
  names: readonly string[] = [],
): Promise<IssueCheck> {
  const found = await readIssue(reader, issue);
  if (found === null) return notEligible(`GitHub shows you no issue ${issue}. Pick another issue.`);
  if (found.isPullRequest) return notEligible(`${issue} is a pull request on GitHub. Pick an issue.`);
  if (!found.open) return notEligible(`${issue} is closed on GitHub. Pick another issue.`);
  if (found.assigned) return notEligible(`${issue} has an assignee on GitHub, so someone is on it. Pick another issue.`);
  const { carries, excluded } = await judgeLabels(db, project.repo, found.labels);
  if (!carries) {
    return notEligible(
      excluded === null
        ? `${issue} no longer carries a tag ${project.repo} marks work for outside help with. Pick another issue.`
        : `${issue} carries ${excluded}, a label ${project.repo} keeps for people. Pick another issue.`,
    );
  }

  const links = await linkedPrs(reader, project, issue, found.repo === null ? names : [...names, found.repo]);
  if (links === null) return notEligible(`GitHub shows you no issue ${issue}. Pick another issue.`);
  const linked = chooseLink(null, links);
  if (linked !== null) {
    return {
      ok: false,
      refusal: {
        code: 'pr_exists',
        message: `${issue} has an open PR, ${linked.pr.url}, so it takes no new claims. Pick another issue.`,
      },
    };
  }
  return { ok: true, issue: found };
}
