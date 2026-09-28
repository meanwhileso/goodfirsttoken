import {
  labelName,
  prRefSchema,
  type LinkMethod,
  type PrRef,
  type ProjectRecord,
  type TaggedIssue,
} from '@goodfirsttoken/core';
import {
  beginPass,
  dropIssues,
  finishPass,
  getProject,
  holdProject,
  isOpenClaimPr,
  listIssueCopies,
  listIssues,
  listProjectsToSync,
  releaseProject,
  saveIssues,
  setProjectLanguage,
  setProjectStatusFrom,
} from '../db';
import { GitHubError } from '../github';
import { issueRoom, type IssueRoom } from '../rooms/issue-room';
import { SyncStopped, type GitHubReader, type ServiceGitHub, type StopReason } from './github';

// The tagged-issue sync (spec sections 3 and 6). For each approved project
// it reads, with the read-only service token, the open issues in its issue
// repo that carry one of its tags, leaving out any with an excluded tag or
// an assignee, and the open PRs linked to each. It saves them to the
// tagged-issue cache, tells each issue's room about the linked PR it keeps,
// and drops the issues it no longer finds. A repo that went private, was
// archived, or is gone pauses its project. The rules are in
// docs/how-it-works.md, under Tagged issues.
//
// A pass reads each of a project's issues once, and can take several runs.
// A run that stops early, for the GitHub budget or its limit on calls,
// leaves the pass in progress, and the next run skips the issues it read.
// One run at a time holds a project while it reads it, a scheduled run or a
// maintainer's refresh.

/** How long a run holds a project: the most a scheduled run lasts. */
export const HOLD_MS = 15 * 60_000;

export interface SyncDeps {
  db: D1Database;
  rooms: DurableObjectNamespace<IssueRoom>;
  github: ServiceGitHub;
  now: () => number;
}

/** What syncing one project did. */
export type ProjectSync =
  /** Every tagged issue is read, and the pass finished. */
  | { outcome: 'read'; issues: number }
  /** GitHub showed the repo is no longer public and open, so the project is paused. */
  | { outcome: 'paused'; reason: string }
  /** GitHub refused a read for this project alone. The pass stays in progress. */
  | { outcome: 'skipped'; problem: string };

/** What one run did, for its log line. */
export interface SyncRun {
  projects: number;
  finished: number;
  paused: string[];
  skipped: string[];
  /** Projects another run held, which this one left. */
  held: string[];
  /** Issues saved. */
  issues: number;
  /**
   * The open PRs linked to the issues read, each counted once for each issue,
   * by the ways the sync found it: a closing reference only, a
   * cross-reference only, or both. `elsewhere` counts the PRs either way
   * found in a repo other than the project's, which link nothing.
   */
  linked: { closing: number; cross: number; both: number; elsewhere: number };
  calls: number;
  stopped: StopReason | null;
}

export function newSyncRun(): SyncRun {
  return {
    projects: 0,
    finished: 0,
    paused: [],
    skipped: [],
    held: [],
    issues: 0,
    linked: { closing: 0, cross: 0, both: 0, elsewhere: 0 },
    calls: 0,
    stopped: null,
  };
}

/** Issues whose closing PRs one GraphQL query reads. */
const CLOSING_BATCH = 25;
/** The open PRs a query asks for on each issue. One is enough to keep, and a few let the kept one stay put. */
const CLOSING_FIRST = 10;
/** GitHub's largest page. */
const PER_PAGE = 100;

// The parts of GitHub's REST answers the sync reads.
// https://docs.github.com/en/rest/repos/repos#get-a-repository
interface RestRepo {
  full_name?: unknown;
  private?: unknown;
  visibility?: unknown;
  archived?: unknown;
  language?: unknown;
}

// https://docs.github.com/en/rest/issues/issues#list-repository-issues
interface RestIssue {
  number: number;
  title: string;
  labels: (string | { name?: string })[];
  assignees?: unknown[] | null;
  assignee?: unknown;
  pull_request?: unknown;
}

