import {
  invalidSettings,
  toolRefusal,
  toolResult,
  updateProjectSettings,
  type ProjectRecord,
  type ProjectSettings,
  type Refusal,
  type RefusalCode,
  type ToolInput,
  type ToolRefusal,
  type ToolResult,
} from '@goodfirsttoken/core';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { env } from 'cloudflare:workers';
import { PermissionRefused, requirePermission, type Caller } from '../auth/permissions';
import { adminGithubIds } from '../auth/settings';
import {
  changeSettings,
  countProjectPrs,
  countWorkingClaims,
  createProject,
  getProject,
  listIssues,
  setProjectStatus,
  statusHistory,
  takeOverListing,
} from '../db';
import { GitHubError } from '../github';
import { proposeSettings } from '../projects/proposal';
import { createOurLabel, OUR_LABEL, readDocs, readLabels, readRepo, whyNotEligible } from '../projects/repo';

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
  await requirePermission(caller, 'manage_project', { repo: input.repo });
  const token = await tokenOf(caller);
  const facts = await readRepo(token, input.repo);
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

  const settings: ProjectSettings = input.settings;
  const created = await labelsFor(token, repo, settings.tags, 'register_project');
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
  // Checked before GitHub is asked to make a label, so bad settings change nothing there.
  const checked = updateProjectSettings(project.settings, input.settings);
  if (!checked.ok) return answer(toolRefusal(invalidSettings(checked.problems)));
  const created = await labelsFor(await tokenOf(caller), project.repo, input.settings.tags, 'update_project');
  if (!Array.isArray(created)) return answer(toolRefusal(created));

  const change = await changeSettings(env.DB, project.repo, input.settings, caller.githubId, now);
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

function paused(project: ProjectRecord): Answer {
  return answer(toolResult('pause_project', { repo: project.repo, status: project.status }));
}

/**
 * Pauses an approved project, or resumes a paused one. A resume goes back to
 * the status the project had before the pause, so it never approves a
 * project. A pause Good First Token or one of its admins made stays until an
 * admin lifts it.
 */
export async function pauseProject(caller: Caller, input: ToolInput<'pause_project'>, now: number): Promise<Answer> {
  await requirePermission(caller, 'manage_project', { repo: input.repo });
  const project = await getProject(env.DB, input.repo);
  if (project === null) return notAProject(input.repo);

  if (input.paused) {
    // Pausing again changes nothing, so a maintainer can't take over an admin's pause.
    if (project.status === 'paused') return paused(project);
    if (project.status !== 'approved') {
      return refuse(
        'project_not_open',
        `${project.repo} is ${project.status}, so agents can't claim its issues yet. Only an approved project can be paused.`,
      );
    }
    const updated = await setProjectStatus(
      env.DB,
      project.repo,
      { status: 'paused', reason: input.reason ?? null, changedBy: caller.githubId },
      now,
    );
    return updated === null ? notAProject(input.repo) : paused(updated);
  }

  if (project.status !== 'paused') return paused(project);
  const pausedBy = project.statusChangedBy;
  if (pausedBy === null || adminGithubIds().has(pausedBy)) {
    try {
      await requirePermission(caller, 'pause_any_project');
    } catch (error) {
      if (!(error instanceof PermissionRefused)) throw error;
      const who = pausedBy === null ? 'Good First Token' : 'A Good First Token admin';
      return refuse(error.code, `${who} paused ${project.repo}. Only Good First Token's admins can resume it.`);
    }
  }
  // The status before this pause, from the history, newest first.
  const before = (await statusHistory(env.DB, project.repo)).find((change) => change.status !== 'paused');
  const updated = await setProjectStatus(
    env.DB,
    project.repo,
    { status: before?.status ?? 'pending', reason: before?.reason ?? null, changedBy: caller.githubId },
    now,
  );
  return updated === null ? notAProject(input.repo) : paused(updated);
}
