import { GitHubError, gitHubUrls } from '../github';
import type { GitHubReader } from '../sync/github';
import { donorReader } from './github';

// What the donor's tools read from GitHub about a claim's pushed branch and
// its PR, all with the donor's own token: the branch's head, its repo and
// the repo that repo was forked from, comparisons with its commits, and the
// PR to check against a clearance. None of it writes to GitHub
// (docs/specs/agent-submits.md). The rules are in docs/how-it-works.md,
// under The donor's tools.

/** A PR as GitHub shows it: where it goes and comes from, who made it and when, and its words. */
export interface PullFacts {
  number: number;
  url: string;
  /** Open, merged, or closed without merging. */
  state: 'open' | 'merged' | 'closed';
  /** When GitHub made it, in milliseconds. */
  createdAt: number;
  /** The GitHub ID of the account that opened it. */
  authorId: number | null;
  baseRepo: string;
  baseRef: string;
  /** The base repo's default branch, as GitHub gives it with the PR, or null when it doesn't. */
  baseDefault: string | null;
  /** The repo it comes from, or null when that fork was deleted. */
  headRepo: string | null;
  headRef: string;
  headSha: string;
  title: string;
  body: string;
}

/** A PR from GitHub's REST answer, or null when a field is missing. */
export function pullFacts(data: unknown): PullFacts | null {
  const pull = data as {
    number?: unknown;
    html_url?: unknown;
    state?: unknown;
    merged_at?: unknown;
    created_at?: unknown;
    user?: { id?: unknown } | null;
    base?: { ref?: unknown; repo?: { full_name?: unknown; default_branch?: unknown } | null };
    head?: { ref?: unknown; sha?: unknown; repo?: { full_name?: unknown } | null };
    title?: unknown;
    body?: unknown;
  } | null;
  const baseRepo = pull?.base?.repo?.full_name;
  const headRepo = pull?.head?.repo?.full_name;
  if (
    pull === null ||
    typeof pull.number !== 'number' ||
    typeof pull.html_url !== 'string' ||
    typeof pull.created_at !== 'string' ||
    typeof baseRepo !== 'string' ||
    typeof pull.base?.ref !== 'string' ||
    typeof pull.head?.ref !== 'string' ||
    typeof pull.head.sha !== 'string'
  ) {
    return null;
  }
  return {
    number: pull.number,
    url: pull.html_url,
    state: pull.state === 'open' ? 'open' : typeof pull.merged_at === 'string' ? 'merged' : 'closed',
    createdAt: Date.parse(pull.created_at),
    authorId: typeof pull.user?.id === 'number' ? pull.user.id : null,
    baseRepo,
    baseRef: pull.base.ref,
    baseDefault: typeof pull.base.repo?.default_branch === 'string' ? pull.base.repo.default_branch : null,
    headRepo: typeof headRepo === 'string' ? headRepo : null,
    headRef: pull.head.ref,
    headSha: pull.head.sha,
    title: typeof pull.title === 'string' ? pull.title : '',
    body: typeof pull.body === 'string' ? pull.body : '',
  };
}

/** A commit in a comparison: its message, how many parents it has, and its author's login, or null when GitHub names no user. */
export interface ComparedCommit {
  sha: string;
  message: string;
  parents: number;
  author: string | null;
}

/** GitHub's comparison of two commits, as `BranchReader.comparison` reads it. */
export interface Comparison {
  /** `ahead`, `behind`, `diverged`, or `identical`, as GitHub says. */
  status: string;
  aheadBy: number;
  /** The commits `head` has that `base` doesn't, oldest first, as GitHub lists at most 250. */
  commits: ComparedCommit[];
  additions: number;
  deletions: number;
  /** How many files GitHub listed, at most 300. */
  files: number;
  paths: string[];
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** Reads on GitHub as the donor, with their token. */
export class BranchReader {
  readonly reader: GitHubReader;

  constructor(token: string) {
    this.reader = donorReader(token);
  }

  /**
   * The commit a branch points at, or null when GitHub shows no such branch,
   * as for a repo it is still making.
   * https://docs.github.com/en/rest/git/refs#get-a-reference
   */
  async branchHead(repo: string, branch: string): Promise<string | null> {
    try {
      const { data } = await this.reader.read<{ object?: { sha?: unknown } }>(
        `/repos/${repo}/git/ref/heads/${encodePath(branch)}`,
      );
      return typeof data.object?.sha === 'string' ? data.object.sha : null;
    } catch (error) {
      // GitHub answers 409 to the git data of a repo it is still making.
      if (error instanceof GitHubError && (error.status === 404 || error.status === 409)) return null;
      throw error;
    }
  }