// https://docs.github.com/en/rest/using-the-rest-api/issue-event-types#cross-referenced
interface TimelineEvent {
  event?: string;
  source?: {
    issue?: {
      number?: number;
      state?: string;
      html_url?: string;
      repository_url?: string;
      repository?: { full_name?: string };
      pull_request?: unknown;
    };
  };
}

interface ClosingNode {
  number: number;
  url: string;
  state: string;
  repository: { nameWithOwner: string };
}

type ClosingIssues = Record<string, { closedByPullRequestsReferences: { nodes: (ClosingNode | null)[] | null } | null } | null>;

interface Listed {
  number: number;
  title: string;
  labels: string[];
}

/** An open PR linked to an issue, with the ways it was found. */
export interface Link {
  pr: PrRef;
  foundBy: LinkMethod[];
}

/** GitHub answered a read for one project with something the sync can't use. */
class ProjectProblem extends Error {}

const lower = (text: string) => text.toLowerCase();

function samePr(a: PrRef | null, b: PrRef | null): boolean {
  if (a === null || b === null) return a === b;
  return lower(a.repo) === lower(b.repo) && a.number === b.number;
}

function prKey(pr: PrRef): string {
  return `${lower(pr.repo)}#${String(pr.number)}`;
}

function issueKey(issue: string): string {
  return lower(issue);
}

function notGitHub(repo: string): SyncStopped {
  return new SyncStopped('github_error', `GitHub's API answered a read of ${repo} in a form GitHub doesn't use.`);
}

/**
 * What GitHub shows of a repo: the name GitHub gives it now, or why it no
 * longer shows it as one Good First Token lists. The service token reads
 * public repos only, so GitHub answers 404 alike for a repo that went
 * private and one that was deleted. A renamed or moved repo answers from
 * its new name, and stays listed.
 *
 * Only an answer in GitHub's own form pauses a project: its JSON 404, Not
 * Found, a 451 with its JSON body, or a repo that says it is private or
 * archived. Any other 404 or 451, or a repo in a form GitHub doesn't send,
 * stops the run, so a proxy or a wrong GH_API_URL never pauses a project.
 * The repo's main language comes back too, or null when GitHub names none.
 */
async function readRepo(
  github: ServiceGitHub,
  repo: string,
): Promise<{ name: string; language: string | null } | { unlisted: string }> {
  let found: RestRepo;
  try {
    found = (await github.read<RestRepo>(`/repos/${repo}`)).data;
  } catch (error) {
    if (!(error instanceof GitHubError) || (error.status !== 404 && error.status !== 451)) throw error;
    if (error.status === 404 && error.bodyMessage === 'Not Found') {
      return { unlisted: `GitHub shows no public repo named ${repo}. It went private or was deleted.` };
    }
    if (error.status === 451 && error.bodyMessage !== null) return { unlisted: `GitHub blocked access to ${repo}.` };
    throw notGitHub(repo);
  }
  if (typeof found.full_name !== 'string' || typeof found.private !== 'boolean' || typeof found.archived !== 'boolean') {
    throw notGitHub(repo);
  }
  if (found.private || (typeof found.visibility === 'string' && found.visibility !== 'public')) {
    return { unlisted: `${repo} is no longer public on GitHub.` };
  }
  if (found.archived) return { unlisted: `${repo} is archived on GitHub.` };
  const language = typeof found.language === 'string' && found.language.length <= 100 ? found.language : null;
  return { name: found.full_name, language };
}

/**
 * Pauses the project for Good First Token, with no person named, so only an
 * admin can resume it. It lands only on the approved status it was decided
 * on, so a change someone made meanwhile stays.
 */
