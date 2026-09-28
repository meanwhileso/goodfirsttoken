import { repoName } from '@goodfirsttoken/core';
import type { ManagedRepo } from '../auth/permissions';
import { GitHubError, type GraphQLError, type GraphQLResult } from '../github';
import { DOC_FILES, MAX_DOC_BYTES, type DocKind, type TreeEntry } from '../projects/docs';
import { repoFacts, whyNotEligible, type Standing } from '../projects/repo';
import type { ServiceGitHub } from '../sync/github';
import type { PolicyFile, PolicyFileKind, RepoLabel } from './rules';

// What the policy crawler reads from GitHub, with the read-only service
// token, through the job's ServiceGitHub, which stops the run when the budget
// runs low. Each batch of repos takes one GraphQL query for their facts and
// folders, and one for every 50 of their files. Only a repo whose docs
// welcome AI help costs more: one REST call for its pull request settings,
// and a GraphQL query for each 100 of its labels.
//
// The crawler gives a repo a verdict only when it read every file that could
// hold its policy, all from one commit. A file it can't read, like one over
// the size limit, a symbolic link, or one GitHub gives no text for, could be
// the one that bans AI, so the repo gets no verdict.

/** GitHub's largest page. */
const PAGE = 100;
/** The most labels read for a repo, as a proposal reads. */
const MAX_LABEL_PAGES = 10;
/** The most files one GraphQL query reads. */
const FILES_PER_QUERY = 50;
/**
 * The most issue templates, pull request templates in a folder of them, and
 * agent skills in each skills folder, a repo can have for the crawler to read
 * it whole.
 */
export const MAX_EXTRA_FILES = 10;
/** The mode Git gives a symbolic link. */
const SYMLINK = 0o120000;

// The files the crawler reads beyond the ones a proposal reads.
const CLAUDE_MD = /^claude\.md$/i;
const VOUCH_FILE = /^vouched\.td$/i;
const ISSUE_TEMPLATE = /\.(?:md|markdown|ya?ml)$/i;
const PR_TEMPLATE = /\.(?:md|markdown|txt)$/i;
const TEMPLATE_FOLDER = /^(?:pull_request_template|issue_template)$/i;
const PR_TEMPLATE_FOLDER = /^pull_request_template$/i;
const SKILL_MD = /^skill\.md$/i;

/**
 * The folders the crawler lists, each with the name its listing goes by in a
 * GraphQL query. `.github` is listed with its folders' entries too, for its
 * issue and pull request templates, and each skills folder with its skills'.
 */
const FOLDERS: readonly { path: string; alias: string; nested?: true }[] = [
  { path: '', alias: 'root' },
  { path: '.github', alias: 'dotGithub', nested: true },
  { path: 'docs', alias: 'docs' },
  { path: 'PULL_REQUEST_TEMPLATE', alias: 'rootPrTemplates' },
  { path: 'docs/PULL_REQUEST_TEMPLATE', alias: 'docsPrTemplates' },
  { path: '.claude/skills', alias: 'claudeSkills', nested: true },
  { path: 'skills', alias: 'skills', nested: true },
];

/** The kind of each file a proposal reads, in the order the crawler reads them. */
const DOC_ORDER: [DocKind, PolicyFileKind][] = [
  ['aiPolicy', 'aiPolicy'],
  ['contributing', 'contributing'],
  ['agents', 'agents'],
];

interface Entry extends TreeEntry {
  mode: number;
  object?: Listing | null;
}

interface Listing {
  __typename?: string;
  oid?: string;
  entries?: Entry[] | null;
}

// https://docs.github.com/en/graphql/reference/repos#object-repository
interface ListedRepo {
  nameWithOwner: string;
  isArchived: boolean;
  isPrivate: boolean;
  stargazerCount: number;
  createdAt: string;
  pushedAt: string | null;
  defaultBranchRef: { name: string; target: { oid?: string } | null } | null;
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
  /** The commit on the default branch the files are read from, or null for a repo with no commits. */
  commit: string | null;
  /** The files to read, in the order the rules read them. */
  paths: { path: string; kind: PolicyFileKind }[];
  /** Why the crawler can't read every file that could hold the repo's policy, or null when it can. */
  unreadable: string | null;
  /** The path of its vouch file, or null. */
  vouch: string | null;
  /** Each folder the crawler listed, with the object GitHub gave for it, to check the listing is of the commit. */
  folders: { path: string; oid: string | null }[];
}

