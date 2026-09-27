import {
  invalidSettings,
  projectSettingsSchema,
  validate,
  type CrawlCandidate,
  type Policy,
  type ProjectRecord,
  type ProjectSettings,
  type ProjectStatus,
  type Refusal,
  type RefusalCode,
  type ToolInput,
  type ToolName,
  type ToolOutputInput,
} from '@goodfirsttoken/core';
import { env } from 'cloudflare:workers';
import { requirePermission, type Caller } from '../auth/permissions';
import {
  addToDoNotList,
  blockDonor,
  createProject,
  decideCandidate,
  findPersonByLogin,
  getCandidate,
  getDoNotListEntry,
  getPendingProject,
  getPerson,
  getProject,
  getWaitingCandidate,
  listCandidates,
  listPendingProjects,
  relistFromPolicy,
  removeFromDoNotList,
  setProjectStatusFrom,
  statusHistory,
  unblockDonor,
} from '../db';
import { GitHubError } from '../github';
import { readRepo, readStanding, repoFacts, whyNotEligible, whyNotIssueRepo, type Standing } from '../projects/repo';
import { resumableBy, statusBeforePause } from '../projects/status';

// What an admin does, for the admin's MCP tools (src/mcp/admin.ts) and the
// admin pages (src/admin/page.ts) alike. Every action first checks the
// caller's permission with requirePermission, before it reads or writes
// anything. The rules are in docs/how-it-works.md, under The admin queue.

/** What an action gives back: the tool's output, or a refusal. */
export type Outcome<N extends ToolName> = { ok: true; value: ToolOutputInput<N> } | { ok: false; refusal: Refusal };

function refuse(code: RefusalCode, message: string): { ok: false; refusal: Refusal } {
  return { ok: false, refusal: { code, message } };
}

/** The reason a project removed at its maintainers' request is rejected with. Its maintainers see it. */
export const REMOVED_REASON = "Removed at its maintainers' request.";

/** How many times a status change is decided again when the status changed while it ran. */
const STATUS_ATTEMPTS = 5;

/** A registration's queue ID names the status change that put it in the queue. */
const REGISTRATION_ID = /^reg_([1-9][0-9]{0,15})$/;

function registrationId(changeId: number): string {
  return `reg_${String(changeId)}`;
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

type QueueItem = ToolOutputInput<'admin_queue'>['items'][number];

function factsOf(standing: Standing | null): QueueItem['facts'] {
  return (
    standing && {
      stars: standing.stars,
      createdAt: iso(standing.createdAt),
      pushedAt: iso(standing.pushedAt),
      ownerCreatedAt: iso(standing.ownerCreatedAt),
    }
  );
}

/**
 * The repo's facts from GitHub, read with the admin's own token. Null when
 * there is no token, or GitHub shows no public repo by that name, or GitHub
 * fails. A 401 goes on up, since it means GitHub stopped taking the token.
 */
async function standingOf(token: string | null, repo: string): Promise<Standing | null> {
  if (token === null) return null;
  try {
    return (await readStanding(token, repo))?.standing ?? null;
  } catch (error) {
    if (error instanceof GitHubError && error.status === 401) throw error;
    console.warn(`GitHub didn't give the facts of ${repo} for the admin queue.`, error);
    return null;
  }
}

async function registrationItem(token: string | null, project: ProjectRecord, changeId: number): Promise<QueueItem> {
  const [maintainer, standing, doNotList] = await Promise.all([
    getPerson(env.DB, project.addedBy),
    standingOf(token, project.repo),
    getDoNotListEntry(env.DB, project.repo),
  ]);
  if (maintainer === null) throw new Error(`${project.repo} was added by someone who isn't recorded.`);
  return {
    id: registrationId(changeId),
    kind: 'registration',
    repo: project.repo,
    requestedBy: maintainer.login,
    requestedAt: iso(project.statusChangedAt),
    facts: factsOf(standing),
    settings: project.settings,
    policy: project.policy,
    suggestedTags: [],
    onDoNotList: doNotList !== null,
  };
}

async function candidateItem(candidate: CrawlCandidate): Promise<QueueItem> {
  const doNotList = await getDoNotListEntry(env.DB, candidate.repo);
  return {
    id: candidate.id,
    kind: 'candidate',
    repo: candidate.repo,
    requestedBy: null,
    requestedAt: iso(candidate.foundAt),
    facts: factsOf(candidate.facts),
    settings: candidate.settings,
    policy: candidate.policy,
    suggestedTags: candidate.suggestedTags,
    onDoNotList: doNotList !== null,
  };
}

/**
 * The admin queue: maintainers' registrations waiting for an admin, and the
 * crawler's finds, the one that has waited longest first. A registration's
 * facts come from GitHub now, read with the admin's own token. A crawler
 * find's are the ones the crawler read.
 */
export async function adminQueue(caller: Caller, input: ToolInput<'admin_queue'>): Promise<Outcome<'admin_queue'>> {
  await requirePermission(caller, 'review_projects');
  const token = await caller.gitHubToken();
  const [pending, candidates] = await Promise.all([
    input.kind === 'candidate' ? [] : listPendingProjects(env.DB),
    input.kind === 'registration' ? [] : listCandidates(env.DB, 'waiting'),
  ]);
  const items = await Promise.all([
    ...pending.map(({ project, changeId }) => registrationItem(token, project, changeId)),
    ...candidates.map(candidateItem),
  ]);
  items.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt) || a.repo.localeCompare(b.repo));
  return { ok: true, value: { items } };
}

