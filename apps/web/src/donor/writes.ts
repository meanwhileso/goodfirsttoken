import { type PrRef } from '@goodfirsttoken/core';
import { GitHubError, gitHubRest, gitHubUrls } from '../github';
import type { GitHubReader } from '../sync/github';
import { donorReader } from './github';

// What submit_work and open_pr do on GitHub, all with the donor's own token:
// fork the project's code repo, make the claim's branch, read what the
// branch holds, commit to it with createCommitOnBranch, which GitHub signs,
// compare it with the start commit, and open the PR. The rules are in
// docs/how-it-works.md, under The donor's tools.

/** GitHub refused a write the server made as the donor, and said why. */
export class WriteRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WriteRefused';
  }
}

/**
 * GitHub makes a new fork in the background, and answers 409 to its git
 * data meanwhile.
 * https://docs.github.com/en/rest/repos/forks#create-a-fork
 * https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-your-git-database
 */
export const NOT_READY = Symbol('not ready');

/** A path's entry in a commit's tree. */
export interface Entry {
  oid: string;
  /** Anything but a folder: a file, a symbolic link, or a submodule. */
  file: boolean;
  /** The size in bytes of a file or a symbolic link, as GitHub gives it. */
  byteSize: number | null;
  /** The mode Git keeps it with, like 0o100644 for a file, 0o100755 for an executable one, or 0o40000 for a folder. */
  mode: number;
}

/** The folder a path is in, as an expression's path: empty for the root. */
function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** An addition for createCommitOnBranch: a path and its content in base64. */
export interface Addition {
  path: string;
  contents: string;
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** Text as UTF-8, in base64, which createCommitOnBranch takes. */
export function textBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** A refusal from a write, as a WriteRefused. A 401 goes on up, so the agent's connection ends. */
function refusedBy(error: unknown, what: string): unknown {
  if (!(error instanceof GitHubError) || error.status === 401) return error;
  return new WriteRefused(`GitHub refused ${what} (${String(error.status)}): ${error.message}`);
}

const ENTRY_CHUNK = 100;

interface FolderAnswer {
  entries?: { name: string; type: string; mode: number; oid: string; size: number }[] | null;
}

interface CommitFactsAnswer {
  parents?: { nodes?: ({ oid?: unknown } | null)[] | null } | null;
  author?: { user?: { login?: unknown } | null } | null;
}

interface TextAnswer {
  text?: string | null;
  isTruncated?: boolean;
}

interface CommitAnswer {
  createCommitOnBranch: { commit: { oid: string } | null } | null;
}

/** Writes and reads on GitHub as the donor, with their token. */
export class DonorWriter {
  private readonly token: string;
  readonly reader: GitHubReader;

  constructor(token: string) {
    this.token = token;
    this.reader = donorReader(token);
  }

  /**
   * The donor's fork of the repo, as GitHub names it. GitHub gives back the
   * fork they already have, or starts making a new one.
   * https://docs.github.com/en/rest/repos/forks#create-a-fork
   */
  async fork(repo: string): Promise<string> {
    try {
      const fork = await gitHubRest<{ full_name?: unknown }>(this.token, 'POST', `/repos/${repo}/forks`, {
        default_branch_only: true,
      });
      if (typeof fork.full_name !== 'string') throw new WriteRefused(`GitHub named no fork of ${repo}.`);
      return fork.full_name;
    } catch (error) {
      throw refusedBy(error, `to fork ${repo}`);
    }
  }

  /**
   * The commit a branch points at, null when the repo has no such branch, or
   * NOT_READY while GitHub is still making the repo.
   * https://docs.github.com/en/rest/git/refs#get-a-reference
   */
  async branchHead(repo: string, branch: string): Promise<string | null | typeof NOT_READY> {
    try {
      const { data } = await this.reader.read<{ object?: { sha?: unknown } }>(
        `/repos/${repo}/git/ref/heads/${encodePath(branch)}`,
      );
      return typeof data.object?.sha === 'string' ? data.object.sha : null;
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      if (error instanceof GitHubError && error.status === 409) return NOT_READY;
      throw error;
    }
  }

