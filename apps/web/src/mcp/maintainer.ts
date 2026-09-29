import {
  invalidSettings,
  toolRefusal,
  toolResult,
  updateProjectSettings,
  type DelistedShowing,
  type ProjectRecord,
  type ProjectSettings,
  type ProjectStatus,
  type Refusal,
  type RemovalRequest,
  type RefusalCode,
  type ToolInput,
  type ToolRefusal,
  type ToolResult,
} from '@goodfirsttoken/core';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { env } from 'cloudflare:workers';
import { PermissionRefused, requirePermission, type Caller, type ManagedRepo } from '../auth/permissions';
import {
  askRemoval,
  changeSettings,
  closeRemoval,
  countProjectPrs,
  countWorkingClaims,
  createProject,
  dropWaitingPolicyChange,
  getDoNotListEntry,
  getIssueSync,
  getPerson,
  getProject,
  getWaitingRemoval,
  lastRemovalBy,
  listIssues,
  reopenRegistration,
  setProjectStatusFrom,
  statusHistory,
  takeOverListing,
} from '../db';
import { GitHubError } from '../github';
import { readDelisting } from '../project/shown';
import { proposeSettings } from '../projects/proposal';
import {
  createOurLabel,
  OUR_LABEL,
  readDocs,
  readLabels,
  repoFacts,
  whyNotEligible,
  whyNotIssueRepo,
} from '../projects/repo';
import { resumableBy, statusBeforePause } from '../projects/status';
import { refreshIssues } from '../sync/scheduled';

// The maintainer's tools: register_project, update_project, project_status,
// pause_project, and request_removal. Each one first asks GitHub, with the
// caller's own token, whether they are an admin or maintainer of the repo,
// through requirePermission. The rules are in docs/how-it-works.md, under
// Registering a project, Managing a project, and Asking to be removed.

/** A tool's answer, as the MCP SDK takes it. */
export type Answer = CallToolResult;

function answer(result: ToolResult<unknown> | ToolRefusal): Answer {
  return { ...result };
}

function refuse(code: RefusalCode, message: string): Answer {
  return answer(toolRefusal({ code, message }));
}

function notAProject(repo: string): Answer {
  return refuse('not_found', `${repo} is not a project on Good First Token. Register it with register_project.`);
}

/** The caller's GitHub token. requirePermission has checked there is one. */
async function tokenOf(caller: Caller): Promise<string> {
  return (await caller.gitHubToken()) ?? '';
}

function picksOurTag(tags: readonly string[] | undefined): boolean {
  return tags?.some((tag) => tag.toLowerCase() === OUR_LABEL.name) ?? false;
}

type IssueRepoCheck =
  | { ok: true; issueRepo: string | null; issueRepoId: number | undefined }
  | { ok: false; answer: Answer };

/**
 * Checks where a project's tagged issues will live. Issues in another repo
 * become work for agents under this project's settings, so the caller must
 * manage that repo too, asked of GitHub with their own token, and it must be
 * public and not archived. The issue repo as GitHub names it, or null when
 * the issues live in the code repo, with its GitHub ID from the same read.
 */
async function checkIssueRepo(caller: Caller, repo: string, issueRepo: string | null): Promise<IssueRepoCheck> {
  if (issueRepo === null || issueRepo.toLowerCase() === repo.toLowerCase()) {
    return { ok: true, issueRepo: null, issueRepoId: undefined };
  }
  let found: ManagedRepo;
  try {
    found = await requirePermission(caller, 'manage_project', { repo: issueRepo });
  } catch (error) {
    if (!(error instanceof PermissionRefused)) throw error;
    const message = `Only an admin or maintainer of ${issueRepo} on GitHub can keep this project's issues there.`;
    return { ok: false, answer: refuse(error.code, message) };
  }
  const problem = whyNotIssueRepo(repoFacts(found));
  if (problem !== null) return { ok: false, answer: refuse('repo_not_eligible', problem) };
  const named = found.full_name;
  if (named.toLowerCase() === repo.toLowerCase()) return { ok: true, issueRepo: null, issueRepoId: undefined };
  return { ok: true, issueRepo: named, issueRepoId: found.id };
}