/** Settings left out of a patch, and sent as undefined, keep the value they had. */
function definedEntries(patch: Record<string, unknown> | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch ?? {}).filter(([, value]) => value !== undefined));
}

/**
 * Lists a repo from its written policy, or lists it again when it is already
 * listed that way, after checking it on GitHub with the admin's own token:
 * it has to be public, not archived, and take pull requests from anyone.
 * Its issue repo, when it has one of its own, has to be public and not
 * archived. A repo on the do-not-list, or one its maintainers registered, is
 * refused. The caller has checked `list_from_policy`.
 */
async function listFromPolicy(
  caller: Caller,
  repo: string,
  policy: Policy,
  settings: ProjectSettings,
  now: number,
): Promise<Outcome<'admin_add_project'>> {
  if ((await getDoNotListEntry(env.DB, repo)) !== null) {
    return refuse(
      'repo_not_eligible',
      `${repo} is on the do-not-list, because its maintainers asked to be removed. Only they can list it again, by registering it.`,
    );
  }
  const token = await caller.gitHubToken();
  if (token === null) {
    return refuse('repo_not_eligible', `Good First Token holds no GitHub token for you, so it can't check ${repo}. Sign in again.`);
  }
  const found = await readRepo(token, repo);
  if (found === null) return refuse('repo_not_eligible', `GitHub shows no public repo named ${repo}. Only a public repo can be listed.`);
  const problem = whyNotEligible(repoFacts(found), 'list');
  if (problem !== null) return refuse('repo_not_eligible', problem);
  const name = found.full_name;

  let issueRepo: string | null = null;
  if (settings.issueRepo !== null && settings.issueRepo.toLowerCase() !== name.toLowerCase()) {
    const issues = await readRepo(token, settings.issueRepo);
    if (issues === null) {
      return refuse('repo_not_eligible', `GitHub shows no public repo named ${settings.issueRepo} to keep the issues in.`);
    }
    const notIssueRepo = whyNotIssueRepo(repoFacts(issues));
    if (notIssueRepo !== null) return refuse('repo_not_eligible', notIssueRepo);
    issueRepo = issues.full_name.toLowerCase() === name.toLowerCase() ? null : issues.full_name;
  }
  const listing = { policy, settings: { ...settings, issueRepo } };

  for (let attempt = 0; attempt < STATUS_ATTEMPTS; attempt++) {
    const existing = await getProject(env.DB, name);
    if (existing?.source === 'registered') {
      return refuse(
        'already_registered',
        `${existing.repo} is registered by its maintainers, and is ${existing.status}. Their settings stay.`,
      );
    }
    if (existing !== null) {
      const relisted = await relistFromPolicy(env.DB, existing.repo, listing, caller.githubId, now);
      if (relisted !== null) {
        const { project } = relisted;
        return { ok: true, value: { repo: project.repo, status: project.status, source: project.source, updated: true } };
      }
    } else {
      const project = await createProject(
        env.DB,
        { repo: name, status: 'approved', source: 'policy', ...listing, addedBy: caller.githubId },
        now,
      );
      if (project !== null) {
        return { ok: true, value: { repo: project.repo, status: project.status, source: project.source, updated: false } };
      }
    }
  }
  throw new Error(`${name} kept changing while it was listed.`);
}

