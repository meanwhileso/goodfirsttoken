import { repoName } from '@goodfirsttoken/core';
import type { ManagedRepo } from '../auth/permissions';
import { GitHubError } from '../github';
import { docFolderFields, findDocs, MAX_DOC_BYTES, readableFile, type DocKind, type TreeEntry } from '../projects/docs';
import { repoFacts, whyNotEligible, type Standing } from '../projects/repo';
import type { ServiceGitHub } from '../sync/github';
import type { PolicyFile, PolicyFileKind, RepoLabel } from './rules';

// What the policy crawler reads from GitHub, with the read-only service
// token, through the job's ServiceGitHub, which stops the run when the budget
// runs low. Each batch of repos takes one GraphQL query for their facts and
// folders, and one for every 50 of their files. Only a repo whose docs
// welcome AI help costs more: one REST call for its pull request settings,
// and a GraphQL query for each 100 of its labels.

/** GitHub's largest page. */
const PAGE = 100;
/** The most labels read for a repo, as a proposal reads. */
const MAX_LABEL_PAGES = 10;
/** The most files one GraphQL query reads. */
const FILES_PER_QUERY = 50;
/** The most issue templates, and agent skills, read in a repo. */
const MAX_EXTRA_FILES = 3;

// The files the crawler reads beyond the ones a proposal reads.
const CLAUDE_MD = /^claude\.md$/i;
const VOUCH_FILE = /^vouched\.td$/i;
const ISSUE_TEMPLATE = /\.(?:md|markdown|ya?ml)$/i;
const SKILL_MD = /^skill\.md$/i;
const SKILL_FOLDERS = [
  { path: '.claude/skills', alias: 'claudeSkills' },
  { path: 'skills', alias: 'skills' },
];

/** The kind of each file a proposal reads, in the order the crawler reads them. */
const DOC_ORDER: [DocKind, PolicyFileKind][] = [
  ['aiPolicy', 'aiPolicy'],
  ['contributing', 'contributing'],
  ['agents', 'agents'],
];

type Tree = { entries?: (TreeEntry & { object?: Tree | null })[] | null } | null;

// https://docs.github.com/en/graphql/reference/repos#object-repository
interface ListedRepo {
  nameWithOwner: string;
  isArchived: boolean;
  isPrivate: boolean;
  stargazerCount: number;
  createdAt: string;
  pushedAt: string | null;
  defaultBranchRef: { name: string } | null;
  owner: { createdAt?: string } | null;
  [folder: string]: unknown;
}

/** A repo as the crawler found it: its name, its facts, and the files to read. */
export interface FoundRepo {
  /** The name the crawler asked for. */
  asked: string;
  /** The repo as GitHub names it now. */
  name: string;
  archived: boolean;
  private: boolean;
  standing: Standing | null;
  branch: string | null;
  /** The files to read, in the order the rules read them. */
  paths: { path: string; kind: PolicyFileKind }[];
  /** Whether it has a vouch file. */
  vouched: boolean;
}

const REPO_FIELDS = `
  nameWithOwner isArchived isPrivate stargazerCount createdAt pushedAt
  defaultBranchRef { name }
  owner { ... on User { createdAt } ... on Organization { createdAt } }
  ${docFolderFields()}
  issueTemplates: object(expression: "HEAD:.github/ISSUE_TEMPLATE") { ... on Tree { entries { name type size } } }
  ${SKILL_FOLDERS.map(({ path, alias }) => `${alias}: object(expression: "HEAD:${path}") { ...SkillFolders }`).join('\n')}
`;

function split(repo: string): [string, string] {
  const [owner = '', name = ''] = repo.split('/');
  return [owner, name];
}

function entriesOf(value: unknown): TreeEntry[] | undefined {
  const entries = (value as Tree)?.entries;
  return Array.isArray(entries) ? entries : undefined;
}

/** Milliseconds since the epoch for one of GitHub's times, or NaN. */
function time(value: string | null | undefined): number {
  return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}

function standingOf(listed: ListedRepo): Standing | null {
  const createdAt = time(listed.createdAt);
  const pushedAt = listed.pushedAt === null ? createdAt : time(listed.pushedAt);
  const standing = { stars: listed.stargazerCount, createdAt, pushedAt, ownerCreatedAt: time(listed.owner?.createdAt) };
  return Number.isInteger(standing.stars) && [createdAt, pushedAt, standing.ownerCreatedAt].every(Number.isFinite)
    ? standing
    : null;
}