  /**
   * GitHub's comparison of `head` with `base`: whether `head` is ahead of it,
   * the commits it has that `base` doesn't, the files they change, a renamed
   * file's old path with its new one, and the lines added and removed.
   * GitHub lists at most 250 commits and 300 files in one. Null when GitHub
   * doesn't say.
   * https://docs.github.com/en/rest/commits/commits#compare-two-commits
   */
  async comparison(repo: string, base: string, head: string): Promise<Comparison | null> {
    try {
      const { data } = await this.reader.read<{
        status?: unknown;
        ahead_by?: unknown;
        commits?: { sha?: unknown; commit?: { message?: unknown }; parents?: unknown[]; author?: { login?: unknown } | null }[];
        files?: { filename?: unknown; previous_filename?: unknown; additions?: unknown; deletions?: unknown }[];
      }>(`/repos/${repo}/compare/${base}...${head}`);
      if (typeof data.status !== 'string' || typeof data.ahead_by !== 'number') return null;
      if (!Array.isArray(data.files) || !Array.isArray(data.commits)) return null;
      let additions = 0;
      let deletions = 0;
      const paths: string[] = [];
      for (const file of data.files) {
        if (typeof file.additions !== 'number' || typeof file.deletions !== 'number' || typeof file.filename !== 'string') {
          return null;
        }
        additions += file.additions;
        deletions += file.deletions;
        paths.push(file.filename);
        // A file renamed was at its old path too.
        if (typeof file.previous_filename === 'string') paths.push(file.previous_filename);
      }
      const commits: ComparedCommit[] = [];
      for (const commit of data.commits) {
        if (typeof commit.sha !== 'string' || typeof commit.commit?.message !== 'string') return null;
        const login = commit.author?.login;
        commits.push({
          sha: commit.sha,
          message: commit.commit.message,
          parents: Array.isArray(commit.parents) ? commit.parents.length : 0,
          author: typeof login === 'string' ? login : null,
        });
      }
      return { status: data.status, aheadBy: data.ahead_by, commits, additions, deletions, files: data.files.length, paths };
    } catch (error) {
      if (error instanceof GitHubError && error.status !== 401) return null;
      throw error;
    }
  }

  /**
   * A repo as GitHub names it, with the repo it was forked from and the one
   * at the root of its fork network, or null when GitHub shows no such repo.
   * https://docs.github.com/en/rest/repos/repos#get-a-repository
   */
  async repoOf(repo: string): Promise<{ name: string; parent: string | null; source: string | null } | null> {
    try {
      const { data } = await this.reader.read<{
        full_name?: unknown;
        parent?: { full_name?: unknown } | null;
        source?: { full_name?: unknown } | null;
      }>(`/repos/${repo}`);
      if (typeof data.full_name !== 'string') return null;
      const parent = data.parent?.full_name;
      const source = data.source?.full_name;
      return {
        name: data.full_name,
        parent: typeof parent === 'string' ? parent : null,
        source: typeof source === 'string' ? source : null,
      };
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * A PR as GitHub shows it, for checking against a clearance, or null when
   * GitHub shows no such PR.
   * https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request
   */
  async pull(repo: string, number: number): Promise<PullFacts | null> {
    try {
      const { data } = await this.reader.read<unknown>(`/repos/${repo}/pulls/${String(number)}`);
      return pullFacts(data);
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * The branch a PR comes from, and the repo it is in, or null when GitHub
   * doesn't say. The repo is null when its fork was deleted.
   * https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request
   */
  async pullHead(repo: string, number: number): Promise<{ ref: string; repo: string | null } | null> {
    try {
      const { data } = await this.reader.read<{ head?: { ref?: unknown; repo?: { full_name?: unknown } | null } }>(
        `/repos/${repo}/pulls/${String(number)}`,
      );
      if (typeof data.head?.ref !== 'string') return null;
      const name = data.head.repo?.full_name;
      return { ref: data.head.ref, repo: typeof name === 'string' ? name : null };
    } catch (error) {
      if (error instanceof GitHubError && error.status !== 401) return null;
      throw error;
    }
  }
}

/** The web page of a branch, and of its change from a commit. */
export function branchUrls(repo: string, branch: string, from: string): { branch: string; diff: string } {
  const web = gitHubUrls().web;
  return {
    branch: `${web}/${repo}/tree/${encodePath(branch)}`,
    diff: `${web}/${repo}/compare/${from}...${encodePath(branch)}`,
  };
}

/** The web page of a commit. */
export function commitUrl(repo: string, sha: string): string {
  return `${gitHubUrls().web}/${repo}/commit/${sha}`;
}