async function pauseForGitHub(db: D1Database, project: ProjectRecord, reason: string, now: number): Promise<void> {
  let current: ProjectRecord | null = project;
  for (let attempt = 0; attempt < 3 && current?.status === 'approved'; attempt++) {
    const paused = await setProjectStatusFrom(db, current, { status: 'paused', reason, changedBy: null }, now);
    if (paused !== null) {
      console.warn(`The tagged-issue sync paused ${project.repo}: ${reason}`);
      return;
    }
    current = await getProject(db, project.repo);
  }
}

function labelsOf(issue: RestIssue): string[] {
  return issue.labels.flatMap((label) => {
    const name = typeof label === 'string' ? label : label.name;
    const checked = labelName.safeParse(name);
    return checked.success ? [checked.data] : [];
  });
}

/**
 * The open issues in the repo that carry one of the tags and none of the
 * excluded tags, and have no assignee, by number. GitHub lists issues with
 * every label given, so each tag is its own list, and the lists meet here.
 */
async function listTagged(
  github: ServiceGitHub,
  issueRepo: string,
  tags: readonly string[],
  excluded: readonly string[],
): Promise<Map<number, Listed>> {
  const skip = new Set(excluded.map(lower));
  const found = new Map<number, Listed>();
  for (const tag of tags) {
    for (let page = 1; ; page++) {
      const query = `state=open&labels=${encodeURIComponent(tag)}&assignee=none&per_page=${String(PER_PAGE)}&page=${String(page)}`;
      const { data, hasNext } = await github.read<RestIssue[]>(`/repos/${issueRepo}/issues?${query}`);
      for (const issue of data) {
        // The list holds pull requests too.
        if (issue.pull_request !== undefined) continue;
        if ((issue.assignees?.length ?? 0) > 0 || (issue.assignee ?? null) !== null) continue;
        const labels = labelsOf(issue);
        if (labels.some((label) => skip.has(lower(label)))) continue;
        found.set(issue.number, { number: issue.number, title: issue.title, labels });
      }
      if (!hasNext || data.length === 0) break;
    }
  }
  return found;
}

/**
 * The open PRs linked to each issue by a closing reference, from GraphQL's
 * closedByPullRequestsReferences, which holds PRs whose description closes
 * the issue with a keyword and PRs someone linked by hand. An issue GitHub
 * no longer has, as when it was moved or deleted, is left out.
 */
export async function closingReferences(
  github: GitHubReader,
  issueRepo: string,
  numbers: readonly number[],
): Promise<Map<number, PrRef[]>> {
  const [owner = '', name = ''] = issueRepo.split('/');
  const variables: Record<string, unknown> = { owner, name };
  const fields = numbers.map((number, i) => {
    variables[`n${String(i)}`] = number;
    return `i${String(i)}: issue(number: $n${String(i)}) {
      closedByPullRequestsReferences(first: ${String(CLOSING_FIRST)}, includeClosedPrs: false) {
        nodes { number url state repository { nameWithOwner } }
      }
    }`;
  });
  const declared = numbers.map((_, i) => `$n${String(i)}: Int!`).join(', ');
  const query = `query ($owner: String!, $name: String!, ${declared}) {
    repository(owner: $owner, name: $name) { ${fields.join('\n')} }
  }`;
  const { data, errors } = await github.query<{ repository: ClosingIssues | null }>(query, variables);
  const other = errors.find((error) => error.type !== 'NOT_FOUND');
  if (other !== undefined || data?.repository == null) {
    throw new ProjectProblem(`GitHub listed no PRs that close issues in ${issueRepo}: ${other?.message ?? 'no repository'}`);
  }
  const found = new Map<number, PrRef[]>();
  numbers.forEach((number, i) => {
    const issue = data.repository?.[`i${String(i)}`];
    if (issue == null) return;
    const prs = (issue.closedByPullRequestsReferences?.nodes ?? []).flatMap((node) => {
      if (node?.state !== 'OPEN') return [];
      const pr = prRefSchema.safeParse({ repo: node.repository.nameWithOwner, number: node.number, url: node.url });
      return pr.success ? [pr.data] : [];
    });
    found.set(number, prs);
  });
  return found;
}