/**
 * Creates the goodfirsttoken label with the caller's token when their tags
 * pick it and the repo lacks it. The labels it created, or the refusal when
 * GitHub wouldn't. A 401 goes on up, since it means the connection is gone.
 */
async function labelsFor(
  token: string,
  repo: string,
  tags: readonly string[] | undefined,
  tool: string,
): Promise<string[] | Refusal> {
  if (!picksOurTag(tags)) return [];
  try {
    return (await createOurLabel(token, repo)) ? [OUR_LABEL.name] : [];
  } catch (error) {
    if (!(error instanceof GitHubError) || error.status === 401) throw error;
    return {
      code: 'label_not_created',
      message: `GitHub refused to create the ${OUR_LABEL.name} label in ${repo} with your token (${String(error.status)}: ${error.message}). Nothing was saved. Create the label in the repo on GitHub, or pick another tag, then call ${tool} again.`,
    };
  }
}

function registered(project: ProjectRecord, createdLabels: string[]): Answer {
  return answer(
    toolResult('register_project', {
      repo: project.repo,
      saved: true,
      status: project.status,
      settings: project.settings,
      reasons: [],
      createdLabels,
    }),
  );
}

/**
 * Whether the repo is registered already: waiting for an admin, approved, or
 * paused. A rejected registration can be registered again.
 */
function registeredAlready(project: ProjectRecord): boolean {
  return project.source === 'registered' && project.status !== 'rejected';
}

function alreadyRegistered(project: ProjectRecord): Answer {
  return refuse(
    'already_registered',
    `${project.repo} is already registered, and is ${project.status}. See it with project_status, and change its settings with update_project.`,
  );
}

/** How many times a registration tries again when the repo became a project while it ran. */
const REGISTER_ATTEMPTS = 3;

export async function registerProject(
  caller: Caller,
  input: ToolInput<'register_project'>,
  now: number,
): Promise<Answer> {
  const found = await requirePermission(caller, 'manage_project', { repo: input.repo });
  const facts = repoFacts(found);
  const token = await tokenOf(caller);
  const problem = whyNotEligible(facts);
  if (problem !== null) return refuse('repo_not_eligible', problem);
  const repo = facts.fullName;

  const existing = await getProject(env.DB, repo);
  if (existing !== null && registeredAlready(existing)) return alreadyRegistered(existing);

  if (input.settings === undefined) {
    const [labels, docs] = await Promise.all([readLabels(token, repo), readDocs(token, repo)]);
    const { settings, reasons } = proposeSettings(labels, docs);
    return answer(
      toolResult('register_project', { repo, saved: false, status: null, settings, reasons, createdLabels: [] }),
    );
  }

  const place = await checkIssueRepo(caller, repo, input.settings.issueRepo);
  if (!place.ok) return place.answer;
  const settings: ProjectSettings = { ...input.settings, issueRepo: place.issueRepo };
  // GitHub's IDs for both repos, from the reads that checked them.
  const repoIds = { repo: found.id, issueRepo: place.issueRepoId ?? found.id };
  const created = await labelsFor(token, place.issueRepo ?? repo, settings.tags, 'register_project');
  if (!Array.isArray(created)) return answer(toolRefusal(created));

  for (let attempt = 0; attempt < REGISTER_ATTEMPTS; attempt++) {
    const current = attempt === 0 ? existing : await getProject(env.DB, repo);
    if (current !== null && registeredAlready(current)) return alreadyRegistered(current);
    if (current === null) {
      const project = await createProject(
        env.DB,
        { repo, status: 'pending', source: 'registered', policy: null, settings, addedBy: caller.githubId, repoIds },
        now,
      );
      if (project !== null) return registered(project, created);
    } else if (current.source === 'registered') {
      const project = await reopenRegistration(env.DB, current.repo, settings, caller.githubId, now, repoIds);
      if (project !== null) return registered(project, created);
    } else {
      const takeover = await takeOverListing(env.DB, current.repo, settings, caller.githubId, now, repoIds);
      if (takeover !== null) {
        // A policy change waiting for the listing has no listing left to list again from.
        await dropWaitingPolicyChange(env.DB, takeover.project.repo);
        return registered(takeover.project, created);
      }
    }
  }
  throw new Error(`${repo} kept changing while it was registered.`);
}