  /**
   * Makes a branch at a commit. Answers `exists` when the branch is already
   * there, and NOT_READY while GitHub is still making the repo.
   * https://docs.github.com/en/rest/git/refs#create-a-reference
   */
  async createBranch(repo: string, branch: string, sha: string): Promise<'created' | 'exists' | typeof NOT_READY> {
    try {
      await gitHubRest(this.token, 'POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
      return 'created';
    } catch (error) {
      if (error instanceof GitHubError && error.status === 409) return NOT_READY;
      // GitHub answers 422 for a branch that is already there, and for a
      // commit it doesn't have.
      if (error instanceof GitHubError && error.status === 422 && typeof (await this.branchHead(repo, branch)) === 'string') {
        return 'exists';
      }
      throw refusedBy(error, `to make the branch ${branch} in ${repo}`);
    }
  }

  /**
   * What each path is at a commit, with its mode, or null for nothing. Each
   * is read from its folder's entries, which carry the modes. The paths go
   * in as GraphQL variables, so a path never becomes part of the query.
   */
  async entries(repo: string, rev: string, paths: readonly string[]): Promise<Map<string, Entry | null>> {
    const folders = [...new Set(paths.map(folderOf))];
    const listed = new Map<string, Map<string, Entry>>();
    for (let start = 0; start < folders.length; start += ENTRY_CHUNK) {
      const chunk = folders.slice(start, start + ENTRY_CHUNK);
      const answers = await this.objects<FolderAnswer>(
        repo,
        chunk.map((folder) => `${rev}:${folder}`),
        '... on Tree { entries { name type mode oid size } }',
      );
      chunk.forEach((folder, i) => {
        const entries = answers[i]?.entries ?? [];
        listed.set(
          folder,
          new Map(
            entries.map((entry) => [
              entry.name,
              { oid: entry.oid, file: entry.type !== 'tree', byteSize: entry.type === 'blob' ? entry.size : null, mode: entry.mode },
            ]),
          ),
        );
      });
    }
    return new Map(paths.map((path) => [path, listed.get(folderOf(path))?.get(path.slice(path.lastIndexOf('/') + 1)) ?? null]));
  }

  /** The text of each file at a commit, or null for one GitHub gave no whole text for. */
  async texts(repo: string, rev: string, paths: readonly string[]): Promise<Map<string, string | null>> {
    const found = new Map<string, string | null>();
    for (let start = 0; start < paths.length; start += ENTRY_CHUNK) {
      const chunk = paths.slice(start, start + ENTRY_CHUNK);
      const answers = await this.objects<TextAnswer>(
        repo,
        chunk.map((path) => `${rev}:${path}`),
        '... on Blob { text isTruncated }',
      );
      chunk.forEach((path, i) => {
        const answer = answers[i];
        found.set(path, answer?.isTruncated === false && typeof answer.text === 'string' ? answer.text : null);
      });
    }
    return found;
  }

  /**
   * A commit's parents, and the login of the GitHub account its author is,
   * or null when GitHub shows no such commit in the repo.
   */
  async commitFacts(repo: string, sha: string): Promise<{ parents: string[]; author: string | null } | null> {
    const [answer] = await this.objects<CommitFactsAnswer>(
      repo,
      [sha],
      '... on Commit { parents(first: 2) { nodes { oid } } author { user { login } } }',
    );
    if (answer?.parents == null) return null;
    const parents = (answer.parents.nodes ?? []).flatMap((node) => (typeof node?.oid === 'string' ? [node.oid] : []));
    const login = answer.author?.user?.login;
    return { parents, author: typeof login === 'string' ? login : null };
  }

  private async objects<T>(repo: string, expressions: readonly string[], fields: string): Promise<(T | null)[]> {
    const [owner = '', name = ''] = repo.split('/');
    const variables: Record<string, unknown> = { owner, name };
    const aliases = expressions.map((expression, i) => {
      variables[`x${String(i)}`] = expression;
      return `o${String(i)}: object(expression: $x${String(i)}) { ${fields} }`;
    });
    const declared = expressions.map((_, i) => `$x${String(i)}: String!`).join(', ');
    const query = `query ($owner: String!, $name: String!, ${declared}) {
      repository(owner: $owner, name: $name) { ${aliases.join('\n')} }
    }`;
    const { data, errors } = await this.reader.query<{ repository: Record<string, T | null> | null }>(query, variables);
    if (data?.repository == null) {
      throw new Error(`GitHub could not read ${repo}: ${errors[0]?.message ?? 'no repository'}`);
    }
    const repository = data.repository;
    return expressions.map((_, i) => repository[`o${String(i)}`] ?? null);
  }

  /**
   * A file's content at GitHub, in base64, found by its blob's ID.
   * https://docs.github.com/en/rest/git/blobs#get-a-blob
   */
  async blob(repo: string, oid: string): Promise<string> {
    const { data } = await this.reader.read<{ content?: unknown; encoding?: unknown }>(`/repos/${repo}/git/blobs/${oid}`);
    if (typeof data.content !== 'string' || data.encoding !== 'base64') {
      throw new Error(`GitHub gave no content for the blob ${oid} in ${repo}.`);
    }
    return data.content.replace(/\s/g, '');
  }

  /**
   * Adds a commit to the branch, with the donor as its author. GitHub signs
   * it. Answers `stale` when the branch moved from `expectedHead` since it
   * was read.
   * https://docs.github.com/en/graphql/reference/mutations#createcommitonbranch
   */
  async commit(input: {
    repo: string;
    branch: string;
    expectedHead: string;
    additions: readonly Addition[];
    deletions: readonly string[];
    headline: string;
    body: string;
  }): Promise<{ sha: string } | 'stale'> {
    const mutation = `mutation ($input: CreateCommitOnBranchInput!) {
      createCommitOnBranch(input: $input) { commit { oid } }
    }`;
    let answer: { data: CommitAnswer | null; errors: { type?: string; message: string }[] };
    try {
      answer = await this.reader.query<CommitAnswer>(mutation, {
        input: {
          branch: { repositoryNameWithOwner: input.repo, branchName: input.branch },
          expectedHeadOid: input.expectedHead,
          message: { headline: input.headline, body: input.body },
          fileChanges: {
            additions: input.additions,
            deletions: input.deletions.map((path) => ({ path })),
          },
        },
      });
    } catch (error) {
      throw refusedBy(error, `the commit to ${input.repo}:${input.branch}`);
    }
    const { data, errors } = answer;
    if (errors.some((error) => error.type === 'STALE_DATA')) return 'stale';
    const oid = data?.createCommitOnBranch?.commit?.oid;
    if (typeof oid === 'string' && errors.length === 0) return { sha: oid };
    throw new WriteRefused(
      `GitHub refused the commit to ${input.repo}:${input.branch}: ${errors.map((error) => error.message).join(' ') || 'no commit came back'}`,
    );
  }

  /**
   * The paths changed from `base` to `head`, with the lines added and
   * removed, as GitHub lists them in a comparison, which names at most 300
   * files, or null when GitHub doesn't say.
   * https://docs.github.com/en/rest/commits/commits#compare-two-commits
   */
  async lineCounts(
    repo: string,
    base: string,
    head: string,
  ): Promise<{ additions: number; deletions: number; paths: string[] } | null> {
    try {
      const { data } = await this.reader.read<{ files?: { filename?: unknown; additions?: unknown; deletions?: unknown }[] }>(
        `/repos/${repo}/compare/${base}...${head}`,
      );
      if (!Array.isArray(data.files)) return null;
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
      }
      return { additions, deletions, paths };
    } catch (error) {
      if (error instanceof GitHubError && error.status !== 401) return null;
      throw error;
    }
  }