/** Lists a project from its written policy, with the quote, its link, the tier, the settings, and its tags. */
export async function adminAddProject(
  caller: Caller,
  input: ToolInput<'admin_add_project'>,
  now: number,
): Promise<Outcome<'admin_add_project'>> {
  await requirePermission(caller, 'list_from_policy');
  return listFromPolicy(caller, input.repo, input.policy, input.settings, now);
}

function nothingWaits(id: string): { ok: false; refusal: Refusal } {
  return refuse(
    'not_found',
    `Nothing waits in the admin queue with the id ${id}. It may have been decided or changed since you read the queue. Read it again with admin_queue.`,
  );
}

async function decideRegistration(
  caller: Caller,
  input: ToolInput<'admin_decide'>,
  changeId: number,
  now: number,
): Promise<Outcome<'admin_decide'>> {
  if (input.tier !== undefined || input.settings !== undefined) {
    return refuse(
      'invalid_settings',
      'A registration keeps the settings its maintainer chose. Approve or reject it with no tier and no settings.',
    );
  }
  const change: { status: ProjectStatus; reason: string | null } =
    input.decision === 'approve' ? { status: 'approved', reason: null } : { status: 'rejected', reason: input.reason ?? null };
  for (let attempt = 0; attempt < STATUS_ATTEMPTS; attempt++) {
    const pending = await getPendingProject(env.DB, changeId);
    if (pending === null) return nothingWaits(input.id);
    const decided = await setProjectStatusFrom(env.DB, pending.project, { ...change, changedBy: caller.githubId }, now);
    if (decided === null) continue;
    // Its maintainer registered it, so a request to be removed no longer holds.
    if (decided.status === 'approved' && decided.source === 'registered') await removeFromDoNotList(env.DB, decided.repo);
    return { ok: true, value: { repo: decided.repo, kind: 'registration', status: decided.status } };
  }
  throw new Error(`${input.id} kept changing while it was decided.`);
}

async function decideCandidateItem(
  caller: Caller,
  input: ToolInput<'admin_decide'>,
  now: number,
): Promise<Outcome<'admin_decide'>> {
  const candidate = await getCandidate(env.DB, input.id);
  if (candidate?.status !== 'waiting') return nothingWaits(input.id);
  if (input.decision === 'reject') {
    const decided = await decideCandidate(
      env.DB,
      candidate.id,
      { status: 'rejected', decidedBy: caller.githubId, reason: input.reason ?? null },
      now,
    );
    if (decided === null) return nothingWaits(input.id);
    return { ok: true, value: { repo: decided.repo, kind: 'candidate', status: 'rejected' } };
  }
  await requirePermission(caller, 'list_from_policy');
  const settings = validate(projectSettingsSchema, { ...candidate.settings, ...definedEntries(input.settings) }, 'settings');
  if (!settings.ok) return { ok: false, refusal: invalidSettings(settings.problems) };
  const policy = { ...candidate.policy, tier: input.tier ?? candidate.policy.tier };
  const listed = await listFromPolicy(caller, candidate.repo, policy, settings.value, now);
  if (!listed.ok) return listed;
  await decideCandidate(env.DB, candidate.id, { status: 'approved', decidedBy: caller.githubId, reason: null }, now);
  return { ok: true, value: { repo: listed.value.repo, kind: 'candidate', status: listed.value.status } };
}

/**
 * Approves or rejects what waits in the queue. A registration is approved or
 * rejected with the settings its maintainer chose, and the reason for a
 * rejection is theirs to read with project_status. Approving a crawler find
 * lists it from its policy, with the tier and settings the admin confirmed.
 */
export async function adminDecide(
  caller: Caller,
  input: ToolInput<'admin_decide'>,
  now: number,
): Promise<Outcome<'admin_decide'>> {
  await requirePermission(caller, 'review_projects');
  if (input.decision === 'reject' && input.reason === undefined) {
    return refuse('invalid_input', 'A rejection needs a reason.');
  }
  const registration = REGISTRATION_ID.exec(input.id);
  if (registration) return decideRegistration(caller, input, Number(registration[1]), now);
  return decideCandidateItem(caller, input, now);
}