export async function updateProject(caller: Caller, input: ToolInput<'update_project'>, now: number): Promise<Answer> {
  await requirePermission(caller, 'manage_project', { repo: input.repo });
  const project = await getProject(env.DB, input.repo);
  if (project === null) return notAProject(input.repo);
  // Replacing a listing's settings takes it over, which register_project does.
  if (project.source === 'policy') {
    return refuse(
      'listed_from_policy',
      `${project.repo} is listed from its AI policy. Take it over with register_project and your settings, then change them with update_project.`,
    );
  }
  // Checked before GitHub is asked anything more, so bad settings change nothing there.
  const checked = updateProjectSettings(project.settings, input.settings);
  if (!checked.ok) return answer(toolRefusal(invalidSettings(checked.problems)));
  // Every change to a project whose issues live in another repo needs that
  // repo too, since its settings decide which of the repo's issues agents get.
  const place = await checkIssueRepo(caller, project.repo, checked.value.issueRepo);
  if (!place.ok) return place.answer;
  const patch =
    input.settings.issueRepo === undefined ? input.settings : { ...input.settings, issueRepo: place.issueRepo };
  // The label goes where the issues will live, when the change picks the tag or moves the issues.
  const moves = input.settings.tags !== undefined || input.settings.issueRepo !== undefined;
  const created = moves
    ? await labelsFor(await tokenOf(caller), place.issueRepo ?? project.repo, checked.value.tags, 'update_project')
    : [];
  if (!Array.isArray(created)) return answer(toolRefusal(created));

  const change = await changeSettings(env.DB, project.repo, patch, caller.githubId, now, place.issueRepoId);
  if (change === null) return notAProject(input.repo);
  if (!change.ok) return answer(toolRefusal(invalidSettings(change.problems)));
  return answer(
    toolResult('update_project', {
      repo: change.project.repo,
      status: change.project.status,
      settings: change.project.settings,
      changed: change.changed,
      createdLabels: created,
    }),
  );
}

/** Whether an issue's labels include one of the project's tags and none of its excluded tags. */
function isTagged(labels: readonly string[], settings: ProjectSettings): boolean {
  const has = (names: readonly string[]) =>
    labels.some((label) => names.some((name) => name.toLowerCase() === label.toLowerCase()));
  return has(settings.tags) && !has(settings.excludedTags);
}

/** What GitHub can show of a code repo that leaves it showing no one's role on the repo. */
const HIDDEN: readonly (DelistedShowing | null)[] = ['private', 'gone', 'blocked'];

/**
 * The sync's reason, when it delisted the project because GitHub showed its
 * code repo private, gone, or blocked, so GitHub shows no one their role on
 * it. The project's public page is gone, so saying so tells a caller only
 * what anyone can see. Null otherwise.
 */
async function hiddenCodeRepo(repo: string): Promise<string | null> {
  const project = await getProject(env.DB, repo);
  if (project === null) return null;
  const delisted = await readDelisting(env.DB, project);
  if (delisted?.repo?.toLowerCase() !== project.repo.toLowerCase() || !HIDDEN.includes(delisted.showed)) return null;
  return delisted.reason;
}

/**
 * Answers with the project's status and activity. With `refresh`, it first
 * reads an approved project's tagged issues from GitHub with the service
 * token, at most once every 10 minutes for the project. Only the repo's
 * admins and maintainers get this far, so no one else can spend the token.
 * A caller refused because GitHub no longer shows the code repo hears that
 * the sync delisted the project, and why.
 */
