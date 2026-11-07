import {
  MAX_LIVE_REQUESTS,
  MAX_REQUESTS_PER_DAY,
  productName,
  REQUEST_STATUS_WORDS,
  repoName,
  type ProjectRecord,
  type Refusal,
  type RequestStatus,
} from '@goodfirsttoken/core';
import type { Caller } from '../auth/permissions';
import {
  addRequest,
  getBlock,
  getLiveRequest,
  getLiveRequestByName,
  getPerson,
  getProject,
  listProjectsWithRepoId,
  storedRepoIds,
  withdrawRequest,
} from '../db';
import { gitHubUrls } from '../github';
import { hasPage } from '../project/shown';
import { readRepo, type ListedRepo } from '../projects/repo';
import { compareRepo, identityOf, type RepoIdentity } from '../projects/repo-id';

// A donor's request for a repo they want to work on, which the site and the
// request_repo tool both make (docs/specs/add-a-repo.md, under Requesting a
// repo). A request lists nothing, writes nothing to GitHub, and shows on no
// page. It reads the repo once, with the requester's own token, and keeps
// it by GitHub's ID. The status is worked out when it is read, by the rule
// the project page uses for which projects have a page, and stored nowhere.
// The rules are in docs/how-it-works.md, under Requesting a repo.

/** What a request answers, as request_repo's output. */
export interface RequestAnswer {
  /** The repo as GitHub names it now. */
  repo: string;
  status: RequestStatus;
  /** Whether the person has a live request for the repo, after the call. */
  requested: boolean;
  /** The project page, when the repo has one. */
  projectUrl?: string;
  message: string;
}

export interface RequestInput {
  repo: string;
  withdraw?: boolean | undefined;
}

/**
 * The repo a person named, as `owner/repo`, from `owner/repo`, a GitHub repo
 * link, or a Good First Token project link. `origins` are the sites whose
 * links name a repo by their first two path parts: GitHub's and the site's
 * own. A link may go on past the repo, like an issue's, and a GitHub link
 * may end in `.git`. Null for anything else.
 */