/** The files the rules read in a repo, in the order they read them, from its folder listings. */
function pathsOf(listed: ListedRepo): { paths: FoundRepo['paths']; vouched: boolean } {
  const docs = findDocs((alias) => entriesOf(listed[alias]));
  const paths: FoundRepo['paths'] = [];
  for (const [doc, kind] of DOC_ORDER) {
    const path = docs[doc];
    if (path !== undefined) paths.push({ path, kind });
  }
  const claude = readableFile(entriesOf(listed.root), CLAUDE_MD);
  if (claude) paths.push({ path: claude.name, kind: 'claude' });
  if (docs.prTemplate !== undefined) paths.push({ path: docs.prTemplate, kind: 'prTemplate' });
  const skills = SKILL_FOLDERS.flatMap(({ path, alias }) =>
    (entriesOf(listed[alias]) ?? []).flatMap((folder) => {
      if (folder.type !== 'tree') return [];
      const skill = readableFile(entriesOf((folder as TreeEntry & { object?: Tree }).object), SKILL_MD);
      return skill ? [{ path: `${path}/${folder.name}/${skill.name}`, kind: 'skill' as const }] : [];
    }),
  );
  paths.push(...skills.slice(0, MAX_EXTRA_FILES));
  const templates = (entriesOf(listed.issueTemplates) ?? [])
    .filter((e) => e.type === 'blob' && ISSUE_TEMPLATE.test(e.name) && !/^config\./i.test(e.name) && e.size <= MAX_DOC_BYTES)
    .slice(0, MAX_EXTRA_FILES)
    .map((e) => ({ path: `.github/ISSUE_TEMPLATE/${e.name}`, kind: 'issueTemplate' as const }));
  paths.push(...templates);
  const vouched = [entriesOf(listed.root), entriesOf(listed.dotGithub)].some((entries) =>
    entries?.some((e) => e.type === 'blob' && VOUCH_FILE.test(e.name)),
  );
  return { paths, vouched };
}

/**
 * Reads each repo's facts and the folders its files are looked for in, in
 * one GraphQL query. A repo GitHub doesn't show, as when it went private or
 * is gone, comes back null.
 */
// https://docs.github.com/en/graphql/reference/repos#object-repository
export async function readRepos(github: ServiceGitHub, repos: readonly string[]): Promise<(FoundRepo | null)[]> {
  if (repos.length === 0) return [];
  const variables: Record<string, string> = {};
  const declared: string[] = [];
  const fields = repos.map((repo, i) => {
    const n = String(i);
    [variables[`o${n}`], variables[`n${n}`]] = split(repo);
    declared.push(`$o${n}: String!`, `$n${n}: String!`);
    return `r${n}: repository(owner: $o${n}, name: $n${n}) { ...Crawled }`;
  });
  const query = `query (${declared.join(', ')}) {
    ${fields.join('\n')}
  }
  fragment Crawled on Repository { ${REPO_FIELDS} }
  fragment SkillFolders on Tree { entries { name type size object { ... on Tree { entries { name type size } } } } }`;
  const { data, errors } = await github.query<Record<string, ListedRepo | null>>(query, variables);
  // GitHub shows no repo that went private or is gone. Any other error could
  // hide a file that bans AI, so the batch is read again later.
  const failed = errors.find((error) => error.type !== 'NOT_FOUND');
  if (data === null || failed !== undefined) {
    throw new Error(`GitHub didn't read every repo: ${failed?.message ?? errors[0]?.message ?? 'no data'}`);
  }
  return repos.map((asked, i) => {
    const listed = data[`r${String(i)}`];
    if (!listed || !repoName.safeParse(listed.nameWithOwner).success) return null;
    return {
      asked,
      name: listed.nameWithOwner,
      archived: listed.isArchived,
      private: listed.isPrivate,
      standing: standingOf(listed),
      branch: listed.defaultBranchRef?.name ?? null,
      ...pathsOf(listed),
    };
  });
}

/**
 * Reads the files each repo lists from its default branch, 50 files to a
 * GraphQL query. A file GitHub gives no text for, as for a binary file, is
 * left out. The paths go in as variables, so a file's name is never read as
 * part of the query.
 */
