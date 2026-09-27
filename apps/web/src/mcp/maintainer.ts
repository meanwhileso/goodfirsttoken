import {
  invalidSettings,
  toolRefusal,
  toolResult,
  updateProjectSettings,
  type ProjectRecord,
  type ProjectSettings,
  type ProjectStatus,
  type Refusal,
  type RefusalCode,
  type ToolInput,
  type ToolRefusal,
  type ToolResult,
} from '@goodfirsttoken/core';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { env } from 'cloudflare:workers';
import { PermissionRefused, requirePermission, type Caller, type ManagedRepo } from '../auth/permissions';
import { adminGithubIds } from '../auth/settings';
import {
  changeSettings,
  countProjectPrs,
  countWorkingClaims,
  createProject,
  getProject,
  listIssues,
  setProjectStatusFrom,
  statusHistory,
  takeOverListing,
} from '../db';
import { GitHubError } from '../github';
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

// The maintainer's tools: register_project, update_project, project_status,
// and pause_project. Each one first asks GitHub, with the caller's own token,
// whether they are an admin or maintainer of the repo, through
// requirePermission. The rules are in docs/how-it-works.md, under
// Registering a project and Managing a project.

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

type IssueRepoCheck = { ok: true; issueRepo: string | null } | { ok: false; answer: Answer };

/**
 * Checks where a project's tagged issues will live. Issues in another repo
 * become work for agents under this project's settings, so the caller must
 * manage that repo too, asked of GitHub with their own token, and it must be
 * public and not archived. The issue repo as GitHub names it, or null when
 * the issues live in the code repo.
 */
async function checkIssueRepo(caller: Caller, repo: string, issueRepo: string | null): Promise<IssueRepoCheck> {
  if (issueRepo === null || issueRepo.toLowerCase() === repo.toLowerCase()) return { ok: true, issueRepo: null };
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
  return { ok: true, issueRepo: named.toLowerCase() === repo.toLowerCase() ? null : named };
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
  const facts = repoFacts(await requirePermission(caller, 'manage_project', { repo: input.repo }));
  const token = await tokenOf(caller);
  const problem = whyNotEligible(facts);
  if (problem !== null) return refuse('repo_not_eligible', problem);
  const repo = facts.fullName;

  const existing = await getProject(env.DB, repo);
  if (existing?.source === 'registered') return alreadyRegistered(existing);

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
  const created = await labelsFor(token, place.issueRepo ?? repo, settings.tags, 'register_project');
  if (!Array.isArray(created)) return answer(toolRefusal(created));

  for (let attempt = 0; attempt < REGISTER_ATTEMPTS; attempt++) {
    const current = attempt === 0 ? existing : await getProject(env.DB, repo);
    if (current?.source === 'registered') return alreadyRegistered(current);
    if (current === null) {
      const project = await createProject(
        env.DB,
        { repo, status: 'pending', source: 'registered', policy: null, settings, addedBy: caller.githubId },
        now,
      );
      if (project !== null) return registered(project, created);
    } else {
      const takeover = await takeOverListing(env.DB, current.repo, settings, caller.githubId, now);
      if (takeover !== null) return registered(takeover.project, created);
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

  const change = await changeSettings(env.DB, project.repo, patch, caller.githubId, now);
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

export async function projectStatus(caller: Caller, input: ToolInput<'project_status'>, now: number): Promise<Answer> {
  await requirePermission(caller, 'manage_project', { repo: input.repo });
  const project = await getProject(env.DB, input.repo);
  if (project === null) return notAProject(input.repo);
  const [issues, working, prs] = await Promise.all([
    listIssues(env.DB, project.repo),
    countWorkingClaims(env.DB, project.repo, now),
    countProjectPrs(env.DB, project.repo),
  ]);
  return answer(
    toolResult('project_status', {
      repo: project.repo,
      status: project.status,
      source: project.source,
      statusReason: project.statusReason,
      settings: project.settings,
      counts: {
        taggedIssues: issues.filter((issue) => isTagged(issue.labels, project.settings)).length,
        working,
        openPrs: prs.open,
        merged: prs.merged,
      },
    }),
  );
}

/** Who can lift the project's pause, or null when it isn't paused. */
function resumableBy(project: ProjectRecord): 'maintainers' | 'admins' | null {
  if (project.status !== 'paused') return null;
  const by = project.statusChangedBy;
  return by === null || adminGithubIds().has(by) ? 'admins' : 'maintainers';
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
      // The status before this pause, from the history, newest first.
      const before = (await statusHistory(env.DB, project.repo)).find((c) => c.status !== 'paused');
      change = { status: before?.status ?? 'pending', reason: before?.reason ?? null };
    }
    const updated = await setProjectStatusFrom(env.DB, project, { ...change, changedBy: caller.githubId }, now);
    if (updated !== null) return pauseAnswer(updated, true);
  }
  throw new Error(`${input.repo} kept changing status while it was paused or resumed.`);
}