export function repoFromRequest(text: string, origins: readonly string[]): string | null {
  const typed = text.trim();
  const named = repoName.safeParse(typed);
  if (named.success) return named.data;
  let url: URL;
  try {
    url = new URL(typed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // A site's links name it by its host, with or without www., over http or https.
  const bare = (host: string) => host.toLowerCase().replace(/^www\./, '');
  const hosts = origins.flatMap((origin) => {
    try {
      return [bare(new URL(origin).host)];
    } catch {
      return [];
    }
  });
  if (!hosts.includes(bare(url.host))) return null;
  const [owner, repo] = url.pathname.split('/').filter((part) => part !== '');
  if (owner === undefined || repo === undefined) return null;
  const parsed = repoName.safeParse(`${owner}/${repo.replace(/\.git$/, '')}`);
  return parsed.success ? parsed.data : null;
}

const refusal = (code: Refusal['code'], message: string): Refusal => ({ code, message });

/**
 * Why agents can't work on the repo, or null when they can. It must be
 * public, not archived, and take pull requests from anyone. A repo GitHub
 * says nothing about on pull requests passes, since a request lists
 * nothing, and registering or listing it checks again.
 */
export function whyNotRequestable(found: ListedRepo): string | null {
  const name = found.full_name;
  if (found.private || (found.visibility !== undefined && found.visibility !== 'public')) {
    return `${name} isn't public, so agents can't work on it.`;
  }
  if (found.archived) return `${name} is archived on GitHub, so it takes no changes.`;
  if (found.has_pull_requests === false) return `${name} has pull requests turned off, so agents can't send PRs to it.`;
  const policy = found.pull_request_creation_policy;
  if (policy !== undefined && policy !== 'all') {
    return `${name} lets only collaborators open pull requests, so agents can't send PRs to it.`;
  }
  return null;
}

/**
 * The projects that have the repo as their code repo or issue repo: those
 * that keep its ID, and those stored before IDs were, under the name GitHub
 * gives now, when GitHub made the repo before they took the name.
 */
async function matchingProjects(db: D1Database, name: string, identity: RepoIdentity): Promise<ProjectRecord[]> {
  const byId = await listProjectsWithRepoId(db, identity.id);
  const unfilled = (await storedRepoIds(db, [name])).filter(
    (stored) => stored.id === null && compareRepo(stored, identity) === 'fill',
  );
  const byName = await Promise.all(unfilled.map((stored) => getProject(db, stored.project)));
  const seen = new Set<string>();
  return [...byId, ...byName].filter((project): project is ProjectRecord => {
    if (project === null || seen.has(project.repo.toLowerCase())) return false;
    seen.add(project.repo.toLowerCase());
    return true;
  });
}

/**
 * The repo's status, and the project whose page shows it: `listed` when a
 * matching project with a page is approved, `paused` when one is paused,
 * and `not_listed` when none has a page.
 */
async function statusOf(db: D1Database, name: string, identity: RepoIdentity): Promise<{ status: RequestStatus; project: ProjectRecord | null }> {
  const shown: ProjectRecord[] = [];
  for (const project of await matchingProjects(db, name, identity)) {
    if (await hasPage(db, project)) shown.push(project);
  }
  const approved = shown.find((project) => project.status === 'approved');
  if (approved) return { status: 'listed', project: approved };
  const paused = shown.find((project) => project.status === 'paused');
  if (paused) return { status: 'paused', project: paused };
  return { status: 'not_listed', project: null };
}

function answerOf(repo: string, status: RequestStatus, requested: boolean, project: ProjectRecord | null, origin: string): RequestAnswer {
  return {
    repo,
    status,
    requested,
    ...(project === null ? {} : { projectUrl: `${origin}/${project.repo}` }),
    message: REQUEST_STATUS_WORDS[status],
  };
}

function hhmm(time: number): string {
  return new Date(time).toISOString().slice(11, 16);
}

/**
 * Records, or with `withdraw` takes back, the caller's request for a repo.
 * `origin` is the site's, whose project links name a repo. Returns the
 * answer, or a refusal: `invalid_input` for a repo it can't read as one,
 * `donor_blocked`, `repo_not_eligible`, or `rate_limited`. A GitHub error
 * goes on up, as for the other donor tools.
 */
export async function requestRepo(
  db: D1Database,
  caller: Caller,
  input: RequestInput,
  origin: string,
  now: number,
): Promise<RequestAnswer | Refusal> {
  const asked = repoFromRequest(input.repo, [gitHubUrls().web, 'https://github.com', origin]);
  if (asked === null) {
    return refusal('invalid_input', `Name a repo as owner/repo, a GitHub repo link, or a ${productName} project link.`);
  }
  if ((await getBlock(db, caller.githubId)) !== null) {
    const login = (await getPerson(db, caller.githubId))?.login ?? caller.login;
    return refusal('donor_blocked', `A ${productName} admin blocked @${login}, so ${productName} takes no requests from them.`);
  }
  const found = await readRepo((await caller.gitHubToken()) ?? '', asked);
  const identity = found === null ? null : identityOf(found);
  if (found !== null && identity === null) throw new Error(`GitHub described ${asked} with no repo ID.`);

  if (input.withdraw === true) {
    // A repo GitHub no longer shows has no ID to find the request by, so it
    // is found by the name GitHub gave when the person asked.
    if (found === null || identity === null) {
      const live = await getLiveRequestByName(db, caller.githubId, asked);
      if (live !== null) await withdrawRequest(db, live.id, now);
      return answerOf(live?.repo ?? asked, 'not_listed', false, null, origin);
    }
    const live = await getLiveRequest(db, caller.githubId, identity.id);
    if (live !== null) await withdrawRequest(db, live.id, now);
    const { status, project } = await statusOf(db, found.full_name, identity);
    return answerOf(found.full_name, status, false, project, origin);
  }

  if (found === null || identity === null) {
    return refusal('repo_not_eligible', `GitHub shows no public repo ${asked}, so agents can't work on it.`);
  }
  const why = whyNotRequestable(found);
  if (why !== null) return refusal('repo_not_eligible', why);

  const name = found.full_name;
  const { status, project } = await statusOf(db, name, identity);
  // A repo that has a page records no request. It answers with its page.
  if (status !== 'not_listed') {
    const live = await getLiveRequest(db, caller.githubId, identity.id);
    return answerOf(name, status, live !== null, project, origin);
  }
  // A repo with no page records one, whatever the reason, so every unlisted
  // repo answers the same way.
  const added = await addRequest(db, { repoId: identity.id, repo: name, githubId: caller.githubId }, now);
  if ('limit' in added) {
    return added.limit === 'day'
      ? refusal(
          'rate_limited',
          `You've sent ${String(MAX_REQUESTS_PER_DAY)} requests today. The next one can go in at ${hhmm(added.nextAt)} UTC.`,
        )
      : refusal(
          'rate_limited',
          `You have ${String(MAX_LIVE_REQUESTS)} live requests, the most one person can have. The next one can go in once you withdraw one.`,
        );
  }
  return answerOf(name, status, true, null, origin);
}