/** The repo a REST issue belongs to, from its repository or its API link. */
function repoOfSource(source: NonNullable<NonNullable<TimelineEvent['source']>['issue']>): string | undefined {
  if (source.repository?.full_name) return source.repository.full_name;
  const match = /\/repos\/([^/]+\/[^/]+)$/.exec(source.repository_url ?? '');
  return match?.[1];
}

/**
 * The open PRs that mention the issue, from its timeline's cross-referenced
 * events, oldest first. Null when GitHub no longer has the issue.
 */
export async function crossReferences(github: GitHubReader, issueRepo: string, number: number): Promise<PrRef[] | null> {
  const found: PrRef[] = [];
  for (let page = 1; ; page++) {
    let events: TimelineEvent[];
    let hasNext: boolean;
    try {
      const path = `/repos/${issueRepo}/issues/${String(number)}/timeline?per_page=${String(PER_PAGE)}&page=${String(page)}`;
      ({ data: events, hasNext } = await github.read<TimelineEvent[]>(path));
    } catch (error) {
      if (error instanceof GitHubError && (error.status === 404 || error.status === 410)) return null;
      throw error;
    }
    for (const event of events) {
      const source = event.source?.issue;
      // A mention from an issue is no PR. Only an open PR is linked.
      if (event.event !== 'cross-referenced' || source?.pull_request === undefined || source.state !== 'open') continue;
      const pr = prRefSchema.safeParse({ repo: repoOfSource(source), number: source.number, url: source.html_url });
      if (pr.success && !found.some((known) => samePr(known, pr.data))) found.push(pr.data);
    }
    if (!hasNext || events.length === 0) return found;
  }
}

/** Every open PR linked to an issue, each once, with the ways it was found. */
export function linksOf(closing: readonly PrRef[], cross: readonly PrRef[]): Link[] {
  const links = new Map<string, Link>();
  const add = (pr: PrRef, method: LinkMethod) => {
    const link = links.get(prKey(pr)) ?? { pr, foundBy: [] };
    if (!link.foundBy.includes(method)) link.foundBy.push(method);
    links.set(prKey(pr), link);
  };
  for (const pr of closing) add(pr, 'closing_reference');
  for (const pr of cross) add(pr, 'cross_reference');
  return [...links.values()];
}

/**
 * The linked PR to keep for the issue, and how it was found, or null. The
 * one kept last time stays while it is still linked and open, so the room
 * hears of a change only when there is one. Otherwise a PR both ways
 * found comes first, then one a closing reference found, then the oldest
 * mention.
 */
export function chooseLink(kept: PrRef | null, links: readonly Link[]): Link | null {
  const still = kept === null ? undefined : links.find((link) => samePr(link.pr, kept));
  if (still) return still;
  return (
    links.find((link) => link.foundBy.length === 2) ??
    links.find((link) => link.foundBy.includes('closing_reference')) ??
    links[0] ??
    null
  );
}

function countLinks(run: SyncRun | undefined, links: readonly Link[], elsewhere: number): void {
  if (!run) return;
  run.linked.elsewhere += elsewhere;
  for (const link of links) {
    if (link.foundBy.length === 2) run.linked.both += 1;
    else if (link.foundBy.includes('closing_reference')) run.linked.closing += 1;
    else run.linked.cross += 1;
  }
}

/**
 * Tells the issue's room that the linked PR it keeps changed from `before`
 * to `after`, the new one first, so the room never goes without an open PR
 * the sync knows. A claim's PR that is still open is the PR job's to close
 * in the room. False when the room didn't take a change, so the cache keeps
 * `before` and the next pass tries again.
 */