  /**
   * Opens the PR as the donor, from `head`, a branch in the repo or
   * `owner:branch` in their fork. When GitHub says a PR from that branch is
   * already open, as after an earlier try that didn't hear back, that PR is
   * the one.
   * https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request
   */
  async openPull(repo: string, input: { title: string; body: string; head: string; base: string }): Promise<PrRef> {
    try {
      const pull = await gitHubRest<{ number?: unknown; html_url?: unknown }>(this.token, 'POST', `/repos/${repo}/pulls`, {
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        maintainer_can_modify: true,
      });
      return prRef(repo, pull);
    } catch (error) {
      // GitHub answers 422 for a PR already open from the branch, among
      // other things. Its message says only that the request failed, so the
      // open PRs from the branch say which it was.
      if (error instanceof GitHubError && error.status === 422) {
        const head = input.head.includes(':') ? input.head : `${repo.split('/')[0] ?? ''}:${input.head}`;
        const { data } = await this.reader.read<{ number?: unknown; html_url?: unknown }[]>(
          `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(head)}`,
        );
        const [open] = data;
        if (open !== undefined) return prRef(repo, open);
      }
      throw refusedBy(error, `to open the PR in ${repo}`);
    }
  }
}

function prRef(repo: string, pull: { number?: unknown; html_url?: unknown }): PrRef {
  if (typeof pull.number !== 'number' || typeof pull.html_url !== 'string') {
    throw new WriteRefused(`GitHub opened a PR in ${repo} and gave no number or link for it.`);
  }
  return { repo, number: pull.number, url: pull.html_url };
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