/** What GitHub gave for one repo the crawler asked about. */
export type ListedResult = { found: FoundRepo } | { gone: true } | { failed: string };

/** What GitHub gave for one repo's files. */
export type FilesResult = { files: PolicyFile[] } | { unreadable: string } | { failed: string };

const ENTRY_FIELDS = 'name type mode size';

function folderFields({ path, alias, nested }: (typeof FOLDERS)[number]): string {
  const entries = nested ? `entries { ${ENTRY_FIELDS} object { ... on Tree { entries { ${ENTRY_FIELDS} } } } }` : `entries { ${ENTRY_FIELDS} }`;
  return `${alias}: object(expression: "HEAD:${path}") { __typename oid ... on Tree { ${entries} } }`;
}

const REPO_FIELDS = `
  nameWithOwner isArchived isPrivate stargazerCount createdAt pushedAt
  defaultBranchRef { name target { oid } }
  owner { ... on User { createdAt } ... on Organization { createdAt } }
  ${FOLDERS.map(folderFields).join('\n')}
`;

function split(repo: string): [string, string] {
  const [owner = '', name = ''] = repo.split('/');
  return [owner, name];
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

/** Why an entry the crawler would read can't be read, or null. */
function whyUnreadable(entry: Entry, path: string): string | null {
  if (entry.mode === SYMLINK) return `${path} is a symbolic link`;
  if (!Number.isInteger(entry.size) || entry.size > MAX_DOC_BYTES) return `${path} is over the size limit`;
  return null;
}

/**
 * The files the rules read in a repo, in the order they read them, from its
 * folder listings, and why it can't be read whole, if it can't.
 */
function pathsOf(listed: ListedRepo): Pick<FoundRepo, 'paths' | 'unreadable' | 'vouch' | 'folders'> {
  const listings = new Map(FOLDERS.map(({ alias }) => [alias, listed[alias] as Listing | null | undefined]));
  const folders = FOLDERS.map(({ path, alias }) => ({ path, oid: listings.get(alias)?.oid ?? null }));
  const problems: string[] = [];
  // A folder the crawler lists that GitHub gives as a file is a symbolic
  // link, or a file with the folder's name. Either way its files can't be
  // listed, except for a pull request template file with no extension.
  const entriesOf = (alias: string): Entry[] => {
    const listing = listings.get(alias);
    const folder = FOLDERS.find((f) => f.alias === alias)?.path ?? alias;
    const templates = alias === 'rootPrTemplates' || alias === 'docsPrTemplates';
    if (listing && listing.__typename !== 'Tree' && !templates) problems.push(`${folder || 'the root'} is a symbolic link or a file`);
    return listing?.__typename === 'Tree' && Array.isArray(listing.entries) ? listing.entries : [];
  };
  const inFolder = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
  const paths: FoundRepo['paths'] = [];
  const take = (folder: string, entry: Entry, kind: PolicyFileKind) => {
    const path = inFolder(folder, entry.name);
    const why = whyUnreadable(entry, path);
    if (why !== null) problems.push(why);
    else paths.push({ path, kind });
  };
  const files = (entries: readonly Entry[], name: RegExp) =>
    entries.filter((e) => (e.type === 'blob' || e.mode === SYMLINK) && name.test(e.name));
  const aliasOf = (folder: string) => FOLDERS.find((f) => f.path === folder)?.alias ?? '';
  const root = entriesOf('root');
  const dotGithub = entriesOf('dotGithub');

  // Every file with a name a proposal reads, in every folder it is looked for in.
  for (const [doc, kind] of DOC_ORDER) {
    for (const folder of DOC_FILES[doc].folders) for (const entry of files(entriesOf(aliasOf(folder)), DOC_FILES[doc].name)) take(folder, entry, kind);
  }
  for (const entry of files(root, CLAUDE_MD)) take('', entry, 'claude');

  // Pull request templates: one file, in the root, .github/, or docs/, or a folder of them in any of the three.
  for (const folder of DOC_FILES.prTemplate.folders) {
    for (const entry of files(entriesOf(aliasOf(folder)), DOC_FILES.prTemplate.name)) take(folder, entry, 'prTemplate');
  }
  const templateFolders: { folder: string; entries: readonly Entry[] }[] = [];
  for (const [folder, alias] of [
    ['', 'rootPrTemplates'],
    ['docs', 'docsPrTemplates'],
  ] as const) {
    const parent = folder === '' ? root : entriesOf('docs');
    for (const entry of parent) {
      if (!PR_TEMPLATE_FOLDER.test(entry.name) || (entry.type === 'blob' && entry.mode !== SYMLINK)) continue;
      // The crawler lists the folder by that name alone, and GitHub may read it by another case.
      if (entry.name !== 'PULL_REQUEST_TEMPLATE' || entry.mode === SYMLINK) problems.push(`${inFolder(folder, entry.name)} can't be listed`);
    }
    templateFolders.push({ folder: inFolder(folder, 'PULL_REQUEST_TEMPLATE'), entries: entriesOf(alias) });
  }
  // In .github/, every template folder whatever the case of its name, from its nested listing.
  const githubFolders: Entry[] = [];
  for (const entry of dotGithub) {
    if (!TEMPLATE_FOLDER.test(entry.name) || (entry.type === 'blob' && entry.mode !== SYMLINK)) continue;
    if (entry.type !== 'tree') problems.push(`.github/${entry.name} is a symbolic link`);
    else githubFolders.push(entry);
  }
  for (const folder of githubFolders.filter((f) => PR_TEMPLATE_FOLDER.test(f.name))) {
    templateFolders.push({ folder: `.github/${folder.name}`, entries: folder.object?.entries ?? [] });
  }
  for (const { folder, entries } of templateFolders) {
    const templates = files(entries, PR_TEMPLATE);
    if (templates.length > MAX_EXTRA_FILES) problems.push(`${folder} has more than ${String(MAX_EXTRA_FILES)} templates`);
    for (const entry of templates) take(folder, entry, 'prTemplate');
  }

  // Agent skills, one SKILL.md in each skill's folder.
  for (const { path, alias } of FOLDERS.filter((f) => f.alias === 'claudeSkills' || f.alias === 'skills')) {
    const skills = entriesOf(alias).filter((e) => e.type === 'tree' || e.mode === SYMLINK);
    if (skills.length > MAX_EXTRA_FILES) problems.push(`${path} has more than ${String(MAX_EXTRA_FILES)} skills`);
    for (const skill of skills) {
      if (skill.mode === SYMLINK) {
        problems.push(`${path}/${skill.name} is a symbolic link`);
        continue;
      }
      for (const entry of files(skill.object?.entries ?? [], SKILL_MD)) take(`${path}/${skill.name}`, entry, 'skill');
    }
  }

  // Issue templates.
  for (const folder of githubFolders.filter((f) => !PR_TEMPLATE_FOLDER.test(f.name))) {
    const templates = files(folder.object?.entries ?? [], ISSUE_TEMPLATE).filter((e) => !/^config\./i.test(e.name));
    if (templates.length > MAX_EXTRA_FILES) problems.push(`.github/${folder.name} has more than ${String(MAX_EXTRA_FILES)} templates`);
    for (const entry of templates) take(`.github/${folder.name}`, entry, 'issueTemplate');
  }

  const vouchIn = (folder: string, entries: readonly Entry[]) => {
    const found = entries.find((e) => e.type === 'blob' && VOUCH_FILE.test(e.name));
    return found ? inFolder(folder, found.name) : null;
  };
  return { paths, unreadable: problems[0] ?? null, vouch: vouchIn('', root) ?? vouchIn('.github', dotGithub), folders };
}

/**
 * The repo each GraphQL error belongs to, by the alias its path starts with,
 * like `r3`. Throws on an error that belongs to no repo, since it could hide
 * any of them.
 */
function errorsByRepo(errors: readonly GraphQLError[], aliases: readonly string[], what: string): Map<string, GraphQLError> {
  const found = new Map<string, GraphQLError>();
  for (const error of errors) {
    const alias = error.path?.[0];
    if (typeof alias !== 'string' || !aliases.includes(alias)) throw new Error(`GitHub didn't read ${what}: ${error.message}`);
    if (!found.has(alias)) found.set(alias, error);
  }
  return found;
}

/**
 * Reads each repo's facts and the folders its files are looked for in, in
 * one GraphQL query. A repo GitHub doesn't show, as when it went private or
 * is gone, comes back gone. A repo GitHub answers with any other error, as
 * when it blocks access to it, comes back failed, and the rest of the batch
 * is read. An error that belongs to no repo fails the batch.
 */
// https://docs.github.com/en/graphql/reference/repos#object-repository
export async function readRepos(github: ServiceGitHub, repos: readonly string[]): Promise<ListedResult[]> {
  if (repos.length === 0) return [];
  const variables: Record<string, string> = {};
  const declared: string[] = [];
  const aliases = repos.map((_, i) => `r${String(i)}`);
  const fields = repos.map((repo, i) => {
    const n = String(i);
    [variables[`o${n}`], variables[`n${n}`]] = split(repo);
    declared.push(`$o${n}: String!`, `$n${n}: String!`);
    return `r${n}: repository(owner: $o${n}, name: $n${n}) { ...Crawled }`;
  });
  const query = `query (${declared.join(', ')}) {
    ${fields.join('\n')}
  }
  fragment Crawled on Repository { ${REPO_FIELDS} }`;
  const { data, errors } = await github.query<Record<string, ListedRepo | null>>(query, variables);
  const failed = errorsByRepo(errors, aliases, 'the repos');
  if (data === null) throw new Error(`GitHub didn't read the repos: ${errors[0]?.message ?? 'no data'}`);
  return repos.map((asked, i): ListedResult => {
    const alias = `r${String(i)}`;
    const error = failed.get(alias);
    // GitHub shows no repo that went private or is gone.
    if (error?.type === 'NOT_FOUND' && error.path?.length === 1) return { gone: true };
    if (error !== undefined) return { failed: error.message };
    const listed = data[alias];
    if (!listed) return { gone: true };
    if (!repoName.safeParse(listed.nameWithOwner).success) return { failed: `GitHub named ${asked} in a form it doesn't use.` };
    return {
      found: {
        asked,
        name: listed.nameWithOwner,
        archived: listed.isArchived,
        private: listed.isPrivate,
        standing: standingOf(listed),
        branch: listed.defaultBranchRef?.name ?? null,
        commit: listed.defaultBranchRef?.target?.oid ?? null,
        ...pathsOf(listed),
      },
    };
  });
}

interface ReadBlob {
  text?: string | null;
  isBinary?: boolean | null;
  isTruncated?: boolean | null;
}

/**
 * Reads the files each repo lists, 50 files to a GraphQL query, each at the
 * commit its folders were listed at. With them it asks for each folder the
 * crawler listed at that commit, so a listing GitHub gave from another
 * commit, as when a push landed while it answered, is caught. A repo with a
 * file GitHub gives no text for, as for a binary file or one gone at that
 * commit, or a listing of another commit, comes back unreadable. The paths
 * go in as variables, so a file's name is never read as part of the query.
 */
export async function readFiles(github: ServiceGitHub, repos: readonly FoundRepo[]): Promise<Map<FoundRepo, FilesResult>> {
  type Wanted = { repo: FoundRepo; expression: string } & ({ path: string; kind: PolicyFileKind } | { folder: string; oid: string | null });
  const wanted: Wanted[] = repos.flatMap((repo) => {
    if (repo.commit === null || repo.paths.length === 0) return [];
    const commit = repo.commit;
    return [
      ...repo.paths.map((file) => ({ repo, expression: `${commit}:${file.path}`, ...file })),
      ...repo.folders.map(({ path, oid }) => ({ repo, expression: `${commit}:${path}`, folder: path, oid })),
    ];
  });
  const answers = new Map<Wanted, ReadBlob | null>();
  const moved = new Set<Wanted>();
  const failed = new Map<FoundRepo, string>();
  for (let start = 0; start < wanted.length; start += FILES_PER_QUERY) {
    const chunk = wanted.slice(start, start + FILES_PER_QUERY);
    const owners = [...new Set(chunk.map((file) => file.repo))];
    const variables: Record<string, string> = {};
    const declared: string[] = [];
    const fields = owners.map((repo, r) => {
      const n = String(r);
      [variables[`o${n}`], variables[`n${n}`]] = split(repo.name);
      declared.push(`$o${n}: String!`, `$n${n}: String!`);
      const objects = chunk.flatMap((item, f) => {
        if (item.repo !== repo) return [];
        const e = `e${String(f)}`;
        variables[e] = item.expression;
        declared.push(`$${e}: String!`);
        return [`f${String(f)}: object(expression: $${e}) { oid ... on Blob { text isBinary isTruncated } }`];
      });
      return `r${n}: repository(owner: $o${n}, name: $n${n}) { ${objects.join('\n')} }`;
    });
    const { data, errors } = await github.query<Record<string, Record<string, (ReadBlob & { oid?: string }) | null> | null>>(
      `query (${declared.join(', ')}) { ${fields.join('\n')} }`,
      variables,
    );
    const byRepo = errorsByRepo(
      errors,
      owners.map((_, r) => `r${String(r)}`),
      'the files',
    );
    if (data === null) throw new Error(`GitHub didn't read the files: ${errors[0]?.message ?? 'no data'}`);
    owners.forEach((repo, r) => {
      const error = byRepo.get(`r${String(r)}`);
      if (error !== undefined) failed.set(repo, error.message);
    });
    chunk.forEach((item, f) => {
      const read = data[`r${String(owners.indexOf(item.repo))}`]?.[`f${String(f)}`] ?? null;
      answers.set(item, read);
      if ('folder' in item && (read?.oid ?? null) !== item.oid) moved.add(item);
    });
  }
  const results = new Map<FoundRepo, FilesResult>();
  for (const repo of repos) {
    const why = failed.get(repo);
    if (why !== undefined) {
      results.set(repo, { failed: why });
      continue;
    }
    const files: PolicyFile[] = [];
    let unreadable: string | null = null;
    for (const item of wanted) {
      if (item.repo !== repo || unreadable !== null) continue;
      const read = answers.get(item) ?? null;
      if ('folder' in item) {
        if (moved.has(item)) unreadable = `GitHub listed ${item.folder || 'the root'} from another commit`;
        continue;
      }
      const text = read?.text;
      if (read === null) unreadable = `GitHub gave nothing for ${item.path} at the commit`;
      else if (read.isBinary === true || typeof text !== 'string') unreadable = `GitHub gave no text for ${item.path}`;
      else if (read.isTruncated === true) unreadable = `GitHub cut ${item.path} short`;
      else if (text.includes('\u0000')) unreadable = `${item.path} isn't text the rules can read`;
      else files.push({ path: item.path, kind: item.kind, text });
    }
    results.set(repo, unreadable === null ? { files } : { unreadable });
  }
  return results;
}

interface LabelConnection {
  nodes: ({ name: string; issues: { totalCount: number } } | null)[] | null;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface LabelPage {
  repository: { labels: LabelConnection | null } | null;
}

/** GitHub answered a question about one repo with an error, which may last. */
export class RepoFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoFailed';
  }
}