export async function projectStatus(caller: Caller, input: ToolInput<'project_status'>, now: number): Promise<Answer> {
  try {
    await requirePermission(caller, 'manage_project', { repo: input.repo });
  } catch (error) {
    if (!(error instanceof PermissionRefused) || error.code !== 'not_maintainer') throw error;
    const reason = await hiddenCodeRepo(input.repo);
    if (reason === null) throw error;
    return refuse(error.code, `${error.message} Good First Token delisted this project: ${reason}`);
  }
  let project = await getProject(env.DB, input.repo);
  if (project === null) return notAProject(input.repo);
  let refresh: Awaited<ReturnType<typeof refreshIssues>> | null = null;
  if (input.refresh) {
    refresh = await refreshIssues(env, project);
    // A refresh can pause the project.
    project = (await getProject(env.DB, project.repo)) ?? project;
  }
  const [issues, working, prs, sync] = await Promise.all([
    listIssues(env.DB, project.repo),
    countWorkingClaims(env.DB, project.repo, now),
    countProjectPrs(env.DB, project.repo),
    getIssueSync(env.DB, project.repo),
  ]);
  // The mark as it stands after any refresh, which reads the repos first.
  const delisted = await readDelisting(env.DB, project, sync);
  const { settings } = project;
  return answer(
    toolResult('project_status', {
      repo: project.repo,
      status: project.status,
      source: project.source,
      statusReason: project.statusReason,
      settings,
      counts: {
        // Nothing cached from a delisted project's repos shows, its count included.
        taggedIssues: delisted === null ? issues.filter((issue) => isTagged(issue.labels, settings)).length : null,
        working,
        openPrs: prs.open,
        merged: prs.merged,
      },
      issuesReadAt: sync?.readAt == null ? null : new Date(sync.readAt).toISOString(),
      refresh,
      delisted,
      resumableBy: resumableBy(project),
    }),
  );
}

function pauseAnswer(project: ProjectRecord, changed: boolean): Answer {
  return answer(
    toolResult('pause_project', { repo: project.repo, status: project.status, changed, resumableBy: resumableBy(project) }),
  );
}

function notOpen(project: ProjectRecord): Answer {
  const why =
    project.status === 'rejected'
      ? `${project.repo} was rejected, so agents can't claim its issues.`
      : `${project.repo} is pending, so agents can't claim its issues yet.`;
  return refuse('project_not_open', `${why} Only an approved project can be paused.`);
}

/** How many times a pause or resume is decided again when the status changed while it ran. */
const STATUS_ATTEMPTS = 5;

/**
 * Pauses an approved project, or resumes a paused one. A resume goes back to
 * the status the project had before the pause, so it never approves a
 * project. A pause Good First Token or one of its admins made stays until an
 * admin lifts it. Each change lands only on the status it was decided on, so
 * an admin's change that lands meanwhile is never overwritten. The call then
 * decides again on the new status.
 */
export async function pauseProject(caller: Caller, input: ToolInput<'pause_project'>, now: number): Promise<Answer> {
  await requirePermission(caller, 'manage_project', { repo: input.repo });
  for (let attempt = 0; attempt < STATUS_ATTEMPTS; attempt++) {
    const project = await getProject(env.DB, input.repo);
    if (project === null) return notAProject(input.repo);
    let change: { status: ProjectStatus; reason: string | null };
    if (input.paused) {
      // Pausing again changes nothing, so a maintainer never takes over someone else's pause.
      if (project.status === 'paused') return pauseAnswer(project, false);
      if (project.status !== 'approved') return notOpen(project);
      change = { status: 'paused', reason: input.reason ?? null };
    } else {
      if (project.status !== 'paused') return pauseAnswer(project, false);
      if (resumableBy(project) === 'admins') {
        try {
          await requirePermission(caller, 'pause_any_project');
        } catch (error) {
          if (!(error instanceof PermissionRefused)) throw error;
          const who = project.statusChangedBy === null ? 'Good First Token' : 'A Good First Token admin';
          return refuse(error.code, `${who} paused ${project.repo}. Only Good First Token's admins can resume it.`);
        }
      }
      // A resume makes the issue repo's issues claimable again, so it needs
      // that repo too. A pause only stops work, so it needs the code repo alone.
      const place = await checkIssueRepo(caller, project.repo, project.settings.issueRepo);
      if (!place.ok) return place.answer;
      change = statusBeforePause(await statusHistory(env.DB, project.repo));
    }
    const updated = await setProjectStatusFrom(env.DB, project, { ...change, changedBy: caller.githubId }, now);
    if (updated !== null) return pauseAnswer(updated, true);
  }
  throw new Error(`${input.repo} kept changing status while it was paused or resumed.`);
}