async function tellRoom(deps: SyncDeps, issue: string, before: PrRef | null, after: PrRef | null): Promise<boolean> {
  if (samePr(before, after)) return true;
  try {
    const room = issueRoom(deps.rooms, issue);
    if (after !== null && !(await room.prOpened(after)).ok) return false;
    if (before !== null && !(await isOpenClaimPr(deps.db, before, issue)) && !(await room.prClosed(before)).ok) return false;
    return true;
  } catch (error) {
    console.warn(`The room for ${issue} didn't take the sync's linked PR. The next pass tries again.`, error);
    return false;
  }
}

/**
 * Drops the project's copies of issues the pass no longer found. A copy
 * with a linked PR tells the issue's room the PR is gone from the sync,
 * unless another project's copy keeps the same PR. A copy whose room didn't
 * hear it stays, for the next pass to try again.
 */
async function dropMissing(deps: SyncDeps, project: string, missing: readonly TaggedIssue[]): Promise<number> {
  const drop: string[] = [];
  for (const copy of missing) {
    const pr = copy.linkedPr;
    const keptElsewhere =
      pr !== null &&
      (await listIssueCopies(deps.db, copy.issue)).some(
        (other) => lower(other.project) !== lower(project) && samePr(other.linkedPr, pr),
      );
    if (pr === null || keptElsewhere || (await tellRoom(deps, copy.issue, pr, null))) drop.push(copy.issue);
  }
  return dropIssues(deps.db, project, drop);
}

/**
 * Reads the project's tagged issues from GitHub, as one pass or the rest of
 * one. Throws SyncStopped when the run has to stop, after saving what it
 * read.
 */
export async function syncProject(deps: SyncDeps, project: ProjectRecord, run?: SyncRun): Promise<ProjectSync> {
  const { db, github, now } = deps;
  const issueRepo = project.settings.issueRepo ?? project.repo;
  // A PR links an issue only when it is aimed at the project: opened in its
  // code repo or its issue repo, from a branch there or a fork. Each is
  // known by the name the project keeps and the name GitHub gives it now,
  // which differ after a rename, and GitHub gives each PR under the new one.
  const projectRepos = new Set([lower(project.repo), lower(issueRepo)]);
  const ours = (pr: PrRef) => projectRepos.has(lower(pr.repo));
  try {
    for (const repo of lower(issueRepo) === lower(project.repo) ? [project.repo] : [project.repo, issueRepo]) {
      const found = await readRepo(github, repo);
      if ('unlisted' in found) {
        await pauseForGitHub(db, project, found.unlisted, now());
        return { outcome: 'paused', reason: found.unlisted };
      }
      projectRepos.add(lower(found.name));
      // The code repo's language ranks the project's issues for donors who
      // name languages among their interests.
      if (repo === project.repo) await setProjectLanguage(db, project.repo, found.language);
    }

    const passStart = await beginPass(db, project.repo, now());
    const listed = await listTagged(github, issueRepo, project.settings.tags, project.settings.excludedTags);
    const cached = new Map((await listIssues(db, project.repo)).map((copy) => [issueKey(copy.issue), copy]));
    const keyOf = (number: number) => issueKey(`${issueRepo}#${String(number)}`);
    // Issues this pass read in an earlier run are done.
    const todo = [...listed.values()].filter((issue) => (cached.get(keyOf(issue.number))?.syncedAt ?? -1) < passStart);

    let read = listed.size - todo.length;
    for (let start = 0; start < todo.length; start += CLOSING_BATCH) {
      const batch = todo.slice(start, start + CLOSING_BATCH);
      const closing = await closingReferences(
        github,
        issueRepo,
        batch.map((issue) => issue.number),
      );
      const saves: TaggedIssue[] = [];
      try {
        for (const issue of batch) {
          const closes = closing.get(issue.number);
          if (closes === undefined) continue;
          const mentions = await crossReferences(github, issueRepo, issue.number);
          if (mentions === null) continue;
          const ref = `${issueRepo}#${String(issue.number)}`;
          const before = cached.get(keyOf(issue.number));
          const kept = before?.linkedPr ?? null;
          const all = linksOf(closes, mentions);
          const links = all.filter((link) => ours(link.pr));
          countLinks(run, links, all.length - links.length);
          const found = chooseLink(kept, links);
          // When the room didn't take the change, the copy keeps what the
          // room holds, and the next pass tries again.
          const told = await tellRoom(deps, ref, kept, found?.pr ?? null);
          const linkedPr = told ? (found?.pr ?? null) : kept;
          const foundBy = told ? found?.foundBy : before?.linkedPrFoundBy;
          saves.push({
            issue: ref,
            project: project.repo,
            title: issue.title,
            labels: issue.labels,
            linkedPr,
            ...(linkedPr === null || foundBy === undefined ? {} : { linkedPrFoundBy: foundBy }),
            syncedAt: now(),
          });
        }
      } finally {
        await saveIssues(db, saves);
        read += saves.length;
        if (run) run.issues += saves.length;
      }
    }

    // Copies the pass didn't find, in the issue repo or one the project
    // kept its issues in before, are no longer tagged and open.
    const stillTagged = new Set([...listed.keys()].map(keyOf));
    await dropMissing(
      deps,
      project.repo,
      [...cached.values()].filter((copy) => !stillTagged.has(issueKey(copy.issue))),
    );
    await finishPass(db, project.repo, passStart, now());
    return { outcome: 'read', issues: read };
  } catch (error) {
    // Any other refusal is about this project alone, like a label GitHub
    // can't list by. The run goes on to the next project.
    if (error instanceof GitHubError) return { outcome: 'skipped', problem: `GitHub answered ${String(error.status)}: ${error.message}` };
    if (error instanceof ProjectProblem) return { outcome: 'skipped', problem: error.message };
    throw error;
  }
}