/**
 * The repo's labels, the first 1,000, each with how many open issues carry
 * it, 100 to a GraphQL query. Null when GitHub doesn't show the repo. Throws
 * RepoFailed when GitHub answers with any other error.
 */
// https://docs.github.com/en/graphql/reference/labels#object-label
export async function readLabels(github: ServiceGitHub, repo: string): Promise<RepoLabel[] | null> {
  const [owner, name] = split(repo);
  const labels: RepoLabel[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_LABEL_PAGES; page++) {
    const result: GraphQLResult<LabelPage> = await github.query<LabelPage>(
      `query ($owner: String!, $name: String!, $after: String) {
        repository(owner: $owner, name: $name) {
          labels(first: ${String(PAGE)}, after: $after) {
            nodes { name issues(states: [OPEN]) { totalCount } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { owner, name, after },
    );
    const { data, errors } = result;
    const error = errors[0];
    if (error?.type === 'NOT_FOUND' && errors.length === 1 && error.path?.join('.') === 'repository') return null;
    if (error !== undefined) throw new RepoFailed(`GitHub didn't read the labels of ${repo}: ${error.message}`);
    if (data === null) throw new RepoFailed(`GitHub didn't read the labels of ${repo}.`);
    if (data.repository === null) return null;
    const found: LabelConnection | null = data.repository.labels;
    if (!found) throw new RepoFailed(`GitHub gave no labels for ${repo}.`);
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