/** Who asked for a request, by their login now. */
async function askerOf(request: RemovalRequest): Promise<string> {
  const person = await getPerson(env.DB, request.requestedBy);
  if (person === null) throw new Error(`${request.repo}'s request to be removed names someone who isn't recorded.`);
  return person.login;
}

/** Who withdrew a request, when it was someone other than the one who asked, and when. */
async function withdrawnByAnother(request: RemovalRequest | null): Promise<{ by: string; at: string } | null> {
  if (request?.status !== 'withdrawn' || request.closedBy === null || request.closedAt === null) return null;
  if (request.closedBy === request.requestedBy) return null;
  const withdrawer = await getPerson(env.DB, request.closedBy);
  if (withdrawer === null) throw new Error(`${request.repo}'s request to be removed names someone who isn't recorded.`);
  return { by: withdrawer.login, at: new Date(request.closedAt).toISOString() };
}

function removalAnswer(
  repo: string,
  request: RemovalRequest | null,
  asker: string | null,
  state: {
    waiting: boolean;
    onDoNotList: boolean;
    changed: boolean;
    lastWithdrawn: { by: string; at: string } | null;
  },
): Answer {
  return answer(
    toolResult('request_removal', {
      repo,
      ...state,
      requestedBy: asker,
      requestedAt: request === null ? null : new Date(request.requestedAt).toISOString(),
    }),
  );
}

/**
 * Asks Good First Token's admins to remove a repo, or withdraws the request
 * that waits for it. The caller must be an admin or maintainer of it on
 * GitHub, asked with their own token, for either, and nothing else about the
 * repo counts: a project in any status, a listing made from its policy, a
 * repo whose pull requests are limited to collaborators or that is
 * archived, and a repo that isn't on Good First Token at all can each be
 * asked for. The request waits in the admin queue until an admin removes the
 * repo, or a maintainer of it withdraws it. It pauses nothing. A repo on the
 * do-not-list was removed already, so asking makes no request, unless a
 * registration of it waits, which an admin's approval would take off the
 * list.
 */
export async function requestRemoval(
  caller: Caller,
  input: ToolInput<'request_removal'>,
  now: number,
): Promise<Answer> {
  const found = await requirePermission(caller, 'manage_project', { repo: input.repo });
  // A project keeps the name it was added with, so the request takes that
  // name, and the admin removes the project by it. Otherwise GitHub's.
  const project = await getProject(env.DB, input.repo);
  const repo = project?.repo ?? found.full_name;
  const onDoNotList = (await getDoNotListEntry(env.DB, repo)) !== null;
  // Someone else may have withdrawn the caller's last request for the repo.
  // Each call they make says so, until they make a new request, which is
  // then their last.
  const lastWithdrawn = await withdrawnByAnother(await lastRemovalBy(env.DB, repo, caller.githubId));

  if (input.withdraw) {
    const withdrawn = await closeRemoval(env.DB, repo, { status: 'withdrawn', by: caller.githubId }, now);
    const asker = withdrawn === null ? null : await askerOf(withdrawn);
    return removalAnswer(repo, withdrawn, asker, { waiting: false, onDoNotList, changed: withdrawn !== null, lastWithdrawn });
  }

  if (onDoNotList && project?.status !== 'pending') {
    const waiting = await getWaitingRemoval(env.DB, repo);
    const asker = waiting === null ? null : await askerOf(waiting);
    return removalAnswer(repo, waiting, asker, { waiting: waiting !== null, onDoNotList, changed: false, lastWithdrawn });
  }
  const reason = input.reason ?? '';
  const { request, created } = await askRemoval(env.DB, { repo, reason, requestedBy: caller.githubId }, now);
  const asker = created ? caller.login : await askerOf(request);
  return removalAnswer(request.repo, request, asker, { waiting: true, onDoNotList, changed: created, lastWithdrawn });
}