/**
 * The scheduled run: syncs the approved projects in the order
 * listProjectsToSync gives, until they are done or the run has to stop. It
 * first asks GitHub what is left of the budget, and leaves a project a
 * maintainer's refresh is reading.
 */
export async function syncTaggedIssues(deps: SyncDeps): Promise<SyncRun> {
  const run = newSyncRun();
  const repos = await listProjectsToSync(deps.db);
  try {
    if (repos.length > 0) await deps.github.checkGitHub();
    for (const repo of repos) {
      const project = await getProject(deps.db, repo);
      if (project?.status !== 'approved') continue;
      const until = deps.now() + HOLD_MS;
      if (!(await holdProject(deps.db, project.repo, deps.now(), until))) {
        run.held.push(project.repo);
        continue;
      }
      run.projects += 1;
      try {
        const result = await syncProject(deps, project, run);
        if (result.outcome === 'read') run.finished += 1;
        if (result.outcome === 'paused') run.paused.push(project.repo);
        if (result.outcome === 'skipped') {
          run.skipped.push(project.repo);
          console.warn(`The tagged-issue sync skipped ${project.repo}. ${result.problem}`);
        }
      } finally {
        await releaseProject(deps.db, project.repo, until);
      }
    }
  } catch (error) {
    if (!(error instanceof SyncStopped)) throw error;
    run.stopped = error.reason;
    console.warn(`The tagged-issue sync stopped. ${error.message}`);
  }
  run.calls = deps.github.calls;
  // One line a run. The linked PRs it counts say how often each way finds
  // a PR the other misses.
  console.log(
    `The tagged-issue sync read issues: ${String(run.issues)}, projects started: ${String(run.projects)}, finished: ${String(run.finished)}, calls to GitHub: ${String(run.calls)}. Linked PRs found by a closing reference only: ${String(run.linked.closing)}, by a cross-reference only: ${String(run.linked.cross)}, both ways: ${String(run.linked.both)}, in another repo: ${String(run.linked.elsewhere)}. Left: ${JSON.stringify(deps.github.left())}.${run.held.length === 0 ? '' : ` Not read, held by another run: ${run.held.join(', ')}.`}${run.stopped === null ? '' : ` Stopped: ${run.stopped}.`}`,
  );
  return run;
}