/** Blocks a donor, found by their login now, or lifts their block. */
export async function adminBlockDonor(
  caller: Caller,
  input: ToolInput<'admin_block_donor'>,
  now: number,
): Promise<Outcome<'admin_block_donor'>> {
  await requirePermission(caller, 'block_donors');
  const person = await findPersonByLogin(env.DB, input.login);
  if (person === null) return refuse('not_found', `No one has signed in to Good First Token as @${input.login}.`);
  if (input.blocked) {
    await blockDonor(env.DB, { githubId: person.githubId, reason: input.reason ?? null, blockedBy: caller.githubId }, now);
  } else {
    await unblockDonor(env.DB, person.githubId);
  }
  return { ok: true, value: { login: person.login, blocked: input.blocked } };
}

function notOpen(project: ProjectRecord): { ok: false; refusal: Refusal } {
  return refuse(
    'project_not_open',
    `${project.repo} is ${project.status}, so agents can't claim its issues. Only an approved project can be paused.`,
  );
}

/**
 * Pauses an approved project, or resumes a paused one, whoever paused it. A
 * pause by an admin stays until an admin lifts it. An admin pausing a project
 * its maintainers paused takes the pause over, even with the same reason, so
 * they can't lift it. Each change lands only on the status it was decided
 * on, and is decided again when someone else changed the status first.
 */
export async function adminPauseProject(
  caller: Caller,
  input: ToolInput<'admin_pause_project'>,
  now: number,
): Promise<Outcome<'admin_pause_project'>> {
  await requirePermission(caller, 'pause_any_project');
  for (let attempt = 0; attempt < STATUS_ATTEMPTS; attempt++) {
    const project = await getProject(env.DB, input.repo);
    if (project === null) return refuse('not_found', `${input.repo} is not a project on Good First Token.`);
    const unchanged = { ok: true as const, value: { repo: project.repo, status: project.status, changed: false } };
    let change: { status: ProjectStatus; reason: string | null };
    if (input.paused) {
      const reason = input.reason ?? null;
      if (project.status === 'paused') {
        if (resumableBy(project) === 'admins' && project.statusReason === reason) return unchanged;
      } else if (project.status !== 'approved') {
        return notOpen(project);
      }
      change = { status: 'paused', reason };
    } else {
      if (project.status !== 'paused') return unchanged;
      change = statusBeforePause(await statusHistory(env.DB, project.repo));
    }
    const updated = await setProjectStatusFrom(env.DB, project, { ...change, changedBy: caller.githubId }, now);
    if (updated !== null) return { ok: true, value: { repo: updated.repo, status: updated.status, changed: true } };
  }
  throw new Error(`${input.repo} kept changing status while an admin paused or resumed it.`);
}

/**
 * Removes a repo at its maintainers' request. It goes on the do-not-list
 * first, so nothing lists it while the rest happens. Its project is
 * rejected, with a reason its maintainers see, and a crawler find for it
 * waiting in the queue is rejected too.
 */
export async function adminRemoveProject(
  caller: Caller,
  input: ToolInput<'admin_remove_project'>,
  now: number,
): Promise<Outcome<'admin_remove_project'>> {
  await requirePermission(caller, 'review_projects');
  const known = await getProject(env.DB, input.repo);
  const repo = known?.repo ?? input.repo;
  await addToDoNotList(env.DB, { repo, reason: input.note ?? null, addedBy: caller.githubId }, now);
  const waiting = await getWaitingCandidate(env.DB, repo);
  if (waiting !== null) {
    await decideCandidate(env.DB, waiting.id, { status: 'rejected', decidedBy: caller.githubId, reason: REMOVED_REASON }, now);
  }
  for (let attempt = 0; attempt < STATUS_ATTEMPTS; attempt++) {
    const project = await getProject(env.DB, repo);
    if (project === null) return { ok: true, value: { repo, status: null } };
    if (project.status === 'rejected' && project.statusReason === REMOVED_REASON) {
      return { ok: true, value: { repo: project.repo, status: project.status } };
    }
    const change = { status: 'rejected' as const, reason: REMOVED_REASON, changedBy: caller.githubId };
    const updated = await setProjectStatusFrom(env.DB, project, change, now);
    if (updated !== null) return { ok: true, value: { repo: updated.repo, status: updated.status } };
  }
  throw new Error(`${repo} kept changing status while it was removed.`);
}