export async function readFiles(github: ServiceGitHub, repos: readonly FoundRepo[]): Promise<Map<FoundRepo, PolicyFile[]>> {
  const wanted = repos.flatMap((repo) => repo.paths.map((file, order) => ({ repo, order, ...file })));
  const texts = new Map<(typeof wanted)[number], string>();
  for (let start = 0; start < wanted.length; start += FILES_PER_QUERY) {
    const chunk = wanted.slice(start, start + FILES_PER_QUERY);
    const owners = [...new Set(chunk.map((file) => file.repo))];
    const variables: Record<string, string> = {};
    const declared: string[] = [];
    const fields = owners.map((repo, r) => {
      const n = String(r);
      [variables[`o${n}`], variables[`n${n}`]] = split(repo.name);
      declared.push(`$o${n}: String!`, `$n${n}: String!`);
      const objects = chunk.flatMap((file, f) => {
        if (file.repo !== repo) return [];
        variables[`e${String(f)}`] = `HEAD:${file.path}`;
        declared.push(`$e${String(f)}: String!`);
        return [`f${String(f)}: object(expression: $e${String(f)}) { ... on Blob { text } }`];
      });
      return `r${n}: repository(owner: $o${n}, name: $n${n}) { ${objects.join('\n')} }`;
    });
    const { data, errors } = await github.query<Record<string, Record<string, { text?: string | null } | null> | null>>(
      `query (${declared.join(', ')}) { ${fields.join('\n')} }`,
      variables,
    );
    // A file that failed to read could be the one that bans AI, so the batch
    // is read again later. A repo gone since it was listed has no files.
    const failed = errors.find((error) => error.type !== 'NOT_FOUND');
    if (data === null || failed !== undefined) {
      throw new Error(`GitHub didn't read every file: ${failed?.message ?? errors[0]?.message ?? 'no data'}`);
    }
    chunk.forEach((file, f) => {
      const text = data[`r${String(owners.indexOf(file.repo))}`]?.[`f${String(f)}`]?.text;
      if (typeof text === 'string') texts.set(file, text);
    });
  }
  const read = new Map<FoundRepo, PolicyFile[]>(repos.map((repo) => [repo, []]));
  for (const file of wanted) {
    const text = texts.get(file);
    if (text !== undefined) read.get(file.repo)?.push({ path: file.path, kind: file.kind, text });
  }
  return read;
}

interface LabelConnection {
  nodes: ({ name: string; issues: { totalCount: number } } | null)[] | null;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface LabelPage {
  repository: { labels: LabelConnection | null } | null;
}

/**
 * The repo's labels, the first 1,000, each with how many open issues carry
 * it, 100 to a GraphQL query. Null when GitHub doesn't show the repo.
 */
// https://docs.github.com/en/graphql/reference/labels#object-label
export async function readLabels(github: ServiceGitHub, repo: string): Promise<RepoLabel[] | null> {
  const [owner, name] = split(repo);
  const labels: RepoLabel[] = [];
  const readPage = async (after: string | null): Promise<LabelPage | null> =>
    (
      await github.query<LabelPage>(
        `query ($owner: String!, $name: String!, $after: String) {
          repository(owner: $owner, name: $name) {
            labels(first: ${String(PAGE)}, after: $after) {
              nodes { name issues(states: [OPEN]) { totalCount } }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`,
        { owner, name, after },
      )
    ).data;
  let after: string | null = null;
  for (let page = 0; page < MAX_LABEL_PAGES; page++) {
    const found: LabelConnection | null | undefined = (await readPage(after))?.repository?.labels;
    if (!found) return null;
    for (const label of found.nodes ?? []) {
      const open = label?.issues.totalCount;
      if (label && typeof label.name === 'string' && Number.isInteger(open)) labels.push({ name: label.name, openIssues: open ?? 0 });
    }
    if (!found.pageInfo.hasNextPage || found.pageInfo.endCursor === null) break;
    after = found.pageInfo.endCursor;
  }
  return labels;
}

/**
 * Why a repo can't be listed, from its REST answer, or null when it can: it
 * has to be public, not archived, and take pull requests from anyone, the
 * rule an admin's listing checks. GitHub's GraphQL doesn't give who can open
 * pull requests, so this is a REST call.
 */
// https://docs.github.com/en/rest/repos/repos#get-a-repository
export async function whyNotListable(github: ServiceGitHub, repo: string): Promise<string | null> {
  let found: Partial<ManagedRepo>;
  try {
    found = (await github.read<Partial<ManagedRepo>>(`/repos/${repo}`)).data;
  } catch (error) {
    if (error instanceof GitHubError) return `GitHub answered ${String(error.status)} when asked about ${repo}.`;
    throw error;
  }
  if (typeof found.full_name !== 'string' || typeof found.private !== 'boolean' || typeof found.archived !== 'boolean') {
    return `GitHub described ${repo} in a form it doesn't use.`;
  }
  return whyNotEligible(repoFacts(found as ManagedRepo), 'list');
}
